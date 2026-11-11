/**
 * The scenarios of the sandbox end-to-end run. Each one drives the web app's
 * own NEAR client (src/lib/client/near.ts with the dev signers) against the
 * real contract and the real relayer. What happened is then read from the
 * chain by the harness's own raw RPC reader (chain.ts), not by the client
 * under test; the client's views are checked against that afterwards.
 *
 * Every write is checked three ways where it applies: what the client
 * returned, which account signed the transaction on chain (the relayer for a
 * gasless call, the user for a paid one), and the balances it moved, to the
 * base unit and the yoctoNEAR.
 *
 * Amounts: USDC has 6 decimals, sale tokens 18. Prices are USDC base units per
 * whole token. Expected clearing results come from @fairground/clearing, the
 * TypeScript reference the Rust clearing is tested against; the headline
 * numbers of each sale are also written out by hand next to their check.
 *
 * The chain's clock is moved with the sandbox's fast-forward, so bid windows,
 * reveal windows and the ten-minute settle timeout cost seconds, not minutes.
 */
import { bidSetHash, clear, commitmentHex, type Bid, type ClearingResult, type SaleParams } from "@fairground/clearing";
import { sealedBidLength } from "@fairground/relayer-client";
import { getClient } from "../../src/lib/client";
import { BID_REJECT_MESSAGES } from "../../src/lib/client/errors";
import type { NearClient } from "../../src/lib/client/near";
import { invalidBidPenalty } from "../../src/lib/client/rules";
import { parseConfig } from "../../src/lib/config";
import { fromHex, newSaleKeypair, randomHex, sealBid } from "../../src/lib/crypto";
import { createDevSigner, devSigners } from "../../src/lib/near/dev-signer";
import { browserSigners, staticSigners } from "../../src/lib/near/signers";
import type { BidView, FillView, ResultView, SaleView } from "../../src/lib/near/views";
import { ensureDeliverable } from "../../src/lib/oneclick";
import type { ClientNotice, PaidReason, RelayInfo, SaleConfig, SaleMeta } from "../../src/lib/types";
import { removeSandbox, sandboxExists, sleep, type Named } from "./chain";
import { sha256Hex } from "./outlayer";
import { portInUse, RELAYER_URL } from "./relayer";
import { show, type Checks, type Report } from "./report";
import { base58OfHex, BIDDERS, codeHashOf, START_USDC, USDC, type Person, type World } from "./world";

const NEAR = 10n ** 24n;
const TOKEN = 10n ** 18n;
const MS = 1_000_000n;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** OutLayer's compute deposit for a small request (contracts/fairground/src/costs.rs OUTLAYER_COMPUTE_DEPOSIT). */
const OUTLAYER_COMPUTE_DEPOSIT = 14_010_000_000_000_000_000_000n;
/** How far ahead of the chain clock a new sale's bid window starts. */
const START_LEAD_MS = 10_000;

/** A bid as its bidder means it. */
type Plan = { who: Person; deposit: bigint; maxPrice: bigint; maxSpend: bigint };

const nearText = (yocto: bigint) => {
  const sign = yocto < 0n ? "-" : "";
  const abs = yocto < 0n ? -yocto : yocto;
  return `${sign}${abs / NEAR}.${(abs % NEAR).toString().padStart(24, "0").slice(0, 6)} NEAR`;
};

type RawTx = { transaction: { signer_id: string; receiver_id: string; hash: string } };

