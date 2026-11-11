/**
 * The live bot against a local chain, end to end:
 *
 *   pnpm --filter web exec tsx scripts/live-bot/sandbox-test.ts      (from anywhere in the repo)
 *
 * It builds the world of the sandbox end-to-end harness (scripts/e2e/world.ts:
 * the nearcore sandbox in the Docker container near-sandbox-web on
 * 127.0.0.1:3050, the real Sealround contract, OutLayer's real contract with
 * the stand-in worker running the pinned enclave job, and the real relayer on
 * 127.0.0.1:8790), then runs the bot's CLI (run.ts) against it the way the
 * owner runs it on testnet: as its own process, configured by flags, with the
 * bot's key in LIVE_BOT_PRIVATE_KEY.
 *
 * Sealed-bid (TEE) sale: the bot snipes the open, three people bid after it,
 * two copycats replay sealed bids (one from an account id of the victim's
 * length, which the contract accepts and the enclave voids; one from a longer
 * id, which the contract refuses), the creator closes, the enclave clears,
 * and `report` must show the bot paying exactly the clearing price of the
 * reference clearing, to the smallest unit. Commit-reveal sale: the same
 * snipe, a copied commitment, the bot's `reveal`, clear_onchain, `report`.
 * The bot's refusals are checked too: wrong network, mainnet without
 * confirmation, missing or wrong key, unknown sale, second bid, report before
 * settlement, closed sale, a key passed as a flag.
 *
 * It refuses to start while near-sandbox-web exists or port 8790 is taken
 * (the e2e run uses both), and always removes its container and stops its
 * relayer, also when a check fails or the run is interrupted. Logs and the
 * bot's receipts go to scripts/live-bot/.run/sandbox-test (git-ignored).
 * Nothing here touches a public network.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clear, costOf, type Bid, type SaleParams } from "@fairground/clearing";
import { teraToGas } from "near-api-js";
import type { BidView, ResultView, SaleView } from "../../src/lib/near/views";
import type { SaleConfig, SaleMeta } from "../../src/lib/types";
import { removeSandbox, SANDBOX_NAME, SANDBOX_PORT, sandboxExists, WEB_DIR, type Named } from "../e2e/chain";
import { portInUse, RELAYER_PORT, RELAYER_URL, stopLeftoverRelayer } from "../e2e/relayer";
import { Report, show, type Checks } from "../e2e/report";
import { buildWorld, USDC, type World } from "../e2e/world";
import type { CopycatResult, ReportResult, SnipeResult } from "./bot";
import { renderCopycat, renderReport, renderSnipe } from "./render";

const HERE = typeof __dirname === "string" ? __dirname : path.resolve("scripts/live-bot");
const RUN_DIR = path.join(HERE, ".run", "sandbox-test");
const RECEIPTS = path.join(RUN_DIR, "receipts");
const PID_FILE = path.join(RUN_DIR, "relayer.pid");
const RUN_TS = path.join(HERE, "run.ts");
const TOKEN = 10n ** 18n;
const MS = 1_000_000n;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** How far ahead of the chain clock each sale opens: time for the bot to start and wait. */
const LEAD_MS = 25_000;
/** USDC minted to each bot account. */
const BOT_USDC = 20n * USDC;

type BotRun = { code: number; stdout: string; stderr: string; json: Record<string, unknown> | null };

/** The environment of a bot process: this one's, without anything the bot or the app would read. */
function baseEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !/^(LIVE_BOT_|NEXT_PUBLIC_)/.test(e[0])));
}

/** Runs the bot CLI as its own process (tsx, like `pnpm live-bot`) and prints its progress lines as they come. */
function runBot(args: string[], key: Named | null, print = false): Promise<BotRun> {
  const env = { ...baseEnv(), ...(key ? { LIVE_BOT_PRIVATE_KEY: key.secret } : {}) } as NodeJS.ProcessEnv;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, RUN_TS, ...args], { cwd: WEB_DIR, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      stderr += text;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) console.log(`      bot| ${line.trimEnd()}`);
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (pending.trim()) console.log(`      bot| ${pending.trimEnd()}`);
      if (print) for (const line of stdout.trimEnd().split("\n")) console.log(`      ${line}`);
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        // text output
      }
      resolve({ code: code ?? 1, stdout, stderr, json });
    });
  });
}