/** The harness's shortcuts over the world. */
function tools(w: World) {
  const fg = w.fairground.id;
  const usdc = w.usdc.id;
  return {
    sale: (id: string) => w.chain.view<SaleView | null>(fg, "get_sale", { sale_id: id }),
    bids: (id: string) => w.chain.view<BidView[]>(fg, "get_bids", { sale_id: id, limit: 200 }),
    bid: (id: string, bidder: string) => w.chain.view<BidView | null>(fg, "get_bid", { sale_id: id, bidder }),
    result: (id: string) => w.chain.view<ResultView | null>(fg, "get_result", { sale_id: id }),
    fills: (id: string) => w.chain.view<FillView[]>(fg, "get_fills", { sale_id: id, limit: 200 }),
    usdcOf: (accountId: string) => w.chain.ft(usdc, accountId),
    tx: (hash: string, sender: string) => w.chain.rpc<RawTx>("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "EXECUTED_OPTIMISTIC" }),
    nowMs: async () => Number((await w.chain.nowNs()) / MS),
  };
}

/**
 * Runs a call that must be gasless for `signer` and checks it three ways:
 * what the client reports, what the chain recorded (the relayer signed a
 * transaction that carries the signer's delegate), and the signer's NEAR
 * balance, which must not move by one yoctoNEAR.
 */
async function gasless<T extends { relay?: RelayInfo }>(
  t: Checks,
  w: World,
  label: string,
  signer: Named,
  run: () => Promise<T>,
  /** NEAR the call itself pays the signer (the creator's reserve); the balance must then move by exactly that. */
  received = 0n,
): Promise<T> {
  // An account that paid for something earlier may still have a gas refund on its way: wait for it first.
  const near0 = received > 0n ? await w.chain.settledNear(signer.id) : await w.chain.nearOf(signer.id);
  const nonce0 = await w.chain.nonceOf(signer);
  const value = await run();
  const relay = value.relay;
  t.ok(
    `${label}: the client reports a gasless call`,
    relay?.paidBy === "relayer" && relay.fallbackReason === null && relay.status === "succeeded" && relay.simulated === false,
    show(relay),
  );
  if (relay?.txHash && TX_HASH.test(relay.txHash)) {
    const tx = await tools(w).tx(relay.txHash, w.relayerAccount.id);
    t.ok(
      `${label}: on chain the relayer signed it, carrying ${signer.id}'s delegate`,
      tx.transaction.signer_id === w.relayerAccount.id && tx.transaction.receiver_id === signer.id,
      show(tx.transaction),
    );
  } else {
    t.ok(`${label}: the client reports the transaction hash`, false, show(relay?.txHash));
  }
  const near1 = received > 0n ? await w.chain.settledNear(signer.id) : await w.chain.nearOf(signer.id);
  const nonce1 = await w.chain.nonceOf(signer);
  t.eq(
    received > 0n ? `${label}: ${signer.id}'s NEAR balance rose by exactly what the call paid it (no gas taken)` : `${label}: ${signer.id}'s NEAR balance moved by exactly 0`,
    near1 - near0,
    received,
  );
  t.ok(`${label}: ${signer.id}'s key nonce moved (it signed the delegate)`, nonce1 > nonce0, `${nonce0} -> ${nonce1}`);
  return value;
}

/** Runs `run`, which must be refused before anything reaches the chain: the signer's nonce and NEAR balance stay put. */
async function nothingSent(t: Checks, w: World, label: string, signer: Named, run: () => Promise<unknown>, want: Record<string, unknown>) {
  const [near0, nonce0] = [await w.chain.nearOf(signer.id), await w.chain.nonceOf(signer)];
  const error = await t.throws(label, run, want);
  const [near1, nonce1] = [await w.chain.nearOf(signer.id), await w.chain.nonceOf(signer)];
  t.ok(`${label}: nothing was sent (nonce and NEAR balance unchanged)`, near1 === near0 && nonce1 === nonce0, `nonce ${nonce0} -> ${nonce1}, NEAR ${near0} -> ${near1}`);
  return error;
}

/** A call the user pays for: checks the client's report, the chain's signer and that the user's NEAR went down by a fee. */
async function paid<T extends { relay?: RelayInfo }>(
  t: Checks,
  w: World,
  label: string,
  signer: Named,
  reason: PaidReason,
  run: (onPaidFallback: (r: PaidReason) => void) => Promise<T>,
): Promise<T> {
  const near0 = await w.chain.settledNear(signer.id);
  const told: PaidReason[] = [];
  const value = await run((r) => void told.push(r));
  const relay = value.relay;
  t.ok(`${label}: the client reports the user paid, because "${reason}"`, relay?.paidBy === "user" && relay.fallbackReason === reason && relay.status === "succeeded", show(relay));
  t.eq(`${label}: onPaidFallback was called once, before paying, with the reason`, told, [reason]);
  if (relay?.txHash && TX_HASH.test(relay.txHash)) {
    const tx = await tools(w).tx(relay.txHash, signer.id);
    t.eq(`${label}: on chain ${signer.id} signed the transaction itself`, tx.transaction.signer_id, signer.id);
  } else {
    t.ok(`${label}: the client reports the transaction hash`, false, show(relay?.txHash));
  }
  const spent = near0 - (await w.chain.settledNear(signer.id));
  t.ok(`${label}: ${signer.id} paid a network fee (${nearText(spent)})`, spent > 0n && spent < NEAR / 20n, nearText(spent));
  return value;
}

/** What the reference clearing says each bid gets, with the 1 % penalty of an invalid bid taken out of the refund. */
function expectedFills(result: ClearingResult) {
  return result.fills.map((f) => {
    const penalty = f.valid ? 0n : invalidBidPenalty(f.deposit);
    return { index: f.index, bidder: f.bidder, tokens: f.tokens, spent: f.spent, penalty, refund: f.deposit - f.spent - penalty, valid: f.valid };
  });
}

/** Compares the contract's result and fills, and the client's translation of them, with the reference clearing. */
async function checkResult(t: Checks, w: World, client: NearClient, saleId: string, expected: ClearingResult, clearedBy: "onchain" | "enclave") {
  const x = tools(w);
  const [result, fills] = [await x.result(saleId), await x.fills(saleId)];
  const want = expectedFills(expected);
  const penalties = want.reduce((sum, f) => sum + f.penalty, 0n);
  t.eq("contract get_result: status and fail reason", [result?.status, result?.fail_reason], ["settled", null]);
  t.eq("contract get_result: clearing price = reference clearing", result?.clearing_price, expected.clearingPrice.toString());
  t.eq("contract get_result: total sold = reference clearing", result?.total_sold, expected.totalSold.toString());
  t.eq("contract get_result: total raised = reference clearing", result?.total_raised, expected.totalRaised.toString());
  t.eq("contract get_result: valid and invalid counts", [result?.n_valid, result?.n_invalid], [expected.nValid, expected.nInvalid]);
  t.eq("contract get_result: winners", result?.n_winners, want.filter((f) => f.tokens > 0n).length);
  t.eq("contract get_result: total penalties = 1 % of each invalid deposit, rounded up", result?.total_penalties, penalties.toString());
  t.eq("contract get_result: no failed check", [result?.failed_checks, result?.failed_checks_total], [[], 0]);
  t.eq(
    "contract get_fills: tokens, spent, refund and penalty of every bid = reference clearing",
    fills.map((f) => ({ index: f.index, bidder: f.bidder, tokens: f.tokens, spent: f.spent, penalty: f.penalty, refund: f.refund })),
    want.map((f) => ({ index: f.index, bidder: f.bidder, tokens: f.tokens.toString(), spent: f.spent.toString(), penalty: f.penalty.toString(), refund: f.refund.toString() })),
  );

  const shown = await client.getResult(saleId);
  t.eq(
    "client getResult: price, totals, counts and penalties",
    shown && [shown.status, shown.clearingPrice, shown.totalSold, shown.totalRaised, shown.unsold, shown.nValid, shown.nInvalid, shown.totalPenalties, shown.clearedBy],
    ["settled", expected.clearingPrice, expected.totalSold, expected.totalRaised, expected.unsold, expected.nValid, expected.nInvalid, penalties, clearedBy],
  );
  t.eq(
    "client getResult: every fill (refund net of the penalty, valid only without one)",
    shown?.fills.map((f) => ({ index: f.index, bidder: f.bidder, tokens: f.tokens, spent: f.spent, penalty: f.penalty, refund: f.refund, valid: f.valid })),
    want,
  );
  t.ok("client getResult: every contract check is shown as passed", !!shown && shown.checks.length > 0 && shown.checks.every((c) => c.passed), show(shown?.checks.filter((c) => !c.passed)));
  return { result, fills, want, penalties };
}

export async function runScenarios(w: World, report: Report): Promise<void> {
  const x = tools(w);
  const fg = w.fairground.id;
  const usdc = w.usdc.id;
  const { creator, alice, bobby, carol, david, ellen, fresh, frank } = w.who;
  const client = w.client();

  // ------------------------------------------------------------------ setup

  await report.scenario("setup", "setup: chain, contracts, OutLayer stand-in, relayer", [], async (t) => {
    t.eq("the chain runs the fairground.wasm of contracts/res", await codeHashOf(w.chain, fg), base58OfHex(w.wasm.fairground));
    const config = await w.chain.view<{ outlayer: string; sealer_code_hash: string; allowed_quote_tokens: string[] }>(fg, "get_config");
    t.eq("the contract pins the sha256 of enclave/res/fairground_sealer.wasm", config.sealer_code_hash, w.sealerHash);
    t.eq("the contract calls OutLayer's contract and takes the mock USDC", [config.outlayer, config.allowed_quote_tokens], [w.outlayer.id, [usdc]]);
    for (const name of BIDDERS) t.eq(`${name} holds 100 test USDC`, await x.usdcOf(w.who[name].id), START_USDC);
    t.eq("fresh and frank are not registered on USDC", [await w.chain.ftRegistered(usdc, fresh.id), await w.chain.ftRegistered(usdc, frank.id)], [false, false]);

    await w.startRelayer("main");
    const health = (await (await fetch(`${RELAYER_URL}/health`)).json()) as { ok: boolean; network: string };
    t.eq("the relayer answers on 127.0.0.1:8790 and is healthy", health, { ok: true, network: "sandbox", balance: "ok", budget_exhausted: false });
    const policy = await client.getRelayerPolicy();
    t.eq("client getRelayerPolicy: the relayer account and the USDC it takes", policy && [policy.relayerAccountId, policy.usdcContracts], [w.relayerAccount.id, [usdc]]);
    t.eq("client getRelayerPolicy: the Fairground methods it pays for", policy?.methods, ["claim", "claim_proceeds", "clear_onchain", "reveal_bid", "trigger_refund_mode"]);
    t.eq("client capabilities", client.capabilities, { judgeMode: false, faucet: true, reset: false, relayer: true, simulated: false });
    t.eq("client expectedCodeHash = the pinned sealer hash", client.expectedCodeHash(), w.sealerHash);
  });

  // ------------------------------------------------------- dev signer guard

  await report.scenario("dev-signer", "dev signer: refused off a local sandbox", [], async (t) => {
    const account = { accountId: alice.id, secretKey: alice.secret };
    const refused = async (name: string, config: { network: string; rpcUrl: string }) => {
      await t.throws(`createDevSigner refuses ${name}`, async () => createDevSigner(config, account), { name: "ConfigError" });
      await t.throws(`devSigners refuses ${name}`, async () => devSigners({ ...config, devAccounts: [account] }), { name: "ConfigError" });
    };
    await refused("testnet, even with a local RPC URL", { network: "testnet", rpcUrl: w.chain.rpcUrl });
    await refused("mainnet", { network: "mainnet", rpcUrl: "https://rpc.mainnet.near.org" });
    await refused("a sandbox whose RPC is not on this machine", { network: "sandbox", rpcUrl: "https://rpc.testnet.near.org" });
    await refused("a sandbox on a host that only starts with 127.0.0.1", { network: "sandbox", rpcUrl: "http://127.0.0.1.example.com:3050" });

    for (const network of ["testnet", "mainnet"] as const) {
      const config = parseConfig(w.publicEnv({ NEXT_PUBLIC_NEAR_NETWORK: network }));
      t.eq(`parseConfig drops the dev accounts on ${network}`, config.mode === "near" && config.near.devAccounts, []);
    }
    const remote = parseConfig(w.publicEnv({ NEXT_PUBLIC_NEAR_RPC_URL: "https://sandbox.example.com" }));
    t.eq("parseConfig drops the dev accounts for a sandbox on another host", remote.mode === "near" && remote.near.devAccounts, []);
    await t.throws("parseConfig refuses a malformed dev account without echoing the key", async () => parseConfig(w.publicEnv({ NEXT_PUBLIC_DEV_ACCOUNTS: `${alice.id}=notakey` })), {
      name: "ConfigError",
      message: "NEXT_PUBLIC_DEV_ACCOUNTS: each entry must be <account_id>=ed25519:<base58 secret key> (entry 1 is not)",
    });

    const local = w.nearConfig();
    t.eq("parseConfig keeps the dev accounts on the local sandbox", local.devAccounts.length, Object.keys(w.who).length);
    const signers = devSigners(local, ellen.id);
    t.ok("devSigners builds a delegate-signing signer per account on the local sandbox", signers.signerFor(alice.id)?.signsDelegates === true && signers.activeAccount() === ellen.id);
    t.eq("devSigners has no signer for an account that is not listed", signers.signerFor(w.relayerAccount.id), null);
  });

  // ------------------------------------------------- commit-reveal: the sale

  const CR = "e2e-cr";
  const crBids: Plan[] = [
    { who: "alice", deposit: 6n * USDC, maxPrice: 10_000n, maxSpend: 5n * USDC },
    { who: "bobby", deposit: 3n * USDC, maxPrice: 6_000n, maxSpend: 3n * USDC },
    { who: "carol", deposit: 2n * USDC, maxPrice: 3_000n, maxSpend: 2n * USDC },
    // Never revealed: an invalid bid that pays the 1 % penalty, rounded up (40001).
    { who: "david", deposit: 4_000_001n, maxPrice: 5_000n, maxSpend: 4n * USDC },
  ];
  const crParams: SaleParams = { saleSupply: 10_000n * TOKEN, floorPrice: 3_000n, minRaise: 5n * USDC, decimals: 18, maxPrice: null };
  const crTotal = 1_000_000n * TOKEN;
  /**
   * Two clients whose view of the sale is kept for ten minutes, like pages left
   * open. A client drops its cached views after its own write, so each one is
   * good for one late bid.
   */
  const stale = w.client({ cacheMs: 600_000 });
  const staleAfterClose = w.client({ cacheMs: 600_000 });
  let crBidSetHash = "";

  const saleConfig = (p: SaleParams, o: Pick<SaleConfig, "tokenName" | "tokenSymbol" | "revealMode" | "maxBids"> & Partial<SaleConfig>, nowMs: number, windowMs: number): SaleConfig => ({
    decimals: 18,
    totalSupply: crTotal,
    saleSupply: p.saleSupply,
    creatorAllocation: crTotal - p.saleSupply,
    lpReserve: 0n,
    floorPrice: p.floorPrice,
    maxPrice: p.maxPrice ?? null,
    minRaise: p.minRaise,
    bidStart: nowMs,
    bidEnd: nowMs + windowMs,
    minDeposit: USDC,
    maxDepositPerAccount: 10n * USDC,
    unsoldRule: "burn",
    settleTimeoutMs: 600_000,
    quoteToken: usdc,
    ...o,
  });
  const meta = (description: string): SaleMeta => ({ description, hue: 0, website: "https://example.com/e2e" });

  /** create_sale through the client, checked against the contract's own views; leaves the sale open. */
  async function createAndOpen(t: Checks, saleId: string, config: SaleConfig, description: string) {
    const windowMs = config.bidEnd - config.bidStart;
    const options = { saleId, minStartLeadMs: START_LEAD_MS };
    // The contract's own price for this sale, asked with parameters written out here, not by the client.
    const asked = BigInt(await w.chain.view<string>(fg, "get_create_cost", { params: rawCreateParams(saleId, config, description, await w.chain.nowNs()) }));
    const cost = await client.getCreateCost(creator.id, config, meta(description), options);
    const near0 = await w.chain.settledNear(creator.id);
    const sale = await client.createSale(creator.id, config, meta(description), options);
    const spent = near0 - (await w.chain.settledNear(creator.id));
    const view = await x.sale(saleId);
    if (!view) throw new Error(`the contract has no sale ${saleId} after createSale`);

    t.eq("client getCreateCost = the contract's get_create_cost", cost, asked);
    // A TEE sale's cost holds OutLayer's compute deposit, and OutLayer gives back what it does not charge.
    const refundable = config.revealMode === "tee" ? OUTLAYER_COMPUTE_DEPOSIT : 0n;
    t.ok(`a wallet transaction: the creator paid the cost (${nearText(cost)}) plus gas, ${nearText(spent)} in all`, spent > cost - refundable && spent < cost + NEAR / 20n, nearText(spent));
    t.ok("client createSale reports the transaction hash", TX_HASH.test(sale.createTx), sale.createTx);
    t.eq(
      "contract get_sale: the terms the client sent",
      [view.creator, view.token, view.quote_token, view.token_name, view.token_symbol, view.decimals, view.total_supply, view.sale_supply, view.creator_allocation, view.floor_price, view.max_price, view.min_raise, view.min_deposit, view.max_deposit_per_account, view.max_bids, view.reveal_mode, view.reveal_window, view.settle_timeout, view.description, view.website],
      [creator.id, `${saleId}.${fg}`, usdc, config.tokenName, config.tokenSymbol, 18, config.totalSupply.toString(), config.saleSupply.toString(), (config.totalSupply - config.saleSupply).toString(), config.floorPrice.toString(), config.maxPrice === null ? null : config.maxPrice.toString(), config.minRaise.toString(), USDC.toString(), (10n * USDC).toString(), config.maxBids, config.revealMode === "tee" ? "Tee" : "CommitReveal", config.revealWindowMs === undefined ? null : (BigInt(config.revealWindowMs) * MS).toString(), (600_000n * MS).toString(), description, "https://example.com/e2e"],
    );
    t.eq("contract get_sale: the bid window kept its length", BigInt(view.bid_end) - BigInt(view.bid_start), BigInt(windowMs) * MS);
    t.ok("contract get_sale: the window starts after the sale was created", BigInt(view.bid_start) > BigInt(view.created_at), `${view.created_at} -> ${view.bid_start}`);
    t.eq(
      "client createSale: the sale it returns matches the contract, with its token deployed and its setup done",
      [sale.id, sale.creator, sale.tokenAccount, sale.config.bidStart, sale.config.bidEnd, sale.config.saleSupply, sale.config.creatorAllocation, sale.config.revealMode, sale.maxBids, sale.tokenSetup, sale.sealerKeySetup],
      [saleId, creator.id, view.token, Number(BigInt(view.bid_start) / MS), Number(BigInt(view.bid_end) / MS), config.saleSupply, config.totalSupply - config.saleSupply, config.revealMode, config.maxBids, "done", "done"],
    );
    // "upcoming" unless this machine took longer than the ten seconds to bid_start.
    t.ok("client createSale: the sale is out of setup", sale.chainStatus === "upcoming" || sale.chainStatus === "open", show(sale.chainStatus));
    t.eq("the sale token exists with its whole supply held by the contract", [await w.chain.ftSupply(view.token), await w.chain.ft(view.token, fg)], [config.totalSupply, config.totalSupply]);

    await w.chain.advanceTo(BigInt(view.bid_start));
    const open = await client.getSale(saleId);
    t.eq("once the chain clock passes bid_start the client shows the sale open", [open?.status, open?.chainStatus], ["open", "open"]);
    t.ok("client listSales lists it", (await client.listSales()).some((s) => s.id === saleId));
    return { sale, view };
  }

  await report.scenario("cr-create", "commit-reveal: create_sale (wallet transaction)", ["setup"], async (t) => {
    const config = saleConfig(crParams, { tokenName: "E2E Commit", tokenSymbol: "ECR", revealMode: "commit_reveal", maxBids: crBids.length, revealWindowMs: 120_000 }, await x.nowMs(), 300_000);
    // The contract's view refuses bad terms by panicking; the client must pass its words on from the node's error.
    await t.throws("getCreateCost for a 0.5 USDC minimum deposit: refused in the contract's own words", () => client.getCreateCost(creator.id, { ...config, minDeposit: USDC / 2n }, meta("x"), { saleId: CR }), {
      name: "FairgroundError", code: "invalid", message: "invalid min_deposit: must satisfy 1 USDC (1000000) <= min_deposit <= max_deposit_per_account",
    });
    await t.throws("createSale with a sale id the contract would refuse: refused before signing", () => client.createSale(creator.id, config, meta("x"), { saleId: "Not-An-Id" }), {
      name: "FairgroundError", code: "invalid", message: "invalid sale_id: must match ^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$",
    });
    await createAndOpen(t, CR, config, "Commit-reveal sale of the sandbox end-to-end run.");
    await nothingSent(t, w, "createSale with an id that is taken: refused before signing", creator, () => client.createSale(creator.id, config, meta("x"), { saleId: CR }), {
      name: "FairgroundError", code: "invalid", message: "a sale with this id already exists",
    });
  });

  await report.scenario("cr-bids", "commit-reveal: four gasless bids", ["cr-create"], async (t) => {
    const pool0 = await x.usdcOf(fg);
    for (const [index, plan] of crBids.entries()) {
      const bidder = w.who[plan.who];
      const usdc0 = await x.usdcOf(bidder.id);
      const placed = await gasless(t, w, `${plan.who}'s bid`, bidder, () => client.bid(CR, bidder.id, plan.deposit, { maxPrice: plan.maxPrice, maxSpend: plan.maxSpend }));
      t.eq(`${plan.who}'s bid: ${plan.deposit} USDC base units left the account`, usdc0 - (await x.usdcOf(bidder.id)), plan.deposit);
      const onChain = await x.bid(CR, bidder.id);
      const commitment = placed.secret ? commitmentHex(CR, bidder.id, plan.maxPrice, plan.maxSpend, fromHex(placed.secret.salt)) : "";
      t.eq(
        `${plan.who}'s bid: the contract stores it at index ${index} with the DESIGN v1 commitment of the saved salt`,
        onChain && [onChain.index, onChain.deposit, Buffer.from(onChain.payload, "base64").toString("hex"), onChain.revealed],
        [index, plan.deposit.toString(), commitment, false],
      );
      t.eq(`${plan.who}'s bid: the client returns the same record`, [placed.index, placed.deposit, placed.payloadKind, placed.secret?.commitment], [index, plan.deposit, "commitment", commitment]);
      // After the third bid the "page left open" reads the sale: one slot is still free then.
      if (index === 2) {
        t.eq("two more clients read the sale while it is open with a slot free", [(await stale.getSale(CR))?.bidCount, (await staleAfterClose.getSale(CR))?.status], [3, "open"]);
      }
    }
    const total = crBids.reduce((sum, p) => sum + p.deposit, 0n);
    const [view, bids] = [await x.sale(CR), await x.bids(CR)];
    crBidSetHash = bidSetHash(CR, bids.map((b) => ({ bidder: b.bidder, deposit: BigInt(b.deposit), payload: Buffer.from(b.payload, "base64") })));
    t.eq("the contract holds the four deposits", (await x.usdcOf(fg)) - pool0, total);
    t.eq("contract get_sale: bid count, total deposits and the running bid-set hash (v1, recomputed here)", [view?.bid_count, view?.total_deposits, view?.bid_set_hash], [4, total.toString(), crBidSetHash]);
    const shown = await client.getBids(CR);
    t.eq("client getBids: the four bids in order, deposits only", shown.map((b) => [b.index, b.bidder, b.deposit]), crBids.map((p, i) => [i, w.who[p.who].id, p.deposit]));
    t.eq("client getSale: bid count, deposits and running hash", await client.getSale(CR).then((s) => s && [s.bidCount, s.totalDeposits, s.runningBidSetHash, s.bidSetHash]), [4, total, crBidSetHash, null]);
  });

  await report.scenario("cr-rejected", "commit-reveal: a rejected bid surfaces its reason", ["cr-bids"], async (t) => {
    const terms = { maxPrice: 4_000n, maxSpend: 2n * USDC };
    // Refused by the client before anyone signs: what the contract would return the deposit for.
    await nothingSent(t, w, "below the minimum deposit: refused before signing", ellen, () => client.bid(CR, ellen.id, USDC / 2n, { maxPrice: 4_000n, maxSpend: USDC / 2n }), {
      name: "FairgroundError", code: "invalid", reason: "below_min_deposit", message: BID_REJECT_MESSAGES.below_min_deposit,
    });
    await nothingSent(t, w, "a second bid from alice: refused before signing", alice, () => client.bid(CR, alice.id, 2n * USDC, terms), {
      name: "FairgroundError", code: "invalid", reason: "already_bid", message: BID_REJECT_MESSAGES.already_bid,
    });
    await nothingSent(t, w, "a bid that would be void (spend above deposit): refused before signing", ellen, () => client.bid(CR, ellen.id, 2n * USDC, { maxPrice: 4_000n, maxSpend: 3n * USDC }), {
      name: "FairgroundError", code: "invalid", message: "Max spend cannot be more than the deposit. Such a bid would be void and lose 1 % of its deposit.",
    });
    await nothingSent(t, w, "the sale is full: refused before signing by a client with a fresh view", ellen, () => client.bid(CR, ellen.id, 2n * USDC, terms), {
      name: "FairgroundError", code: "invalid", reason: "sale_full", message: BID_REJECT_MESSAGES.sale_full,
    });

    // Refused by the contract: the second client still believes a slot is free, so the bid is
    // signed and relayed, and the contract returns the deposit with a bid_rejected event.
    const [usdc0, near0, pool0] = [await x.usdcOf(ellen.id), await w.chain.nearOf(ellen.id), await x.usdcOf(fg)];
    const error = await t.throws("the contract rejects ellen's bid (sale_full) and the client says why", () => stale.bid(CR, ellen.id, 2n * USDC, terms), {
      name: "FairgroundError", code: "bid_rejected", reason: "sale_full", maybeSubmitted: false, message: `${BID_REJECT_MESSAGES.sale_full} Your deposit was returned.`,
    });
    const relay = error?.["relay"] as RelayInfo | undefined;
    t.ok("the rejected bid was relayed: the error carries how it was sent", relay?.paidBy === "relayer" && relay.status === "succeeded" && TX_HASH.test(relay.txHash ?? ""), show(relay));
    t.eq("the deposit came back in full and ellen paid no NEAR", [(await x.usdcOf(ellen.id)) - usdc0, (await w.chain.nearOf(ellen.id)) - near0, (await x.usdcOf(fg)) - pool0], [0n, 0n, 0n]);
    t.eq("the contract holds no bid from ellen", await x.bid(CR, ellen.id), null);
    const row = (await stale.getEvents(CR)).find((e) => e.kind === "bid_rejected");
    t.eq("the client's timeline keeps the returned bid with its reason", row && [row.account, row.reason, row.amount, row.source, row.txHash], [ellen.id, "sale_full", 2n * USDC, "tx", relay?.txHash]);
  });

  await report.scenario("cr-reveal", "commit-reveal: close_sale (wallet transaction), reveals relayed", ["cr-bids"], async (t) => {
    await nothingSent(t, w, "close_sale before the window ends: refused before signing", creator, () => client.closeSale(CR, creator.id), {
      name: "FairgroundError", code: "invalid", reason: "wrong_phase", message: "The bid window has not ended yet.",
    });
    const before = await x.sale(CR);
    await w.chain.advanceTo(BigInt(before!.bid_end));
    t.eq("after bid_end the client shows the sale awaiting its close", (await client.getSale(CR))?.status, "awaiting_close");
    t.eq("client getCloseDeposit: a commit-reveal close attaches nothing", await client.getCloseDeposit(CR), 0n);

    const near0 = await w.chain.settledNear(creator.id);
    const closed = await client.closeSale(CR, creator.id);
    const fee = near0 - (await w.chain.settledNear(creator.id));
    const view = await x.sale(CR);
    t.ok(`a wallet transaction: the closer paid only gas (${nearText(fee)})`, fee > 0n && fee < NEAR / 20n, nearText(fee));
    t.eq("contract get_sale: revealing, with the bid set frozen", [view?.status, view?.bid_set_hash, view?.bid_count], ["revealing", crBidSetHash, 4]);
    t.eq("contract get_sale: the reveal window ends two minutes after the close", BigInt(view!.reveal_end!) - BigInt(view!.closed_at!), 120_000n * MS);
    t.eq("client closeSale returns the sale revealing, with its frozen hash and reveal end", [closed.status, closed.bidSetHash, closed.revealEnd], ["revealing", crBidSetHash, Number(BigInt(view!.reveal_end!) / MS)]);

    // A page left open still shows the sale open; the relayer reads the chain and refuses to pay.
    const late = await nothingSent(t, w, "a bid after the close, from a stale page: the relayer refuses it", ellen, () => staleAfterClose.bid(CR, ellen.id, 2n * USDC, { maxPrice: 4_000n, maxSpend: 2n * USDC }), {
      name: "FairgroundError", code: "relayer_refused", reason: "wrong_phase", maybeSubmitted: false,
    });
    t.ok("the refusal carries the relayer's request id", typeof late?.["requestId"] === "string" && (late["requestId"] as string).length > 0, show(late?.["requestId"]));

    for (const plan of crBids.slice(0, 3)) {
      const bidder = w.who[plan.who];
      const revealed = await gasless(t, w, `${plan.who}'s reveal`, bidder, () => client.revealBid(CR, bidder.id));
      t.ok(`${plan.who}'s reveal: the contract marks the bid revealed`, (await x.bid(CR, bidder.id))?.revealed === true && TX_HASH.test(revealed.txHash));
    }
    await nothingSent(t, w, "a reveal with the wrong salt: refused before signing", david, () => client.revealBid(CR, david.id, { maxPrice: 5_000n, maxSpend: 4n * USDC, salt: "00".repeat(16) }), {
      name: "FairgroundError", code: "invalid", reason: "commitment_mismatch",
    });
    await nothingSent(t, w, "a second reveal from alice: refused before signing", alice, () => client.revealBid(CR, alice.id), {
      name: "FairgroundError", code: "invalid", reason: "already_revealed",
    });
    t.eq("david's bid stays unrevealed", (await x.bid(CR, david.id))?.revealed, false);
    await nothingSent(t, w, "clear_onchain while the reveal window is open: the relayer refuses it", ellen, () => client.clearOnchain(CR, ellen.id), {
      name: "FairgroundError", code: "relayer_refused", reason: "wrong_phase", maybeSubmitted: false,
    });
  });

  const crExpected = () =>
    clear(
      crParams,
      crBids.map((p): Bid => {
        const revealed = p.who !== "david";
        return { bidder: w.who[p.who].id, deposit: p.deposit, maxPrice: revealed ? p.maxPrice : null, maxSpend: revealed ? p.maxSpend : null };
      }),
    );

  await report.scenario("cr-clear", "commit-reveal: clear_onchain relayed, result = clearing math", ["cr-reveal"], async (t) => {
    const view = await x.sale(CR);
    await w.chain.advanceTo(BigInt(view!.reveal_end!));
    // ellen never bid in this sale: anyone may push the clearing, and it costs her nothing.
    const cleared = await gasless(t, w, "clear_onchain pushed by ellen", ellen, () => client.clearOnchain(CR, ellen.id));
    t.eq("client clearOnchain returns the sale settled", [cleared.status, cleared.chainStatus], ["settled", "settled"]);

    const expected = crExpected();
    // The plan of this sale, worked by hand: demand at the 0.003 USDC floor is 3333.33 tokens of 10000, so it clears at the floor.
    t.eq("reference clearing: undersubscribed, clears at the floor, 6666.67 tokens unsold", [expected.status, expected.clearingPrice, expected.oversubscribed, expected.unsold], ["settled", 3_000n, false, 6_666_666_666_666_666_666_668n]);
    t.eq("reference clearing: alice 1666.67 tokens for 5 USDC, bobby 1000 for 3, carol 666.67 for 2, david nothing", expected.fills.map((f) => [f.tokens, f.spent]), [
      [1_666_666_666_666_666_666_666n, 5_000_000n],
      [1_000_000_000_000_000_000_000n, 3_000_000n],
      [666_666_666_666_666_666_666n, 2_000_000n],
      [0n, 0n],
    ]);
    const { penalties } = await checkResult(t, w, client, CR, expected, "onchain");
    t.eq("david's unrevealed bid pays 1 % of 4.000001 USDC, rounded up", penalties, 40_001n);
    const fills = (await client.getResult(CR))?.fills ?? [];
    t.eq("client getResult: which bids were revealed", fills.map((f) => f.revealed), [true, true, true, false]);
  });

  /** Claims every bid of a settled sale through the relayer and checks every balance against the reference clearing. */
  async function claimAll(t: Checks, saleId: string, plans: Plan[], expected: ClearingResult, pushed: { bidder: Person; by: Person }) {
    const want = expectedFills(expected);
    const view = (await x.sale(saleId))!;
    const penalties = want.reduce((sum, f) => sum + f.penalty, 0n);
    const deposits = plans.reduce((sum, p) => sum + p.deposit, 0n);
    const pool0 = await x.usdcOf(fg);

    for (const [index, plan] of plans.entries()) {
      const bidder = w.who[plan.who];
      const fill = want[index];
      const [usdc0, token0] = [await x.usdcOf(bidder.id), await w.chain.ft(view.token, bidder.id)];
      const pusher = pushed.bidder === plan.who ? w.who[pushed.by] : bidder;
      const label = pusher === bidder ? `${plan.who}'s claim` : `${plan.who}'s claim, pushed by ${pushed.by}`;
      const [pusherUsdc0, bidderNear0, bidderNonce0] = [await x.usdcOf(pusher.id), await w.chain.nearOf(bidder.id), await w.chain.nonceOf(bidder)];
      const receipt = await gasless(t, w, label, pusher, () => client.claim(saleId, bidder.id, pusher === bidder ? undefined : { caller: pusher.id }));
      t.eq(`${label}: the client reports ${fill.tokens} tokens and ${fill.refund} USDC`, [receipt.tokens, receipt.refund], [fill.tokens, fill.refund]);
      t.eq(`${label}: ${plan.who} received exactly that`, [(await w.chain.ft(view.token, bidder.id)) - token0, (await x.usdcOf(bidder.id)) - usdc0], [fill.tokens, fill.refund]);
      if (pusher !== bidder) {
        t.eq(`${label}: the pusher's USDC did not move, and ${plan.who} signed nothing and paid nothing`, [(await x.usdcOf(pusher.id)) - pusherUsdc0, (await w.chain.nonceOf(bidder)) - bidderNonce0, (await w.chain.nearOf(bidder.id)) - bidderNear0], [0n, 0n, 0n]);
      }
      t.eq(`${label}: the contract marks the bid claimed`, (await x.bid(saleId, bidder.id))?.claimed, true);
      // A bid that won nothing is never registered on the sale token.
      t.eq(`${label}: registered on the sale token only if it won tokens`, await w.chain.ftRegistered(view.token, bidder.id), fill.tokens > 0n);
    }
    t.eq("after every claim the contract has paid out the deposits less what was raised and the penalties", pool0 - (await x.usdcOf(fg)), deposits - expected.totalRaised - penalties);
    await nothingSent(t, w, "a second claim from alice: refused before signing", alice, () => client.claim(saleId, alice.id), { name: "FairgroundError", code: "invalid", reason: "already_claimed" });

    // The creator's payout: the raise, the allocation, the unused NEAR reserve; unsold tokens are burned.
    const reserve = BigInt(await w.chain.view<string>(fg, "get_reserve_refund", { sale_id: saleId }));
    t.ok(`contract get_reserve_refund: there is NEAR to return to the creator (${nearText(reserve)})`, reserve > 0n, reserve.toString());
    // A sold-out sale has nothing to burn: that part counts as settled from the start.
    t.eq("client getResult before the payout: the raise, the allocation and the reserve are open", (await client.getResult(saleId))?.proceeds, {
      raisePaid: false,
      allocationPaid: false,
      unsoldBurned: expected.unsold === 0n,
      reserveReturned: false,
    });
    const [usdc0, pool1] = [await x.usdcOf(creator.id), await x.usdcOf(fg)];
    const proceeds = await gasless(t, w, "claim_proceeds", creator, () => client.claimProceeds(saleId, creator.id), reserve);
    t.ok("claim_proceeds: the client reports the transaction hash", TX_HASH.test(proceeds.txHash), proceeds.txHash);
    const allocation = BigInt(view.total_supply) - BigInt(view.sale_supply);
    t.eq("claim_proceeds: the creator received the raise in USDC and the allocation in tokens", [(await x.usdcOf(creator.id)) - usdc0, await w.chain.ft(view.token, creator.id)], [expected.totalRaised, allocation]);
    t.eq("the unsold tokens are burned: total supply = minted - unsold", await w.chain.ftSupply(view.token), BigInt(view.total_supply) - expected.unsold);
    t.eq("the contract holds no sale token any more", await w.chain.ft(view.token, fg), 0n);
    t.eq("of this sale's USDC only the penalties stay in the contract, for good", (await x.usdcOf(fg)) - (pool0 - deposits), penalties);
    t.eq("the raise left the contract with claim_proceeds", pool1 - (await x.usdcOf(fg)), expected.totalRaised);
    const result = await x.result(saleId);
    t.eq("contract get_result: every payout that had something to pay is done", result?.proceeds, {
      raise_paid: true,
      allocation_paid: true,
      unsold_burned: expected.unsold > 0n,
      reserve_returned: true,
    });
    t.eq("contract get_reserve_refund: nothing left", await w.chain.view<string>(fg, "get_reserve_refund", { sale_id: saleId }), "0");
    await nothingSent(t, w, "a second claim_proceeds: refused before signing, nothing is left to pay", creator, () => client.claimProceeds(saleId, creator.id), {
      name: "FairgroundError", code: "invalid", reason: "already_claimed",
    });

    const balances = await client.getBalances(alice.id, [saleId]);
    t.eq("client getBalances = the chain's balances", [balances.usdc, balances.tokens[saleId]], [await x.usdcOf(alice.id), await w.chain.ft(view.token, alice.id)]);
    const shown = await client.getResult(saleId);
    t.eq("client getResult: every fill claimed, every creator payout settled", [shown?.fills.every((f) => f.claimed), shown?.proceeds], [
      true,
      { raisePaid: true, allocationPaid: true, unsoldBurned: true, reserveReturned: true },
    ]);
  }

  await report.scenario("cr-claims", "commit-reveal: claims relayed (one pushed for another), claim_proceeds", ["cr-clear"], async (t) => {
    const expected = crExpected();
    await claimAll(t, CR, crBids, expected, { bidder: "bobby", by: "ellen" });
    await nothingSent(t, w, "a claim for an account without a bid: refused before signing", ellen, () => client.claim(CR, ellen.id), { name: "FairgroundError", code: "invalid", reason: "no_bid" });
    // The whole sale, in USDC: start - spent - penalty for each bidder.
    const want = expectedFills(expected);
    t.eq("every bidder's USDC = 100 - spent - penalty", await Promise.all(crBids.map((p) => x.usdcOf(w.who[p.who].id))), want.map((f) => START_USDC - f.spent - f.penalty));
    const kinds = (await client.getEvents(CR)).map((e) => e.detail ?? e.kind);
    const count = (kind: string) => kinds.filter((k) => k === kind).length;
    t.eq(
      "client getEvents: the sale's timeline from views (created, 4 bids, close, 3 reveals, settled, 4 claims, creator payout)",
      [count("created"), count("bid"), count("closed"), count("bid_revealed"), count("settled"), count("claimed"), count("proceeds_claimed")],
      [1, 4, 1, 3, 1, 4, 1],
    );
  });

  // -------------------------------------------------------------- TEE: the sale

  const TEE = "e2e-tee";
  const teeBids: Plan[] = [
    // Above the 0.008 ceiling: the enclave clamps it.
    { who: "alice", deposit: 5n * USDC, maxPrice: 20_000n, maxSpend: 2n * USDC },
    { who: "bobby", deposit: 3n * USDC, maxPrice: 5_000n, maxSpend: 3n * USDC },
    { who: "carol", deposit: 2_500_000n, maxPrice: 5_000n, maxSpend: 2_500_000n },
    // Void: sealed properly, but it asks to spend more than its deposit. Penalty 20000.
    { who: "david", deposit: 2n * USDC, maxPrice: 6_000n, maxSpend: 3n * USDC },
    // Void: a copy of alice's sealed bid sent from ellen's account. Penalty 10001. The terms here are alice's.
    { who: "ellen", deposit: 1_000_001n, maxPrice: 20_000n, maxSpend: 2n * USDC },
    // Void: good terms, but sealed to a key that is not the sale's, so the enclave cannot open it. Penalty 30000.
    // Opened, this bid alone would take the whole supply at 0.006 and move the clearing price.
    { who: "grace", deposit: 3n * USDC, maxPrice: 6_000n, maxSpend: 3n * USDC },
  ];
  const teeParams: SaleParams = { saleSupply: 500n * TOKEN, floorPrice: 2_000n, minRaise: USDC, decimals: 18, maxPrice: 8_000n };
  let teePubkey = "";

  await report.scenario("tee-create", "TEE: create_sale (wallet transaction), sale key from the pinned enclave job", ["setup"], async (t) => {
    const config = saleConfig(teeParams, { tokenName: "E2E Sealed", tokenSymbol: "ETEE", revealMode: "tee", maxBids: teeBids.length }, await x.nowMs(), 300_000);
    const { sale, view } = await createAndOpen(t, TEE, config, "Sealed-bid sale of the sandbox end-to-end run.");
    const served = await w.worker.last("pubkey", TEE);
    const answer = JSON.parse(served.run.output) as { ok: boolean; op: string; sale_id: string; pubkey: string };
    teePubkey = answer.pubkey;
    t.ok(`the pinned job answered the key request (${served.run.instructions} instructions)`, served.run.success && answer.ok && answer.op === "pubkey" && answer.sale_id === TEE, served.run.output);
    t.eq("the request OutLayer stored is the contract's pubkey input", JSON.parse(served.input), { v: 1, op: "pubkey", contract: fg, sale_id: TEE });
    t.eq("OutLayer was asked, by the contract and paid by the creator, to run the pinned module with a Text answer", requestFacts(served.request), [fg, creator.id, w.sealerHash, "Text", 50_000_000_000, 60]);
    t.ok("the sale key is 32 bytes of hex", /^[0-9a-f]{64}$/.test(teePubkey), teePubkey);
    t.eq("contract get_sale: the key the job derived, and the pinned code hash", [view.sealer_pubkey, view.sealer_code_hash, view.sealer_key_setup], [teePubkey, w.sealerHash, "done"]);
    t.eq("client createSale: the sale carries the key and the code hash", [sale.sealerPubkey, sale.sealerCodeHash], [teePubkey, w.sealerHash]);
    const attestation = await client.getAttestation(TEE, "");
    t.eq("client getAttestation: code hash and key from the chain", [attestation.codeHash, attestation.reportedPubkey, attestation.source, attestation.simulated], [w.sealerHash, teePubkey, "chain", false]);
  });

  await report.scenario("tee-bids", "TEE: gasless bids sealed by the web client's crypto; one void, one copied, one sealed to another key", ["tee-create"], async (t) => {
    const pool0 = await x.usdcOf(fg);
    let aliceBox = "";
    for (const [index, plan] of teeBids.entries()) {
      const bidder = w.who[plan.who];
      const usdc0 = await x.usdcOf(bidder.id);
      const label = `${plan.who}'s bid`;
      let box: string;
      if (plan.who === "david") {
        // The app's bid() will not send a void bid, so seal it with the app's crypto and send the box.
        await nothingSent(t, w, "david's void terms through bid(): refused before signing", bidder, () => client.bid(TEE, bidder.id, plan.deposit, { maxPrice: plan.maxPrice, maxSpend: plan.maxSpend }), {
          name: "FairgroundError", code: "invalid",
        });
        box = await sealBid(teePubkey, { sale_id: TEE, bidder: bidder.id, max_price: plan.maxPrice.toString(), max_spend: plan.maxSpend.toString(), salt: randomHex(16) });
        await gasless(t, w, label, bidder, () => client.placeBid(TEE, bidder.id, plan.deposit, box));
      } else if (plan.who === "ellen") {
        // A box sealed for a longer account id has another length: the client refuses it before signing.
        const longer = await sealBid(teePubkey, { sale_id: TEE, bidder: creator.id, max_price: "4000", max_spend: "1000000", salt: randomHex(16) });
        await nothingSent(t, w, "a box of the wrong length: refused before signing", bidder, () => client.placeBid(TEE, bidder.id, plan.deposit, longer), {
          name: "FairgroundError", code: "invalid", reason: "wrong_ciphertext_length",
        });
        box = aliceBox;
        await gasless(t, w, `${label} (alice's sealed bid, copied)`, bidder, () => client.placeBid(TEE, bidder.id, plan.deposit, box));
      } else if (plan.who === "grace") {
        // The right plaintext and the right length, sealed with the app's crypto to a key the enclave does not hold.
        const other = await newSaleKeypair();
        box = await sealBid(other.publicKey, { sale_id: TEE, bidder: bidder.id, max_price: plan.maxPrice.toString(), max_spend: plan.maxSpend.toString(), salt: randomHex(16) });
        await gasless(t, w, `${label} (sealed to another key)`, bidder, () => client.placeBid(TEE, bidder.id, plan.deposit, box));
      } else {
        const placed = await gasless(t, w, label, bidder, () => client.bid(TEE, bidder.id, plan.deposit, { maxPrice: plan.maxPrice, maxSpend: plan.maxSpend }));
        box = placed.ciphertext;
        t.eq(`${label}: the client returns the record`, [placed.index, placed.deposit, placed.payloadKind], [index, plan.deposit, "ciphertext"]);
        if (plan.who === "alice") aliceBox = box;
      }
      const length = Buffer.from(box, "base64").length;
      t.eq(`${label}: the sealed box is 224 + len(sale id) + len(bidder) = ${224 + TEE.length + bidder.id.length} bytes`, [length, sealedBidLength(TEE, bidder.id)], [224 + TEE.length + bidder.id.length, length]);
      const onChain = await x.bid(TEE, bidder.id);
      t.eq(`${label}: the contract stores the box unchanged at index ${index}`, onChain && [onChain.index, onChain.deposit, onChain.payload], [index, plan.deposit.toString(), box]);
      t.eq(`${label}: the deposit left the account`, usdc0 - (await x.usdcOf(bidder.id)), plan.deposit);
    }
    const total = teeBids.reduce((sum, p) => sum + p.deposit, 0n);
    const [view, bids] = [await x.sale(TEE), await x.bids(TEE)];
    t.eq("the contract holds the six deposits", (await x.usdcOf(fg)) - pool0, total);
    t.eq("contract get_sale: bid count, deposits and the running bid-set hash (v1, recomputed here)", [view?.bid_count, view?.total_deposits, view?.bid_set_hash], [
      6,
      total.toString(),
      bidSetHash(TEE, bids.map((b) => ({ bidder: b.bidder, deposit: BigInt(b.deposit), payload: Buffer.from(b.payload, "base64") }))),
    ]);
    t.ok("on chain ellen's box is alice's byte for byte, and no other two boxes are equal", bids[0].payload === bids[4].payload && new Set(bids.map((b) => b.payload)).size === bids.length - 1);
  });

  const teeExpected = () =>
    clear(
      teeParams,
      teeBids.map((p): Bid => {
        // grace's box does not open: the clearing sees no terms at all.
        const opens = p.who !== "grace";
        return { bidder: w.who[p.who].id, deposit: p.deposit, maxPrice: opens ? p.maxPrice : null, maxSpend: opens ? p.maxSpend : null, mismatch: p.who === "ellen" };
      }),
    );

  await report.scenario("tee-clear", "TEE: close_sale (wallet transaction with get_close_deposit), the pinned job clears", ["tee-bids"], async (t) => {
    const before = (await x.sale(TEE))!;
    await w.chain.advanceTo(BigInt(before.bid_end));
    const deposit = await client.getCloseDeposit(TEE);
    t.eq("client getCloseDeposit = the contract's get_close_deposit = OutLayer's compute deposit for a small input", [deposit, BigInt(await w.chain.view<string>(fg, "get_close_deposit", { sale_id: TEE }))], [OUTLAYER_COMPUTE_DEPOSIT, OUTLAYER_COMPUTE_DEPOSIT]);

    const near0 = await w.chain.settledNear(creator.id);
    const closed = await client.closeSale(TEE, creator.id);
    const spent = near0 - (await w.chain.settledNear(creator.id));
    t.ok(`a wallet transaction: the closer paid gas and at most the close deposit (${nearText(spent)} in all; OutLayer returns what it does not charge)`, spent > 0n && spent < deposit + NEAR / 20n, nearText(spent));
    t.eq("client closeSale returns once the enclave's answer has settled the sale", [closed.status, closed.chainStatus], ["settled", "settled"]);

    const served = await w.worker.last("clear", TEE);
    t.ok(`the pinned job cleared the sale (${served.run.instructions} instructions, delivered with ${served.delivery})`, served.run.success, served.run.stderr);
    t.eq("OutLayer was asked, by the contract and paid by the closer, to run the pinned module with a Text answer", requestFacts(served.request), [fg, creator.id, w.sealerHash, "Text", 50_000_000_000, 60]);
    const input = JSON.parse(served.input) as { op: string; contract: string; sale_id: string; bid_set_hash: string; params: Record<string, unknown>; bids: [string, string, string][] };
    const bids = await x.bids(TEE);
    t.eq("the job's input: the sale's terms and frozen bid-set hash", [input.op, input.contract, input.sale_id, input.bid_set_hash, input.params], ["clear", fg, TEE, before.bid_set_hash, { sale_supply: teeParams.saleSupply.toString(), floor_price: "2000", max_price: "8000", min_raise: USDC.toString(), decimals: 18 }]);
    t.eq("the job's input: every bid as the browser sealed it (bidder, deposit, box)", input.bids, bids.map((b) => [b.bidder, b.deposit, b.payload]));

    const expected = teeExpected();
    // Worked by hand: at 0.005 demand is 1500 tokens of 500 and above it only alice's 400 remain, so it clears at 0.005.
    t.eq("reference clearing: oversubscribed, clears at 0.005 USDC, sold out", [expected.status, expected.clearingPrice, expected.oversubscribed, expected.unsold], ["settled", 5_000n, true, 0n]);
    t.eq("reference clearing: alice 400 tokens in full; bobby and carol share 100 pro rata (54.55 and 45.45); the three void bids nothing", expected.fills.map((f) => [f.tokens, f.spent, f.valid]), [
      [400n * TOKEN, 2_000_000n, true],
      [54_545_454_545_454_545_455n, 272_728n, true],
      [45_454_545_454_545_454_545n, 227_273n, true],
      [0n, 0n, false],
      [0n, 0n, false],
      [0n, 0n, false],
    ]);
    const output = JSON.parse(served.run.output) as { ok: boolean; pubkey: string; bid_set_hash: string; clearing_price: string; n_valid: number; n_invalid: number; invalid: number[]; fills: [string, string][] };
    t.eq(
      "the job's answer: it opened the three good boxes with the sale key; the void, the copied and the wrongly sealed one are invalid",
      [output.ok, output.pubkey, output.bid_set_hash, output.clearing_price, output.n_valid, output.n_invalid, output.invalid, output.fills],
      [true, teePubkey, before.bid_set_hash, "5000", 3, 3, [3, 4, 5], expected.fills.map((f) => [f.tokens.toString(), f.spent.toString()])],
    );

    const { result, penalties } = await checkResult(t, w, client, TEE, expected, "enclave");
    t.eq("penalties: 1 % of 2 USDC (void), of 1.000001 USDC (copied) and of 3 USDC (not openable), each rounded up", penalties, 20_000n + 10_001n + 30_000n);
    // OutLayer hands the callback the job's stdout as one JSON string; the contract stores the sha256 of those bytes.
    t.eq("contract get_result: sha256 of the clearing input and of the job's answer as received", [result?.input_sha256, result?.result_sha256], [sha256Hex(served.input), sha256Hex(JSON.stringify(served.run.output))]);
    t.eq("contract get_result: one request, no failed attempt", [result?.clear_requests, result?.clear_attempts], [1, 0]);
    const attestation = await client.getAttestation(TEE, "");
    t.eq("client getAttestation: the same two hashes", [attestation.inputHash, attestation.outputHash], [result?.input_sha256, result?.result_sha256]);
    t.eq("OutLayer holds no pending request, and the stand-in failed on none", [await w.chain.view<number[]>(w.outlayer.id, "get_pending_request_ids"), w.worker.errors], [[], []]);
  });

  await report.scenario("tee-claims", "TEE: claims relayed, claim_proceeds, every balance", ["tee-clear"], async (t) => {
    const expected = teeExpected();
    await claimAll(t, TEE, teeBids, expected, { bidder: "carol", by: "alice" });
    const want = expectedFills(expected);
    const crWant = expectedFills(crExpected());
    const spentInCr = (who: Person) => {
      const index = crBids.findIndex((p) => p.who === who);
      return index < 0 ? 0n : crWant[index].spent + crWant[index].penalty;
    };
    t.eq(
      "after both sales every bidder's USDC = 100 - what it spent - its penalties",
      await Promise.all(teeBids.map((p) => x.usdcOf(w.who[p.who].id))),
      teeBids.map((p, i) => START_USDC - spentInCr(p.who) - want[i].spent - want[i].penalty),
    );
    t.eq("after both sales the six bidders still hold exactly the 5 NEAR they started with", await Promise.all(BIDDERS.map((name) => w.chain.nearOf(w.who[name].id))), BIDDERS.map(() => 5n * NEAR));
  });

  // --------------------------------------------- TEE: the enclave fails, then works

  const RETRY = "e2e-retry";
  await report.scenario("tee-retry", "TEE: the enclave job refuses once per step; retry_setup and a second close_sale recover", ["setup"], async (t) => {
    const params: SaleParams = { saleSupply: 100n * TOKEN, floorPrice: 2_000n, minRaise: 0n, decimals: 18, maxPrice: null };
    const plans: Plan[] = [
      { who: "alice", deposit: 2n * USDC, maxPrice: 3_000n, maxSpend: 2n * USDC },
      { who: "bobby", deposit: 3n * USDC, maxPrice: 4_000n, maxSpend: 3n * USDC },
    ];
    const description = "Sale whose enclave requests each fail once.";
    const config = saleConfig(params, { tokenName: "E2E Retry", tokenSymbol: "ERTY", revealMode: "tee", maxBids: 2 }, await x.nowMs(), 300_000);

    // The key request: the job runs without its master secret and refuses, so OutLayer reports a failed run.
    w.worker.failNext();
    const created = await client.createSale(creator.id, config, meta(description), { saleId: RETRY, minStartLeadMs: START_LEAD_MS });
    const [failedKey] = await w.worker.answers("pubkey", RETRY, 1);
    t.ok("the pinned job refused the key request (missing_master)", !failedKey.run.success && /refused: missing_master/.test(failedKey.run.stderr), show(failedKey.run));
    t.eq("client createSale returns the sale in setup, its key step failed", [created.status, created.chainStatus, created.sealerKeySetup, created.tokenSetup, created.sealerPubkey], ["upcoming", "setup", "failed", "done", ""]);
    await nothingSent(t, w, "a bid on a sale without its key: refused before signing", alice, () => client.bid(RETRY, alice.id, 2n * USDC, { maxPrice: 3_000n, maxSpend: 2n * USDC }), {
      name: "FairgroundError", code: "invalid", reason: "not_open",
    });

    const near0 = await w.chain.settledNear(creator.id);
    const ready = await client.retrySetup(RETRY, creator.id);
    const spent = near0 - (await w.chain.settledNear(creator.id));
    const keys = await w.worker.answers("pubkey", RETRY, 2);
    const key = (JSON.parse(keys[1].run.output) as { pubkey: string }).pubkey;
    t.eq("client retrySetup returns the sale with its key, out of setup", [ready.chainStatus === "upcoming" || ready.chainStatus === "open", ready.sealerKeySetup, ready.sealerPubkey], [true, "done", key]);
    t.ok(`retry_setup is a wallet transaction: the caller paid gas and at most OutLayer's deposit (${nearText(spent)})`, spent > 0n && spent < OUTLAYER_COMPUTE_DEPOSIT + NEAR / 20n, nearText(spent));
    // Nothing is failed any more, so the contract refuses another retry: a transaction that lands and fails.
    const refused = await t.throws("retry_setup with nothing to retry: the transaction fails and the client passes on the contract's words", () => client.retrySetup(RETRY, creator.id), {
      name: "FairgroundError", code: "tx_failed", maybeSubmitted: false, message: "The transaction failed: nothing to retry: no setup step has failed",
    });
    t.ok("the failed transaction's hash is reported", TX_HASH.test(String(refused?.["txHash"])), show(refused?.["txHash"]));

    const view = (await x.sale(RETRY))!;
    await w.chain.advanceTo(BigInt(view.bid_start));
    for (const plan of plans) {
      const bidder = w.who[plan.who];
      await gasless(t, w, `${plan.who}'s bid`, bidder, () => client.bid(RETRY, bidder.id, plan.deposit, { maxPrice: plan.maxPrice, maxSpend: plan.maxSpend }));
    }
    await w.chain.advanceTo(BigInt(view.bid_end));

    // The clearing: the first run is refused the same way, and the sale waits for another close.
    w.worker.failNext();
    const waiting = await client.closeSale(RETRY, creator.id);
    const [failedClear] = await w.worker.answers("clear", RETRY, 1);
    t.ok("the pinned job refused the clearing (missing_master)", !failedClear.run.success && /refused: missing_master/.test(failedClear.run.stderr), show(failedClear.run));
    t.eq("client closeSale returns the sale closed, shown as still clearing", [waiting.status, waiting.chainStatus], ["clearing", "closed"]);
    const after1 = await x.result(RETRY);
    t.eq("contract get_result: one request, one failed attempt, no result", [after1?.clear_requests, after1?.clear_attempts, after1?.result_sha256], [1, 1, null]);
    t.ok("client getEvents says the enclave did not answer and the close can be repeated", (await client.getEvents(RETRY)).some((e) => e.detail === "clearing_failed"));
    t.eq("client getCloseDeposit: closing again needs the deposit again", await client.getCloseDeposit(RETRY), OUTLAYER_COMPUTE_DEPOSIT);

    const settled = await client.closeSale(RETRY, creator.id);
    t.eq("a second closeSale settles the sale", [settled.status, settled.chainStatus], ["settled", "settled"]);
    const expected = clear(params, plans.map((p): Bid => ({ bidder: w.who[p.who].id, deposit: p.deposit, maxPrice: p.maxPrice, maxSpend: p.maxSpend })));
    const { result } = await checkResult(t, w, client, RETRY, expected, "enclave");
    t.eq("contract get_result: two requests, one failed attempt", [result?.clear_requests, result?.clear_attempts], [2, 1]);
    t.eq("the stand-in failed on no request of its own", w.worker.errors, []);
  });

  // ------------------------------------------------- storage sponsorship (1Click)

  await report.scenario("storage", "storage sponsorship for a fresh account through the 1Click helper", ["setup"], async (t) => {
    // What the app does when a dev account connects (lib/wallet.tsx connectDevAccount): register its signer.
    const config = w.nearConfig();
    const devAccount = config.devAccounts.find((a) => a.accountId === fresh.id);
    if (!devAccount) throw new Error("fresh is not among the dev accounts");
    browserSigners.set(fresh.id, createDevSigner(config, devAccount));
    const app = getClient();
    t.eq("getClient() is the NEAR client for this chain (from the NEXT_PUBLIC_* values)", [app.mode, app.contractId, app.usdcContract, app.capabilities.relayer], ["near", fg, usdc, true]);
    const notices: ClientNotice[] = [];
    const unsubscribe = app.subscribeNotices((n) => void notices.push(n));

    const [near0, nonce0, relayerNear0] = [await w.chain.nearOf(fresh.id), await w.chain.nonceOf(fresh), await w.chain.settledNear(w.relayerAccount.id)];
    const first = await ensureDeliverable(fresh.id);
    t.eq("ensureDeliverable: the relayer registered the account", first.status, "sponsored");
    t.eq("the account is registered on USDC now", await w.chain.ftRegistered(usdc, fresh.id), true);
    if (first.txHash && TX_HASH.test(first.txHash)) {
      const tx = await x.tx(first.txHash, w.relayerAccount.id);
      t.eq("on chain the relayer signed the storage_deposit", [tx.transaction.signer_id, tx.transaction.receiver_id], [w.relayerAccount.id, usdc]);
    } else {
      t.ok("ensureDeliverable reports the transaction hash", false, show(first.txHash));
    }
    t.eq("it cost the account nothing: NEAR balance and nonce unchanged", [(await w.chain.nearOf(fresh.id)) - near0, (await w.chain.nonceOf(fresh)) - nonce0], [0n, 0n]);
    const relayerSpent = relayerNear0 - (await w.chain.settledNear(w.relayerAccount.id));
    t.ok(`the relayer paid the 0.00125 NEAR registration and gas (${nearText(relayerSpent)})`, relayerSpent > NEAR / 800n && relayerSpent < NEAR / 100n, nearText(relayerSpent));
    t.eq("the app was told it was free", notices.map((n) => n.kind), ["storage_sponsored"]);
    t.eq("ensureDeliverable again: already registered, nothing sent", await ensureDeliverable(fresh.id), { status: "already_registered", txHash: null });

    // The last step of the simulated swap: test USDC minted by a transaction the account's own wallet signs.
    const balances = await app.faucet(fresh.id, 7n * USDC, { key: "oneclick:e2e" });
    t.eq("the swap's delivery (faucet) lands: 7 test USDC", [balances.usdc, await x.usdcOf(fresh.id)], [7n * USDC, 7n * USDC]);
    t.ok("the mint was a wallet transaction: the account paid gas", (await w.chain.settledNear(fresh.id)) < near0);
    unsubscribe();

    await t.throws("sponsorship for an account that does not exist: the relayer refuses, the client says why", () => client.ensureUsdcStorage(`ghost.${w.root.accountId}`), {
      name: "FairgroundError", code: "relayer_refused", reason: "unknown_account", maybeSubmitted: false,
    });
  });

  // --------------------------------------------------------------- paid fallback

  const PAY = "e2e-pay";
  const payTerms = { maxPrice: 3_000n, maxSpend: 2n * USDC };
  /** A bid on the fallback sale that the user must end up paying for. */
  const paidBid = (t: Checks, label: string, bidder: Named, reason: PaidReason, via: NearClient) =>
    paid(t, w, label, bidder, reason, (onPaidFallback) => via.bid(PAY, bidder.id, 2n * USDC, payTerms, { onPaidFallback })).then(async (placed) => {
      t.eq(`${label}: the bid is in the sale`, [(await x.bid(PAY, bidder.id))?.deposit, placed.deposit], [(2n * USDC).toString(), 2n * USDC]);
    });

  await report.scenario("pay-create", "paid fallback: a commit-reveal sale to bid on", ["setup"], async (t) => {
    const params: SaleParams = { saleSupply: 1_000n * TOKEN, floorPrice: 2_000n, minRaise: 0n, decimals: 18, maxPrice: null };
    const config = saleConfig(params, { tokenName: "E2E Paid", tokenSymbol: "EPAY", revealMode: "commit_reveal", maxBids: 8, revealWindowMs: 60_000 }, await x.nowMs(), 300_000);
    await createAndOpen(t, PAY, config, "Sale for the paid-fallback scenarios.");
  });

  await report.scenario("pay-pending", "relayer answers 202 pending: the client waits for the chain", ["pay-create"], async (t) => {
    await w.stopRelayer();
    await w.startRelayer("pending", { RELAY_WAIT_MS: "0" });
    const near0 = await w.chain.nearOf(ellen.id);
    const placed = await w.client().bid(PAY, ellen.id, 2n * USDC, payTerms);
    t.ok("the bid is reported gasless and succeeded, although the relayer only said pending", placed.relay?.paidBy === "relayer" && placed.relay.status === "succeeded" && TX_HASH.test(placed.relay.txHash ?? ""), show(placed.relay));
    t.eq("the bid is in the sale and ellen paid no NEAR", [(await x.bid(PAY, ellen.id))?.deposit, (await w.chain.nearOf(ellen.id)) - near0], [(2n * USDC).toString(), 0n]);
  });

  await report.scenario("pay-no-relayer", "paid fallback: no relayer configured, and a wallet that cannot sign delegates", ["pay-create"], async (t) => {
    const without = w.client({ relayerUrl: null });
    t.eq("a client without a relayer URL says so", [without.capabilities.relayer, await without.getRelayerPolicy()], [false, null]);
    const notices: ClientNotice[] = [];
    without.subscribeNotices((n) => void notices.push(n));
    await paidBid(t, "carol's bid, no relayer", carol, "no_relayer", without);
    t.eq("the app is told before the wallet is asked", notices.map((n) => [n.kind, n.reason]), [["paid_fallback", "no_relayer"]]);

    // A wallet like MyNearWallet: it sends transactions but cannot sign NEP-366 delegates.
    const limited = w.client({
      signers: (config) => {
        const all = devSigners(config);
        const real = all.signerFor(david.id);
        if (!real) throw new Error("no dev signer for david");
        return staticSigners({ [david.id]: { signsDelegates: false, signDelegate: () => Promise.reject(new Error("this wallet cannot sign delegates")), sendTransaction: (a) => real.sendTransaction(a) } });
      },
    });
    await paidBid(t, "david's bid, wallet without delegates", david, "delegates_unsupported", limited);
  });

  await report.scenario("pay-stopped", "paid fallback: the relayer is stopped", ["pay-create"], async (t) => {
    await w.stopRelayer();
    t.eq("nothing listens on 127.0.0.1:8790", await portInUse(), false);
    const down = w.client();
    await paidBid(t, "alice's bid, relayer down", alice, "relay_failed", down);
    await paid(t, w, "bobby's bid placed for the refund-mode check, relayer down", bobby, "relay_failed", (onPaidFallback) => down.bid(PAY, bobby.id, 3n * USDC, { maxPrice: 3_000n, maxSpend: 3n * USDC }, { onPaidFallback }));
  });

  await report.scenario("pay-budget", "paid fallback: the relayer's budget is 0", ["pay-create", "storage"], async (t) => {
    await w.stopRelayer();
    await w.startRelayer("budget0", { DAILY_BUDGET_NEAR: "0", STORAGE_BUDGET_NEAR: "0" });
    const broke = w.client();
    t.ok("the relayer is up and still publishes its policy", (await broke.getRelayerPolicy()) !== null);

    // fresh holds 7 USDC from the faucet. Declining the paid transaction stops everything.
    await nothingSent(t, w, "declining the paid transaction (onPaidFallback throws): nothing is sent", fresh, () => broke.bid(PAY, fresh.id, 2n * USDC, payTerms, { onPaidFallback: () => Promise.reject(new Error("no thanks")) }), {
      name: "FairgroundError", code: "cancelled", reason: "budget_exhausted", maybeSubmitted: false,
    });
    t.eq("no bid from fresh reached the sale", await x.bid(PAY, fresh.id), null);
    await paidBid(t, "fresh's bid, budget used up", fresh, "budget_exhausted", broke);

    // Storage: the relayer cannot sponsor frank, so frank's own wallet pays the registration.
    const notices: ClientNotice[] = [];
    broke.subscribeNotices((n) => void notices.push(n));
    const told: PaidReason[] = [];
    const near0 = await w.chain.settledNear(frank.id);
    const storage = await broke.ensureUsdcStorage(frank.id, { onPaidFallback: (r) => void told.push(r) });
    const spent = near0 - (await w.chain.settledNear(frank.id));
    t.eq("storage with the budget used up: the account pays itself", [storage.status, TX_HASH.test(storage.txHash ?? ""), await w.chain.ftRegistered(usdc, frank.id)], ["paid", true, true]);
    t.eq("the app is told why, before the wallet is asked", [told, notices.map((n) => [n.kind, n.reason])], [["budget_exhausted"], [["storage_paid", "budget_exhausted"]]]);
    t.ok(`frank paid the 0.00125 NEAR registration and gas (${nearText(spent)})`, spent > NEAR / 800n && spent < NEAR / 100n, nearText(spent));
  });

  await report.scenario("refund-mode", "refund mode: nobody closes the sale, everyone gets the whole deposit back", ["pay-create", "pay-budget"], async (t) => {
    // The relayer is still the one with no budget: these calls are paid by their signers.
    const broke = w.client();
    const before = (await x.sale(PAY))!;
    await nothingSent(t, w, "trigger_refund_mode before the settle timeout: the relayer refuses it", ellen, () => broke.triggerRefundMode(PAY, ellen.id), {
      name: "FairgroundError", code: "relayer_refused", reason: "wrong_phase",
    });
    await w.chain.advanceTo(BigInt(before.refund_mode_at!));
    const failed = await paid(t, w, "trigger_refund_mode", ellen, "budget_exhausted", (onPaidFallback) => broke.triggerRefundMode(PAY, ellen.id, { onPaidFallback }));
    t.eq("the sale is failed for refunds", [failed.status, failed.chainFailReason, (await x.result(PAY))?.fail_reason], ["failed", "refund_mode", "refund_mode"]);
    const bids = await x.bids(PAY);
    const fills = await x.fills(PAY);
    t.eq("contract get_fills: every bid is owed its whole deposit, no penalty", fills.map((f) => [f.tokens, f.refund, f.penalty]), bids.map((b) => ["0", b.deposit, "0"]));
    const usdc0 = await x.usdcOf(bobby.id);
    const receipt = await paid(t, w, "bobby's refund claim", bobby, "budget_exhausted", (onPaidFallback) => broke.claim(PAY, bobby.id, { onPaidFallback }));
    t.eq("bobby got his 3 USDC back in full", [receipt.tokens, receipt.refund, (await x.usdcOf(bobby.id)) - usdc0], [0n, 3n * USDC, 3n * USDC]);
    const shown = await broke.getResult(PAY);
    t.eq("client getResult: failed by settle timeout, nothing sold, no penalty", shown && [shown.status, shown.failReason, shown.totalSold, shown.totalPenalties, shown.clearedBy], ["failed", "settle_timeout", 0n, 0n, "none"]);
  });

  // ------------------------------------------------------------------- teardown

  await report.scenario("teardown", "teardown: relayer stopped, container removed", [], async (t) => {
    await w.worker.stop();
    t.eq("the OutLayer stand-in answered every request it saw", w.worker.errors, []);
    await w.stopRelayer();
    for (let i = 0; i < 20 && (await portInUse()); i++) await sleep(250);
    t.eq("nothing listens on 127.0.0.1:8790 any more", await portInUse(), false);
    t.ok("docker removed the near-sandbox-web container", removeSandbox() && !sandboxExists());
  });
}

/** From OutLayer's own record of a request: who asked, who pays, which module (by sha256), the answer format and the limits. */
function requestFacts(request: Record<string, unknown>): unknown[] {
  const source = request["execution_source"] as { WasmUrl?: { hash?: string } } | undefined;
  const limits = request["resource_limits"] as { max_instructions?: number; max_execution_seconds?: number } | undefined;
  return [request["sender_id"], request["payer_account_id"], source?.WasmUrl?.hash, request["response_format"], limits?.max_instructions, limits?.max_execution_seconds];
}

/**
 * create_sale's params for a sale (contracts/fairground/src/sale.rs
 * CreateSaleParams), written out independently of the client, to ask the
 * contract what creating it costs. The cost does not depend on the times, so
 * the window simply starts an hour after `nowNs`.
 */
function rawCreateParams(saleId: string, config: SaleConfig, description: string, nowNs: bigint): Record<string, unknown> {
  const start = nowNs + 3_600n * 1_000_000_000n;
  return {
    sale_id: saleId,
    token_name: config.tokenName,
    token_symbol: config.tokenSymbol,
    decimals: config.decimals,
    total_supply: config.totalSupply.toString(),
    sale_supply: config.saleSupply.toString(),
    floor_price: config.floorPrice.toString(),
    max_price: config.maxPrice === null ? null : config.maxPrice.toString(),
    min_raise: config.minRaise.toString(),
    bid_start: start.toString(),
    bid_end: (start + BigInt(config.bidEnd - config.bidStart) * MS).toString(),
    min_deposit: config.minDeposit.toString(),
    max_deposit_per_account: config.maxDepositPerAccount.toString(),
    max_bids: config.maxBids,
    reveal_mode: config.revealMode === "tee" ? "Tee" : "CommitReveal",
    ...(config.revealWindowMs === undefined ? {} : { reveal_window: (BigInt(config.revealWindowMs) * MS).toString() }),
    settle_timeout: (BigInt(config.settleTimeoutMs) * MS).toString(),
    quote_token: config.quoteToken,
    description,
    website: "https://example.com/e2e",
  };
}