const indent = (text: string) => text.split("\n").map((l) => `      ${l}`).join("\n");

let world: World | null = null;
let cleaned = false;

async function cleanup(): Promise<string[]> {
  if (cleaned) return [];
  cleaned = true;
  const problems: string[] = [];
  await world?.worker.stop().catch(() => {});
  await world?.stopRelayer().catch((e: unknown) => problems.push(`stopping the relayer: ${e instanceof Error ? e.message : String(e)}`));
  if (!(await stopLeftoverRelayer(PID_FILE))) problems.push(`port ${RELAYER_PORT} is still in use`);
  if (world && !removeSandbox()) problems.push(`could not remove the ${SANDBOX_NAME} container`);
  return problems;
}

async function scenarios(w: World, report: Report): Promise<void> {
  const fg = w.fairground.id;
  const usdc = w.usdc.id;
  const { creator, alice, bobby, carol, ellen } = w.who;
  const app = w.client();
  const view = {
    sale: async (id: string) => (await w.chain.view<SaleView | null>(fg, "get_sale", { sale_id: id }))!,
    bid: (id: string, bidder: string) => w.chain.view<BidView | null>(fg, "get_bid", { sale_id: id, bidder }),
    result: (id: string) => w.chain.view<ResultView | null>(fg, "get_result", { sale_id: id }),
    usdc: (account: string) => w.chain.ft(usdc, account),
  };
  const common = (saleId: string) => ["--network", "sandbox", "--rpc", w.chain.rpcUrl, "--contract", fg, "--sale", saleId, "--relayer", RELAYER_URL, "--receipt-dir", RECEIPTS, "--max-wait", "240"];
  const meta = (description: string): SaleMeta => ({ description, hue: 0, website: "https://example.com/live-bot" });
  const saleConfig = async (p: SaleParams, o: Pick<SaleConfig, "tokenName" | "tokenSymbol" | "revealMode" | "maxBids"> & Partial<SaleConfig>): Promise<SaleConfig> => {
    const now = Number((await w.chain.nowNs()) / MS);
    return {
      decimals: 18,
      totalSupply: 1_000n * TOKEN,
      saleSupply: p.saleSupply,
      creatorAllocation: 1_000n * TOKEN - p.saleSupply,
      lpReserve: 0n,
      floorPrice: p.floorPrice,
      maxPrice: p.maxPrice ?? null,
      minRaise: p.minRaise,
      bidStart: now,
      bidEnd: now + 300_000,
      minDeposit: USDC,
      maxDepositPerAccount: 10n * USDC,
      unsoldRule: "burn",
      settleTimeoutMs: 600_000,
      quoteToken: usdc,
      ...o,
    };
  };
  /** A refusal of the bot: exit code 2, the JSON error code, and nothing sent (the key's nonce did not move). */
  const refused = async (t: Checks, label: string, args: string[], key: Named | null, code: string, watch: Named | null = key) => {
    const nonce0 = watch ? await w.chain.nonceOf(watch) : 0n;
    const run = await runBot([...args, "--json"], key);
    const error = (run.json?.["error"] ?? {}) as { code?: string; message?: string };
    t.ok(`${label}: refused with exit code 2 and "${code}"`, run.code === 2 && error.code === code, `exit ${run.code}, ${show(run.json ?? run.stderr.slice(-300))}`);
    if (watch) t.eq(`${label}: nothing was signed (${watch.id}'s key nonce unchanged)`, await w.chain.nonceOf(watch), nonce0);
    console.log(`      -> ${error.message ?? "(no message)"}`);
  };

  // Three bot accounts: a sniper, and two copycats. "mimic" has alice's id length, "copycat" a longer one.
  let sniper!: Named;
  let mimic!: Named;
  let copycat!: Named;

  await report.scenario("setup", "setup: the e2e world, three bot accounts with test USDC, the relayer", [], async (t) => {
    sniper = await w.chain.createAccount(w.root, "sniper", 5);
    mimic = await w.chain.createAccount(w.root, "mimic", 5);
    copycat = await w.chain.createAccount(w.root, "copycat", 5);
    for (const bot of [sniper, mimic, copycat]) {
      await w.root.callFunction({ contractId: usdc, methodName: "mint", args: { account_id: bot.id, amount: BOT_USDC.toString() }, gas: teraToGas(30) });
      t.eq(`${bot.id} holds 20 test USDC`, await view.usdc(bot.id), BOT_USDC);
    }
    t.eq("mimic's account id is as long as alice's, copycat's is not", [mimic.id.length === alice.id.length, copycat.id.length === alice.id.length], [true, false]);
    await w.startRelayer("live-bot");
    t.ok("the relayer answers", await portInUse(RELAYER_PORT));
  });

  // -------------------------------------------------------------- sealed-bid sale

  const TEE = "bot-tee";
  const teeParams: SaleParams = { saleSupply: 500n * TOKEN, floorPrice: 2_000n, minRaise: USDC, decimals: 18, maxPrice: null };
  /** The bot's terms: ready to pay up to 0.02 USDC a token, with 2 of its 5 USDC. */
  const snipeTerms = { deposit: "5", maxPrice: "0.02", maxSpend: "2" };
  const people = [
    { who: alice, deposit: 3n * USDC, maxPrice: 6_000n, maxSpend: 3n * USDC },
    { who: bobby, deposit: 3n * USDC, maxPrice: 5_000n, maxSpend: 3n * USDC },
    { who: carol, deposit: 2_500_000n, maxPrice: 4_000n, maxSpend: 2_500_000n },
  ];
  await report.scenario("tee-snipe", "TEE: the bot waits for the open and bids in the first block it can", ["setup"], async (t) => {
    const config = await saleConfig(teeParams, { tokenName: "Bot Sealed", tokenSymbol: "BOTS", revealMode: "tee", maxBids: 8 });
    const sale = await app.createSale(creator.id, config, meta("Sealed-bid sale for the live bot test."), { saleId: TEE, minStartLeadMs: LEAD_MS });
    t.eq("the sale is created with its key and is not open yet", [sale.sealerKeySetup, sale.chainStatus], ["done", "upcoming"]);
    const near0 = await w.chain.nearOf(sniper.id);
    const run = await runBot(["snipe", ...common(TEE), "--account", sniper.id, "--deposit", snipeTerms.deposit, "--max-price", snipeTerms.maxPrice, "--max-spend", snipeTerms.maxSpend, "--json"], sniper);
    t.eq("snipe exits 0", run.code, 0);
    const r = run.json as SnipeResult | null;
    if (!r?.ok) throw new Error(`snipe failed: ${show(run.json ?? run.stderr.slice(-500))}`);
    console.log(indent(renderSnipe(r)));
    const onChain = await view.bid(TEE, sniper.id);
    const start = BigInt((await view.sale(TEE)).bid_start);
    t.eq("the bot's bid is the first of the sale (index 0)", [r.index, onChain?.index], [0, 0]);
    t.ok("it landed at or after bid_start, within 3 s of it (chain clock)", BigInt(onChain!.placed_at) >= start && r.landedAfterMs >= 0 && r.landedAfterMs < 3_000, `${r.landedAfterMs} ms`);
    t.eq("the reported landing time is placed_at - bid_start", BigInt(r.placedAtNs) - start, BigInt(onChain!.placed_at) - start);
    t.ok("it reports the transaction hash, and the relayer paid", TX_HASH.test(r.txHash ?? "") && r.paidBy === "relayer", show([r.txHash, r.paidBy]));
    const tx = await w.chain.rpc<{ transaction: { signer_id: string; receiver_id: string } }>("tx", { tx_hash: r.txHash, sender_account_id: w.relayerAccount.id, wait_until: "EXECUTED_OPTIMISTIC" });
    t.eq("on chain the relayer signed it, carrying the bot's delegate", [tx.transaction.signer_id, tx.transaction.receiver_id], [w.relayerAccount.id, sniper.id]);
    t.eq("the bot paid no NEAR", (await w.chain.nearOf(sniper.id)) - near0, 0n);
    t.eq("5 USDC left the bot", BOT_USDC - (await view.usdc(sniper.id)), 5n * USDC);
    t.ok("it reports the block that took the bid, after the first open block it saw", r.bidBlock !== null && r.bidBlock >= r.openBlock, show([r.openBlock, r.bidBlock]));
  });

  await report.scenario("tee-people", "TEE: three people bid after the bot, through the web app's client", ["tee-snipe"], async (t) => {
    for (const p of people) {
      const placed = await app.bid(TEE, p.who.id, p.deposit, { maxPrice: p.maxPrice, maxSpend: p.maxSpend });
      t.ok(`${p.who.id} bid #${placed.index}`, placed.index > 0);
    }
  });

  let copiedIndex = -1;
  await report.scenario("tee-copycat", "TEE: two copycats replay sealed bids from the chain", ["tee-people"], async (t) => {
    // Same id length as alice: the contract cannot tell the copy from a bid.
    const same = await runBot(["copycat", ...common(TEE), "--account", mimic.id, "--victim", alice.id, "--json"], mimic);
    const a = same.json as CopycatResult | null;
    t.eq("copycat (mimic copies alice) exits 0", same.code, 0);
    if (a?.ok) console.log(indent(renderCopycat(a)));
    t.eq("the copy is accepted on chain, to be voided at clearing", [a?.outcome, a?.payloadBytes, a?.expectedBytes], ["accepted_void_at_clearing", a?.expectedBytes, 224 + TEE.length + mimic.id.length]);
    const copied = await view.bid(TEE, mimic.id);
    const original = await view.bid(TEE, alice.id);
    t.ok("on chain mimic's bid is alice's sealed bid byte for byte", copied !== null && copied.payload === original?.payload);
    copiedIndex = copied?.index ?? -1;

    // A longer id: the copy has the wrong length for its sender.
    const usdc0 = await view.usdc(copycat.id);
    const near0 = await w.chain.nearOf(copycat.id);
    const other = await runBot(["copycat", ...common(TEE), "--account", copycat.id, "--victim", bobby.id, "--json"], copycat);
    const b = other.json as CopycatResult | null;
    t.eq("copycat (copycat copies bobby) exits 0", other.code, 0);
    if (b?.ok) console.log(indent(renderCopycat(b)));
    t.eq("the contract rejected it: bid_rejected wrong_ciphertext_length", [b?.outcome, b?.reason], ["rejected_on_chain", "wrong_ciphertext_length"]);
    t.ok("the app refused it before signing, and the relayer refused to pay for it", !!b?.appRefusal && !!b.relayerRefusal && !b.relayerRefusal.startsWith("relayed"), show([b?.appRefusal, b?.relayerRefusal]));
    t.ok("the rejecting transaction is on chain, signed by the copycat", TX_HASH.test(b?.txHash ?? "") && b?.paidBy === "user", show(b?.txHash));
    t.eq("the contract holds no bid from copycat, and its deposit came back in full", [await view.bid(TEE, copycat.id), await view.usdc(copycat.id)], [null, usdc0]);
    t.ok("copycat paid only gas for the attempt", (await w.chain.settledNear(copycat.id)) < near0);
  });

  await report.scenario("refusals", "the bot's refusals: wrong network, mainnet, keys, unknown sale, second bid, early report", ["tee-snipe"], async (t) => {
    const args = (saleId = TEE) => common(saleId);
    await refused(t, "status --network testnet against the sandbox RPC", ["status", ...args().map((a) => (a === "sandbox" ? "testnet" : a))], null, "wrong_network");
    await refused(t, "status --network mainnet without --yes-mainnet", ["status", ...args().map((a) => (a === "sandbox" ? "mainnet" : a))], null, "mainnet_not_confirmed");
    await refused(t, "snipe without LIVE_BOT_PRIVATE_KEY", ["snipe", ...args(), "--account", ellen.id, "--deposit", "2", "--max-price", "0.01"], null, "missing_key", ellen);
    await refused(t, "snipe for ellen with the sniper's key", ["snipe", ...args(), "--account", ellen.id, "--deposit", "2", "--max-price", "0.01"], sniper, "key_mismatch", ellen);
    await refused(t, "status for a sale that does not exist", ["status", ...args("no-such-sale")], null, "sale_not_found");
    await refused(t, "a second snipe from the sniper", ["snipe", ...args(), "--account", sniper.id, "--deposit", "2", "--max-price", "0.01"], sniper, "already_bid");
    await refused(t, "report before the sale settles", ["report", ...args(), "--account", sniper.id], null, "not_settled");
    await refused(t, "the key as a flag", ["status", ...args(), "--private-key=ed25519:abc"], null, "usage");
    await refused(t, "a void bid (max spend above the deposit)", ["snipe", ...args(), "--account", ellen.id, "--deposit", "2", "--max-spend", "3", "--max-price", "0.01"], ellen, "invalid_terms");
  });

  /** The reference clearing of the TEE sale: mimic's copy is a mismatch, copycat's never got in. */
  const teeExpected = () =>
    clear(teeParams, [
      { bidder: sniper.id, deposit: 5n * USDC, maxPrice: 20_000n, maxSpend: 2n * USDC },
      ...people.map((p): Bid => ({ bidder: p.who.id, deposit: p.deposit, maxPrice: p.maxPrice, maxSpend: p.maxSpend })),
      { bidder: mimic.id, deposit: USDC, maxPrice: 6_000n, maxSpend: 3n * USDC, mismatch: true },
    ]);

  await report.scenario("tee-close", "TEE: the creator closes, the pinned enclave job clears", ["tee-copycat"], async (t) => {
    await w.chain.advanceTo(BigInt((await view.sale(TEE)).bid_end));
    const closed = await app.closeSale(TEE, creator.id);
    t.eq("the sale is settled", closed.chainStatus, "settled");
    const served = await w.worker.last("clear", TEE);
    const output = JSON.parse(served.run.output) as { clearing_price: string; invalid: number[] };
    t.eq("the enclave found exactly one invalid bid: mimic's copy", output.invalid, [copiedIndex]);
    const expected = teeExpected();
    t.eq("the contract's clearing price = the reference clearing", (await view.result(TEE))?.clearing_price, expected.clearingPrice.toString());
    await refused(t, "snipe on the closed sale", ["snipe", ...common(TEE), "--account", copycat.id, "--deposit", "2", "--max-price", "0.01"], copycat, "sale_closed");
  });

  await report.scenario("tee-report", "TEE: report proves the bot paid exactly the clearing price; claims", ["tee-close"], async (t) => {
    const expected = teeExpected();
    const P = expected.clearingPrice;
    const want = expected.fills[0];
    console.log(`      reference clearing: price ${P}, the bot gets ${want.tokens} token base units for ${want.spent} USDC base units`);
    const usdc0 = await view.usdc(sniper.id);
    const text = await runBot(["report", ...common(TEE), "--account", sniper.id, "--claim"], sniper, true);
    t.eq("report --claim (text) exits 0", text.code, 0);
    t.ok("its text says PASS", /RESULT: PASS/.test(text.stdout));
    const run = await runBot(["report", ...common(TEE), "--account", sniper.id, "--json"], null);
    const r = run.json as ReportResult | null;
    t.eq("report --json exits 0, every check passed", [run.code, r?.ok, r?.checks.filter((c) => !c.ok)], [0, true, []]);
    if (!r) throw new Error(`report failed: ${run.stderr.slice(-500)}`);
    t.eq("report: clearing price = reference clearing", r.clearingPrice, P.toString());
    t.eq("report: the bot's tokens and spend = reference clearing", [r.fill.tokens, r.fill.spent, r.fill.refund], [want.tokens.toString(), want.spent.toString(), (want.deposit - want.spent).toString()]);
    t.eq("the bot's spend = ceil(tokens x P / 10^18), to the base unit", BigInt(r.fill.spent), costOf(want.tokens, P, TOKEN));
    t.ok("the bot bid far above the clearing price and paid only the clearing price", BigInt(r.botMaxPrice ?? "0") === 20_000n && P < 20_000n, show([r.botMaxPrice, P]));
    t.eq("every winner paid by the same rule", [r.winnersPayingClearingPrice, r.winners], [r.winners, expected.fills.filter((f) => f.tokens > 0n).length]);
    const token = (await view.sale(TEE)).token;
    t.eq("after the claim the bot holds its tokens and its refund", [await w.chain.ft(token, sniper.id), (await view.usdc(sniper.id)) - usdc0], [want.tokens, want.deposit - want.spent]);
    t.eq("the bot's fill is marked claimed", r.fill.claimed, true);

    const void_ = await runBot(["report", ...common(TEE), "--account", mimic.id, "--claim", "--json"], mimic);
    const m = void_.json as ReportResult | null;
    if (m) console.log(indent(renderReport(m)));
    t.eq("report for mimic: the copy won nothing and paid the 1 % penalty", [void_.code, m?.ok, m?.fill.valid, m?.fill.tokens, m?.fill.penalty, m?.copiedFrom], [0, true, false, "0", "10000", alice.id]);
    t.eq("mimic claimed back 0.99 USDC of its 1 USDC deposit", [m?.claim?.usdcReceived, await view.usdc(mimic.id)], ["990000", BOT_USDC - 10_000n]);
  });

  // ------------------------------------------------------------ commit-reveal sale

  const CR = "bot-cr";
  const crParams: SaleParams = { saleSupply: 500n * TOKEN, floorPrice: 2_000n, minRaise: USDC, decimals: 18, maxPrice: null };
  const crAlice = { deposit: 3n * USDC, maxPrice: 3_000n, maxSpend: 3n * USDC };

  await report.scenario("cr-sale", "commit-reveal: snipe, a copied commitment, the bot's reveal, clear_onchain, report", ["setup"], async (t) => {
    const config = await saleConfig(crParams, { tokenName: "Bot Commit", tokenSymbol: "BOTC", revealMode: "commit_reveal", maxBids: 6, revealWindowMs: 60_000 });
    await app.createSale(creator.id, config, meta("Commit-reveal sale for the live bot test."), { saleId: CR, minStartLeadMs: LEAD_MS });
    const snipeRun = await runBot(["snipe", ...common(CR), "--account", sniper.id, "--deposit", "4", "--max-price", "0.01", "--max-spend", "2", "--json"], sniper);
    const s = snipeRun.json as SnipeResult | null;
    t.ok("snipe on a commit-reveal sale: bid #0, landed within 3 s of the open", snipeRun.code === 0 && s?.index === 0 && s.landedAfterMs >= 0 && s.landedAfterMs < 3_000, show(s ?? snipeRun.stderr.slice(-300)));
    await app.bid(CR, alice.id, crAlice.deposit, { maxPrice: crAlice.maxPrice, maxSpend: crAlice.maxSpend });
    const copy = await runBot(["copycat", ...common(CR), "--account", mimic.id, "--victim", alice.id, "--json"], mimic);
    const c = copy.json as CopycatResult | null;
    if (c?.ok) console.log(indent(renderCopycat(c)));
    t.eq("the copied commitment is accepted, and can never be revealed by mimic", [copy.code, c?.outcome], [0, "accepted_cannot_reveal"]);

    await w.chain.advanceTo(BigInt((await view.sale(CR)).bid_end));
    await app.closeSale(CR, creator.id);
    const rev = await runBot(["reveal", ...common(CR), "--account", sniper.id, "--json"], sniper);
    t.ok("reveal: the bot revealed its bid from its receipt, gasless", rev.code === 0 && rev.json?.["paidBy"] === "relayer" && (await view.bid(CR, sniper.id))?.revealed === true, show(rev.json ?? rev.stderr.slice(-300)));
    await app.revealBid(CR, alice.id);
    await w.chain.advanceTo(BigInt((await view.sale(CR)).reveal_end!));
    await app.clearOnchain(CR, ellen.id);

    const expected = clear(crParams, [
      { bidder: sniper.id, deposit: 4n * USDC, maxPrice: 10_000n, maxSpend: 2n * USDC },
      { bidder: alice.id, deposit: crAlice.deposit, maxPrice: crAlice.maxPrice, maxSpend: crAlice.maxSpend },
      { bidder: mimic.id, deposit: USDC, maxPrice: null, maxSpend: null },
    ]);
    const run = await runBot(["report", ...common(CR), "--account", sniper.id, "--json"], null);
    const r = run.json as ReportResult | null;
    if (r) console.log(indent(renderReport(r)));
    t.eq("report: every check passed; the price and the bot's fill = reference clearing", [run.code, r?.ok, r?.clearingPrice, r?.fill.tokens, r?.fill.spent], [0, true, expected.clearingPrice.toString(), expected.fills[0].tokens.toString(), expected.fills[0].spent.toString()]);
    const m = await runBot(["report", ...common(CR), "--account", mimic.id, "--json"], null);
    const mr = m.json as ReportResult | null;
    t.eq("report for mimic: unrevealed copy, void, 1 % penalty", [m.code, mr?.fill.valid, mr?.fill.tokens, mr?.fill.penalty], [0, false, "0", "10000"]);
  });
}

async function main(): Promise<number> {
  const started = Date.now();
  console.log(`Sealround live bot, on a local chain (${SANDBOX_NAME} on 127.0.0.1:${SANDBOX_PORT}, relayer on 127.0.0.1:${RELAYER_PORT})\n`);
  if (sandboxExists()) {
    console.error(`The container ${SANDBOX_NAME} exists: the e2e run (pnpm --filter web e2e:sandbox) or an earlier test is using it. This test does not touch it; run again when it is gone.`);
    cleaned = true;
    return 2;
  }
  if (!(await stopLeftoverRelayer(PID_FILE))) {
    console.error(`Port ${RELAYER_PORT} is in use by a process this test did not start (the e2e run's relayer?). Run again when it is free.`);
    cleaned = true;
    return 2;
  }
  rmSync(RUN_DIR, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(RUN_DIR, { recursive: true });

  const report = new Report();
  try {
    world = await buildWorld(RUN_DIR, (line) => console.log(line));
    await scenarios(world, report);
  } catch (e) {
    console.error(`\nThe run could not be set up: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
  const problems = await cleanup();
  console.log(`\n${"=".repeat(100)}\n`);
  console.log(report.scenarios.length > 0 ? report.table() : "No scenario ran.");
  for (const problem of problems) console.log(`TEARDOWN PROBLEM: ${problem}`);
  console.log(`\nTook ${((Date.now() - started) / 1000).toFixed(0)} s. Logs and receipts: ${RUN_DIR}`);
  writeFileSync(path.join(RUN_DIR, "report.json"), JSON.stringify({ passed: report.allPassed && problems.length === 0, scenarios: report.scenarios, teardown: problems }, null, 2));
  return report.allPassed && problems.length === 0 ? 0 : 1;
}

/** Ends with `code` once the event loop is empty; process.exit() is only the fallback (see run.ts). */
function exit(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 15_000).unref();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
  process.on(signal, () => {
    console.error(`\n${signal}: stopping the relayer and removing the container`);
    void cleanup().finally(() => process.exit(130));
  });
}

main().then(exit, async (e: unknown) => {
  console.error(e);
  await cleanup();
  exit(1);
});
