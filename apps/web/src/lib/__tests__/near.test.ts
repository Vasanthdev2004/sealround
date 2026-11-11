/**
 * The NEAR client against a fake chain, a fake relayer and fake signers:
 * view translation, gasless and paid writes, every way a relay can end, and
 * the rule that a call which may have landed is never sent twice.
 */
import {
  RelayerError,
  bidAction,
  claimAction,
  claimProceedsAction,
  clearOnchainAction,
  revealAction,
  triggerRefundModeAction,
  type ActionSigner,
  type FairgroundAction,
  type RelayerClient,
} from "@fairground/relayer-client";
import { describe, expect, it, vi } from "vitest";
import { getBidSecret } from "../bid-secrets";
import { FairgroundError, PAID_REASON_MESSAGES, RELAYER_REFUSAL_MESSAGES } from "../client/errors";
import { NearClient, type NearClientOptions } from "../client/near";
import { OUTLAYER_COMPUTE_DEPOSIT, TOKEN_STORAGE_DEPOSIT } from "../client/rules";
import type { NearConfig } from "../config";
import { bidCommitment, fromB64, fromHex, newSaleKeypair, sealBid, sealedBidLen, toB64 } from "../crypto";
import type { NearRpc } from "../near/rpc";
import { staticSigners } from "../near/signers";
import {
  createSaleParams,
  eventsFromViews,
  foldStatus,
  msToNs,
  nsToMs,
  proceedsLeft,
  resultFromViews,
  retrySetupDeposit,
  saleFromView,
  type BidView,
  type FillView,
  type ResultView,
  type SaleView,
} from "../near/views";
import type { ClientNotice, PaidReason, SaleConfig } from "../types";

const CONTRACT = "fairground.test.near";
const USDC_ID = "usdc.test.near";
const USDC = 1_000_000n;
const TOKEN = 10n ** 18n;
const TGAS = 1_000_000_000_000n;
const NOW = 1_800_000_000_000; // ms
const ns = (ms: number) => msToNs(ms);

const CONFIG: NearConfig = {
  network: "sandbox",
  rpcUrl: "http://127.0.0.1:3050",
  contractId: CONTRACT,
  usdcContract: USDC_ID,
  relayerUrl: "http://127.0.0.1:8790",
  devAccounts: [],
  expectedCodeHash: "ab".repeat(32),
  explorerUrl: null,
};

function saleView(over: Partial<SaleView> = {}): SaleView {
  return {
    sale_id: "fairt",
    status: "open",
    creator: "maker.test.near",
    token: `fairt.${CONTRACT}`,
    quote_token: USDC_ID,
    token_name: "Fair Test",
    token_symbol: "FAIRT",
    decimals: 18,
    icon: null,
    description: "The reference sale.",
    website: null,
    total_supply: (1_000_000n * TOKEN).toString(),
    sale_supply: (600_000n * TOKEN).toString(),
    creator_allocation: (400_000n * TOKEN).toString(),
    floor_price: "1000",
    max_price: null,
    min_raise: (50n * USDC).toString(),
    bid_start: ns(NOW - 60_000),
    bid_end: ns(NOW + 60_000),
    min_deposit: USDC.toString(),
    max_deposit_per_account: (10n * USDC).toString(),
    max_bids: 100,
    reveal_mode: "Tee",
    reveal_window: null,
    reveal_end: null,
    settle_timeout: ns(7_200_000),
    refund_mode_at: ns(NOW + 60_000 + 7_200_000),
    unsold_rule: "Burn",
    sealer_code_hash: "ab".repeat(32),
    sealer_pubkey: "cd".repeat(32),
    token_setup: "done",
    sealer_key_setup: "done",
    created_at: ns(NOW - 3_600_000),
    closed_at: null,
    bid_count: 0,
    total_deposits: "0",
    bid_set_hash: "11".repeat(32),
    ...over,
  };
}

function resultView(over: Partial<ResultView> = {}): ResultView {
  return {
    sale_id: "fairt",
    status: "open",
    fail_reason: null,
    clearing_price: "0",
    total_sold: "0",
    total_raised: "0",
    unsold: "0",
    n_valid: 0,
    n_invalid: 0,
    n_winners: 0,
    failed_checks: [],
    failed_checks_total: 0,
    result_sha256: null,
    input_sha256: null,
    clear_requests: 0,
    clear_attempts: 0,
    total_penalties: "0",
    proceeds: { raise_paid: false, allocation_paid: false, unsold_burned: false, reserve_returned: false },
    ...over,
  };
}

const bidView = (index: number, bidder: string, deposit: bigint, over: Partial<BidView> = {}): BidView => ({
  index,
  bidder,
  deposit: deposit.toString(),
  payload: toB64(new Uint8Array(sealedBidLen("fairt", bidder)).fill(index + 1)),
  placed_at: ns(NOW - 30_000 + index * 1000),
  revealed: false,
  claimed: false,
  ...over,
});

/** An RPC final outcome the way a wallet returns it, with Fairground's events. */
function outcome(hash: string, events: { event: string; data: unknown }[] = [], failure?: unknown) {
  const logs = events.map((e) => `EVENT_JSON:${JSON.stringify({ standard: "fairground", version: "1.0.0", ...e })}`);
  return {
    transaction: { hash },
    transaction_outcome: { id: hash, outcome: { executor_id: "someone.test.near", status: { SuccessReceiptId: "r1" }, logs: [] } },
    receipts_outcome: [
      {
        id: "r1",
        outcome: { executor_id: CONTRACT, status: failure === undefined ? { SuccessValue: "" } : { Failure: failure }, logs },
      },
    ],
  };
}

/** A small chain: the views the client reads, changed by the test as "transactions" land. */
function harness(opts: { signsDelegates?: boolean; relayer?: boolean; cacheMs?: number; accounts?: string[]; sale?: Partial<SaleView> } = {}) {
  const chain = {
    sales: new Map<string, SaleView>([["fairt", saleView(opts.sale)]]),
    bids: new Map<string, BidView[]>([["fairt", []]]),
    results: new Map<string, ResultView>([["fairt", resultView()]]),
    fills: new Map<string, FillView[]>(),
    usdc: new Map<string, bigint>([["alice.test.near", 100n * USDC]]),
    registered: new Set<string>(["alice.test.near"]),
    createCost: "5000000000000000000000000",
    closeDeposit: OUTLAYER_COMPUTE_DEPOSIT.toString(),
    /** get_reserve_refund: NEAR claim_proceeds would return to the creator now. */
    reserveRefund: "0",
    createError: null as string | null,
  };
  const views: { contract: string; method: string; args: Record<string, unknown> }[] = [];
  const rpc: NearRpc = {
    async view<T>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
      views.push({ contract, method, args });
      const id = String(args.sale_id ?? "");
      const page = <X>(list: X[]) => list.slice(Number(args.from_index ?? 0), Number(args.from_index ?? 0) + Number(args.limit ?? 50));
      const answer = (): unknown => {
        if (contract === USDC_ID) {
          const account = String(args.account_id);
          if (method === "ft_balance_of") return (chain.usdc.get(account) ?? 0n).toString();
          if (method === "storage_balance_of") return chain.registered.has(account) ? { total: "1250000000000000000000", available: "0" } : null;
        }
        if (contract === CONTRACT) {
          if (method === "get_sale") return chain.sales.get(id) ?? null;
          if (method === "get_sales") return page([...chain.sales.values()]);
          if (method === "get_bids") return page(chain.bids.get(id) ?? []);
          if (method === "get_bid") return (chain.bids.get(id) ?? []).find((b) => b.bidder === args.bidder) ?? null;
          if (method === "get_result") return chain.results.get(id) ?? null;
          if (method === "get_fills") return page(chain.fills.get(id) ?? []);
          if (method === "get_close_deposit") return chain.closeDeposit;
          if (method === "get_reserve_refund") return chain.reserveRefund;
          if (method === "get_create_cost") {
            if (chain.createError) throw new FairgroundError("rpc_error", chain.createError, { reason: "view_failed" });
            return chain.createCost;
          }
        }
        throw new Error(`unexpected view ${contract}.${method}`);
      };
      return answer() as T;
    },
    headTimeMs: async () => NOW,
  };

  /** What landing a transaction does to the chain. Set by each test. */
  const land: { effect: (action: FairgroundAction) => unknown } = { effect: () => undefined };
  const makeSigner = (signsDelegates: boolean) => ({
    signsDelegates,
    signDelegate: vi.fn(async (action: FairgroundAction) => `delegate:${action.methodName}`),
    sendTransaction: vi.fn(async (action: FairgroundAction): Promise<unknown> => {
      land.effect(action);
      return outcome("PAIDTX");
    }),
  });
  const accounts = opts.accounts ?? ["alice.test.near"];
  const signers = Object.fromEntries(accounts.map((a) => [a, makeSigner(opts.signsDelegates ?? true)]));
  const relayer = {
    relay: vi.fn<RelayerClient["relay"]>(async () => ({ tx_hash: "RELAYTX", status: "succeeded", outcome: { failures: [], events: [], relayer_cost: "0" } })),
    sponsorStorage: vi.fn<RelayerClient["sponsorStorage"]>(async () => ({ status: "registered", token_id: USDC_ID, tx_hash: "STORAGETX" })),
    getPolicy: vi.fn<RelayerClient["getPolicy"]>(async () => ({
      network: "sandbox",
      relayer_account_id: "relayer.test.near",
      fairground_contract: CONTRACT,
      fairground_methods: ["claim", "claim_proceeds", "clear_onchain", "reveal_bid", "trigger_refund_mode"],
      usdc_contracts: [USDC_ID],
      bid_deposit: "1",
      max_actions: 1,
      max_gas: "150000000000000",
      min_blocks_left: 5,
      max_delegate_blocks: 1200,
      rate_limits: { relays_per_sender_per_hour: 60, requests_per_ip_per_hour: 300, storage_per_ip_per_day: 5, storage_per_account: 1 },
    })),
  };
  const clientOpts: NearClientOptions = {
    rpc,
    relayer: opts.relayer === false ? null : relayer,
    signers: staticSigners(signers as Record<string, ActionSigner>),
    cacheMs: opts.cacheMs ?? 0,
    waitMs: 250,
    pollMs: 10,
  };
  const client = new NearClient(CONFIG, clientOpts);
  const notices: ClientNotice[] = [];
  client.subscribeNotices((n) => notices.push(n));
  const addBid = (bidder: string, deposit: bigint, payload?: string) => {
    const list = chain.bids.get("fairt")!;
    list.push(bidView(list.length, bidder, deposit, payload ? { payload } : {}));
  };
  return { chain, views, rpc, land, signers, signer: signers[accounts[0]], relayer, client, notices, addBid };
}

const refusal = (reason: ConstructorParameters<typeof RelayerError>[0], maybeSubmitted = false, requestId: string | null = "req-1") =>
  new RelayerError(reason, { status: maybeSubmitted ? null : 429, requestId, maybeSubmitted });

async function failure(p: Promise<unknown>): Promise<FairgroundError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FairgroundError) return e;
    throw e;
  }
  throw new Error("expected the call to be refused");
}

const ALICE = "alice.test.near";
const TERMS = { maxPrice: 2000n, maxSpend: 5n * USDC };

/** A harness whose sale has a real key, so bid() can seal to it. */
async function sealedHarness(opts: Parameters<typeof harness>[0] = {}) {
  const key = await newSaleKeypair();
  const h = harness({ ...opts, sale: { sealer_pubkey: key.publicKey, ...opts.sale } });
  return { ...h, key };
}

describe("views", () => {
  it("translate a sale: units, the two folded statuses, the creator share", () => {
    const sale = saleFromView(saleView({ max_price: "5000", website: "https://fair.example" }));
    expect(sale).toMatchObject({
      id: "fairt",
      status: "open",
      chainStatus: "open",
      tokenAccount: `fairt.${CONTRACT}`,
      createdAt: NOW - 3_600_000,
      sealerPubkey: "cd".repeat(32),
      bidSetHash: null,
      runningBidSetHash: "11".repeat(32),
      closedAt: null,
      settledAt: null,
      refundModeAt: null,
      refundModeFrom: NOW + 60_000 + 7_200_000,
      maxBids: 100,
      isJudgeSale: false,
    });
    expect(sale.config).toMatchObject({
      tokenSymbol: "FAIRT",
      totalSupply: 1_000_000n * TOKEN,
      saleSupply: 600_000n * TOKEN,
      creatorAllocation: 400_000n * TOKEN,
      lpReserve: 0n,
      floorPrice: 1000n,
      maxPrice: 5000n,
      minRaise: 50n * USDC,
      bidStart: NOW - 60_000,
      bidEnd: NOW + 60_000,
      minDeposit: USDC,
      revealMode: "tee",
      settleTimeoutMs: 7_200_000,
      quoteToken: USDC_ID,
      maxBids: 100,
    });
    expect(sale.meta).toMatchObject({ description: "The reference sale.", website: "https://fair.example" });
    expect(sale.meta.hue).toBeGreaterThanOrEqual(0);
    expect(sale.meta.hue).toBeLessThan(360);

    expect(foldStatus("setup")).toBe("upcoming");
    expect(foldStatus("closed")).toBe("clearing");
    expect(foldStatus("revealing")).toBe("revealing");
    const setup = saleFromView(saleView({ status: "setup", sealer_pubkey: null, sealer_key_setup: "pending" }));
    expect(setup).toMatchObject({ status: "upcoming", chainStatus: "setup", sealerPubkey: "", sealerKeySetup: "pending" });

    const cr = saleFromView(
      saleView({ reveal_mode: "CommitReveal", status: "revealing", reveal_window: ns(600_000), closed_at: ns(NOW), reveal_end: ns(NOW + 600_000) }),
    );
    expect(cr.config).toMatchObject({ revealMode: "commit_reveal", revealWindowMs: 600_000 });
    expect(cr).toMatchObject({ status: "revealing", revealEnd: NOW + 600_000, closedAt: NOW, bidSetHash: "11".repeat(32) });

    const refunded = saleFromView(saleView({ status: "failed", closed_at: ns(NOW), refund_mode_at: null }), { failReason: "refund_mode" });
    expect(refunded).toMatchObject({ chainFailReason: "refund_mode", refundModeAt: NOW + 7_200_000, refundModeFrom: null });
    expect(nsToMs(ns(NOW))).toBe(NOW);
  });

  it("build create_sale params in the contract's units and names", () => {
    const config: SaleConfig = {
      tokenName: "Fair Test",
      tokenSymbol: "FAIRT",
      decimals: 18,
      totalSupply: 1_000_000n * TOKEN,
      saleSupply: 600_000n * TOKEN,
      creatorAllocation: 100_000n * TOKEN,
      lpReserve: 300_000n * TOKEN,
      floorPrice: 1000n,
      maxPrice: null,
      minRaise: 50n * USDC,
      bidStart: NOW,
      bidEnd: NOW + 3_600_000,
      minDeposit: USDC,
      maxDepositPerAccount: 10n * USDC,
      revealMode: "tee",
      unsoldRule: "burn",
      settleTimeoutMs: 7_200_000,
      quoteToken: USDC_ID,
    };
    expect(createSaleParams("fairt", config, { description: " The reference sale. ", hue: 3 })).toEqual({
      sale_id: "fairt",
      token_name: "Fair Test",
      token_symbol: "FAIRT",
      decimals: 18,
      total_supply: "1000000000000000000000000",
      sale_supply: "600000000000000000000000",
      floor_price: "1000",
      max_price: null,
      min_raise: "50000000",
      bid_start: `${NOW}000000`,
      bid_end: `${NOW + 3_600_000}000000`,
      min_deposit: "1000000",
      max_deposit_per_account: "10000000",
      max_bids: 100,
      reveal_mode: "Tee",
      settle_timeout: "7200000000000",
      quote_token: USDC_ID,
      description: "The reference sale.",
    });
    const cr = createSaleParams("cr", { ...config, revealMode: "commit_reveal", revealWindowMs: 120_000, maxBids: 7, maxPrice: 9n }, { description: "", hue: 0, website: "https://x.example" });
    expect(cr).toMatchObject({ reveal_mode: "CommitReveal", reveal_window: "120000000000", max_bids: 7, max_price: "9", website: "https://x.example" });
    expect(cr).not.toHaveProperty("description");
    expect(retrySetupDeposit({ status: "setup", sealer_key_setup: "failed" })).toBe(OUTLAYER_COMPUTE_DEPOSIT);
    expect(retrySetupDeposit({ status: "setup", sealer_key_setup: "failed" }, 5n)).toBe(5n);
    expect(retrySetupDeposit({ status: "setup", sealer_key_setup: "done" })).toBe(0n);
    expect(retrySetupDeposit({ status: "open", sealer_key_setup: "failed" })).toBe(0n);
  });

  const settledSale = saleView({ status: "settled", closed_at: ns(NOW), refund_mode_at: null, bid_count: 3, total_deposits: "13000000" });
  const settledBids = [
    bidView(0, "alice.test.near", 5n * USDC, { claimed: true }),
    bidView(1, "bob.test.near", 5n * USDC),
    bidView(2, "carol.test.near", 3n * USDC),
  ];
  const settledResult = resultView({
    status: "settled",
    clearing_price: "1000",
    total_sold: (8000n * TOKEN).toString(),
    total_raised: (8n * USDC).toString(),
    unsold: (592_000n * TOKEN).toString(),
    n_valid: 2,
    n_invalid: 1,
    n_winners: 2,
    result_sha256: "ee".repeat(32),
    input_sha256: "dd".repeat(32),
    clear_requests: 1,
    total_penalties: "50000",
    proceeds: { raise_paid: true, allocation_paid: true, unsold_burned: true, reserve_returned: true },
  });
  const settledFills: FillView[] = [
    { index: 0, bidder: "alice.test.near", tokens: (5000n * TOKEN).toString(), spent: "5000000", refund: "0", penalty: "0" },
    { index: 1, bidder: "bob.test.near", tokens: "0", spent: "0", refund: "4950000", penalty: "50000" },
    { index: 2, bidder: "carol.test.near", tokens: (3000n * TOKEN).toString(), spent: "3000000", refund: "0", penalty: "0" },
  ];

  it("translate a result: the penalty, net refunds, totals and checks", () => {
    expect(resultFromViews(saleView(), [], resultView(), [])).toBeNull();
    const r = resultFromViews(settledSale, settledBids, settledResult, settledFills)!;
    expect(r).toMatchObject({
      status: "settled",
      clearingPrice: 1000n,
      totalSold: 8000n * TOKEN,
      totalRaised: 8n * USDC,
      unsold: 592_000n * TOKEN,
      oversubscribed: false,
      nValid: 2,
      nInvalid: 1,
      bidSetHash: settledSale.bid_set_hash,
      totalPenalties: 50_000n,
      clearedBy: "enclave",
      settleTx: "",
      clearingMs: 0,
      resultSha256: "ee".repeat(32),
      inputSha256: "dd".repeat(32),
      proceeds: { raisePaid: true, allocationPaid: true, unsoldBurned: true, reserveReturned: true },
    });
    expect(r.failReason).toBeUndefined();
    expect(r.checks.every((c) => c.passed)).toBe(true);
    expect(r.fills[0]).toMatchObject({ bidder: "alice.test.near", deposit: 5n * USDC, tokens: 5000n * TOKEN, valid: true, penalty: 0n, claimed: true });
    // The contract only knows which bids pay the penalty: those are the void ones.
    expect(r.fills[1]).toMatchObject({ valid: false, penalty: 50_000n, refund: 4_950_000n, tokens: 0n, claimed: false });
    expect(r.fills[1].invalidReason).toBeUndefined();

    const failed = resultFromViews(
      { ...settledSale, status: "failed" },
      settledBids,
      { ...settledResult, status: "failed", fail_reason: "checks_failed", failed_checks: ["bid_set_hash_matches", "spent_within_deposit_1"], failed_checks_total: 2 },
      settledFills.map((f) => ({ ...f, tokens: "0", spent: "0", penalty: "0", refund: settledBids[f.index].deposit })),
    )!;
    expect(failed.status).toBe("failed");
    expect(failed.failReason).toBeUndefined();
    expect(failed.chainFailReason).toBe("checks_failed");
    expect(failed.bidSetHash).toBe("");
    expect(failed.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(["bid_set_hash_matches", "spent_within_deposit"]);
    expect(failed.fills.every((f) => f.valid && f.refund === f.deposit)).toBe(true);

    const refundMode = resultFromViews({ ...settledSale, status: "failed" }, settledBids, { ...settledResult, status: "failed", fail_reason: "refund_mode" }, [])!;
    expect(refundMode).toMatchObject({ failReason: "settle_timeout", clearedBy: "none", checks: [] });
    const onchain = resultFromViews({ ...settledSale, reveal_mode: "CommitReveal" }, settledBids.map((b) => ({ ...b, revealed: b.index !== 1 })), settledResult, settledFills)!;
    expect(onchain.clearedBy).toBe("onchain");
    expect(onchain.checks.map((c) => c.id)).toEqual(["onchain", "raise_at_least_min"]);
    expect(onchain.fills.map((f) => f.revealed)).toEqual([true, false, true]);
    const full = resultFromViews({ ...settledSale, sale_supply: (8000n * TOKEN).toString() }, settledBids, settledResult, settledFills)!;
    expect(full.oversubscribed).toBe(true);
  });

  it("tell a creator payout that was never owed from one that is still open", () => {
    const none = { raise_paid: false, allocation_paid: false, unsold_burned: false, reserve_returned: false };
    const owed = { ...settledResult, proceeds: none };
    // Nothing paid yet on a settled sale with a raise, an allocation, unsold tokens and a reserve.
    expect(proceedsLeft(settledSale, owed, 2_500_000_000_000_000_000_000n)).toEqual({ raise: true, allocation: true, burn: true, reserve: true });
    expect(resultFromViews(settledSale, settledBids, owed, settledFills, [], 2_500_000_000_000_000_000_000n)!.proceeds).toEqual({
      raisePaid: false,
      allocationPaid: false,
      unsoldBurned: false,
      reserveReturned: false,
    });

    // A sold-out sale after claim_proceeds: the contract never sets unsold_burned, because nothing was burned.
    const soldOut = { ...settledResult, unsold: "0", proceeds: { raise_paid: true, allocation_paid: true, unsold_burned: false, reserve_returned: true } };
    expect(proceedsLeft(settledSale, soldOut, 0n)).toEqual({ raise: false, allocation: false, burn: false, reserve: false });
    expect(resultFromViews(settledSale, settledBids, soldOut, settledFills, [], 0n)!.proceeds).toEqual({
      raisePaid: true,
      allocationPaid: true,
      unsoldBurned: true,
      reserveReturned: true,
    });

    // A failed sale has no raise, and one with the whole supply for sale has no allocation: neither flag is ever set.
    const failedSale = { ...settledSale, status: "failed" as const, creator_allocation: "0" };
    const failedResult = { ...settledResult, status: "failed" as const, fail_reason: "below_min_raise" as const, total_raised: "0", proceeds: { ...none, unsold_burned: true, reserve_returned: true } };
    expect(proceedsLeft(failedSale, failedResult, 0n)).toEqual({ raise: false, allocation: false, burn: false, reserve: false });
    expect(resultFromViews(failedSale, settledBids, failedResult, [], [], 0n)!.proceeds).toEqual({ raisePaid: true, allocationPaid: true, unsoldBurned: true, reserveReturned: true });

    // The reserve: every slot went to a winner, so the contract has none to return and never sets the flag.
    const noReserve = { ...settledResult, proceeds: { raise_paid: true, allocation_paid: true, unsold_burned: true, reserve_returned: false } };
    expect(proceedsLeft(settledSale, noReserve, 0n).reserve).toBe(false);
    expect(proceedsLeft(settledSale, noReserve, 1n).reserve).toBe(true);
    // Without get_reserve_refund it counts as owed until the flag is set.
    expect(proceedsLeft(settledSale, noReserve).reserve).toBe(true);
    expect(resultFromViews(settledSale, settledBids, noReserve, settledFills)!.proceeds?.reserveReturned).toBe(false);
    expect(resultFromViews(settledSale, settledBids, noReserve, settledFills, [], 0n)!.proceeds?.reserveReturned).toBe(true);

    // A token deploy still in flight: nothing token-related can be paid yet, and none of it counts as settled.
    const pending = { ...settledSale, status: "failed" as const, token_setup: "pending" as const };
    expect(proceedsLeft(pending, owed, 0n)).toEqual({ raise: false, allocation: false, burn: false, reserve: false });
    expect(resultFromViews(pending, settledBids, { ...owed, status: "failed", fail_reason: "refund_mode" }, [], [], 0n)!.proceeds).toEqual({
      raisePaid: true,
      allocationPaid: false,
      unsoldBurned: false,
      reserveReturned: false,
    });
    // A token that never deployed: no allocation and nothing to burn, but its deploy balance is still to return.
    const neverDeployed = { ...pending, token_setup: "failed" as const };
    expect(proceedsLeft(neverDeployed, { ...owed, unsold: "0" }, 1_700_000_000_000_000_000_000_000n)).toEqual({ raise: false, allocation: false, burn: false, reserve: true });
  });

  it("derive the timeline and say what is exact, estimated or local", () => {
    const log = [
      { saleId: "fairt", kind: "bid" as const, at: NOW - 29_000, account: "alice.test.near", amount: "5000000", txHash: "BIDTX" },
      { saleId: "fairt", kind: "bid_rejected" as const, at: NOW - 20_000, account: "alice.test.near", amount: "1", txHash: "REJTX", reason: "sale_full" as const, note: "Deposit returned: full." },
      { saleId: "fairt", kind: "claimed" as const, at: NOW + 90_000, account: "alice.test.near", amount: "0", txHash: "CLAIMTX" },
    ];
    const events = eventsFromViews(settledSale, settledBids, settledResult, settledFills, log);
    // Newest first.
    expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort((a, b) => b - a));
    const kinds = events.map((e) => e.detail ?? e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["created", "bid", "bid_rejected", "closed", "clearing_requested", "settled", "proceeds_claimed", "claimed"]));

    const created = events.find((e) => e.kind === "created")!;
    expect(created).toMatchObject({ at: NOW - 3_600_000, account: "maker.test.near", source: "view", txHash: "" });
    expect(created.approximate).toBeUndefined();
    const bids = events.filter((e) => e.kind === "bid");
    expect(bids).toHaveLength(3);
    // Real block times, kept apart by the bid index; this browser's own bid has its hash.
    expect(bids.map((e) => Math.floor(e.at)).sort()).toEqual([NOW - 30_000, NOW - 29_000, NOW - 28_000]);
    expect(new Set(bids.map((e) => e.at)).size).toBe(3);
    expect(bids.find((e) => e.account === "alice.test.near")).toMatchObject({ txHash: "BIDTX", amount: 5n * USDC, source: "view" });
    expect(bids.find((e) => e.account === "bob.test.near")?.txHash).toBe("");
    expect(events.find((e) => e.kind === "closed")).toMatchObject({ at: NOW, source: "view" });

    // Visible in the views but not timed there.
    const settled = events.find((e) => e.kind === "settled")!;
    expect(settled).toMatchObject({ approximate: true, source: "view", txHash: "", amount: 8n * USDC });
    expect(settled.at).toBeGreaterThanOrEqual(NOW);
    expect(settled.note).toMatch(/2 valid bids, 1 void/);
    const claim = events.find((e) => e.kind === "claimed" && !e.detail)!;
    expect(claim).toMatchObject({ account: "alice.test.near", approximate: true, txHash: "CLAIMTX", at: NOW + 90_000 });
    expect(events.find((e) => e.detail === "proceeds_claimed")).toMatchObject({ kind: "claimed", account: "maker.test.near", amount: 8n * USDC, approximate: true });
    // Only this browser knows about a returned bid.
    expect(events.find((e) => e.kind === "bid_rejected")).toMatchObject({ source: "tx", reason: "sale_full", txHash: "REJTX", approximate: true });

    const setup = eventsFromViews(saleView({ status: "setup", sealer_key_setup: "failed" }), [], resultView(), []);
    expect(setup.map((e) => e.detail ?? e.kind)).toEqual(["sale_ready", "created"]);
    expect(setup[0].note).toMatch(/retry/);
    const refund = eventsFromViews({ ...settledSale, status: "failed" }, settledBids, { ...settledResult, status: "failed", fail_reason: "refund_mode", proceeds: resultView().proceeds }, []);
    expect(refund.find((e) => e.kind === "refund_mode")).toMatchObject({ approximate: true, at: NOW + 7_200_000 });
  });
});

describe("reads", () => {
  it("answer from the contract's views", async () => {
    const h = harness();
    h.addBid(ALICE, 5n * USDC);
    expect(h.client.mode).toBe("near");
    expect(h.client.contractId).toBe(CONTRACT);
    expect(h.client.usdcContract).toBe(USDC_ID);
    expect(h.client.secretsScope).toBe(CONTRACT);
    expect(h.client.capabilities).toEqual({ judgeMode: false, faucet: true, reset: false, relayer: true, simulated: false });
    expect(h.client.expectedCodeHash()).toBe("ab".repeat(32));
    expect((await h.client.listSales()).map((s) => s.id)).toEqual(["fairt"]);
    expect((await h.client.getSale("fairt"))?.status).toBe("open");
    expect(await h.client.getSale("nope")).toBeNull();
    expect(await h.client.getBids("fairt")).toMatchObject([{ index: 0, bidder: ALICE, deposit: 5n * USDC, payloadKind: "ciphertext", txHash: "" }]);
    expect((await h.client.getBid("fairt", ALICE))?.placedAt).toBe(NOW - 30_000);
    expect(await h.client.getBid("fairt", "bob.test.near")).toBeNull();
    expect(await h.client.getResult("fairt")).toBeNull();
    expect((await h.client.getEvents("fairt")).map((e) => e.kind)).toEqual(["bid", "created"]);
    expect(await h.client.getBalances(ALICE)).toEqual({ account: ALICE, usdc: 100n * USDC, tokens: {} });
    expect(await h.client.getCloseDeposit("fairt")).toBe(OUTLAYER_COMPUTE_DEPOSIT);
    expect(await h.client.getRelayerPolicy()).toEqual({
      relayerAccountId: "relayer.test.near",
      methods: ["claim", "claim_proceeds", "clear_onchain", "reveal_bid", "trigger_refund_mode"],
      usdcContracts: [USDC_ID],
      simulated: false,
    });
    expect(await harness({ relayer: false }).client.getRelayerPolicy()).toBeNull();
  });

  it("page through long lists", async () => {
    const h = harness();
    for (let i = 0; i < 450; i++) h.addBid(`bidder-${i}.test.near`, USDC);
    expect(await h.client.getBids("fairt")).toHaveLength(450);
    const calls = h.views.filter((v) => v.method === "get_bids").map((v) => v.args);
    expect(calls).toEqual([
      { sale_id: "fairt", from_index: 0, limit: 200 },
      { sale_id: "fairt", from_index: 200, limit: 200 },
      { sale_id: "fairt", from_index: 400, limit: 200 },
    ]);
  });

  it("reuse a view for a few seconds, and forget it after a write", async () => {
    const h = await sealedHarness({ cacheMs: 60_000 });
    h.land.effect = () => undefined;
    h.relayer.relay.mockImplementation(async () => {
      h.addBid(ALICE, 5n * USDC);
      return { tx_hash: "T", status: "succeeded", outcome: { failures: [], events: [{ event: "bid_placed", data: {} }], relayer_cost: "0" } };
    });
    await h.client.getSale("fairt");
    await h.client.getSale("fairt");
    await h.client.getBids("fairt");
    await h.client.getBids("fairt");
    expect(h.views.filter((v) => v.method === "get_sale")).toHaveLength(1);
    expect(h.views.filter((v) => v.method === "get_bids")).toHaveLength(1);
    let changes = 0;
    h.client.subscribe(() => changes++);
    await h.client.bid("fairt", ALICE, 5n * USDC, TERMS);
    expect(changes).toBeGreaterThan(0);
    expect(await h.client.getBids("fairt")).toHaveLength(1);
  });

  it("report what the chain holds about the enclave run, and no more", async () => {
    const h = harness();
    h.chain.results.set("fairt", resultView({ input_sha256: "dd".repeat(32), result_sha256: "ee".repeat(32) }));
    expect(await h.client.getAttestation("fairt", "aabb")).toMatchObject({
      nonce: "",
      quote: "",
      simulated: false,
      source: "chain",
      codeHash: "ab".repeat(32),
      reportedPubkey: "cd".repeat(32),
      inputHash: "dd".repeat(32),
      outputHash: "ee".repeat(32),
    });
  });

  it("has no judge mode and no reset", async () => {
    const h = harness();
    expect((await failure(h.client.runJudgeMode({ onProgress: () => {} }))).code).toBe("not_supported");
    expect((await failure(h.client.reset())).code).toBe("not_supported");
  });
});

describe("placing a bid", () => {
  it("is gasless through the relayer: one delegate, no transaction", async () => {
    const h = await sealedHarness();
    h.relayer.relay.mockImplementation(async () => {
      h.addBid(ALICE, 5n * USDC);
      return { tx_hash: "RELAYTX", status: "succeeded", outcome: { failures: [], events: [{ event: "bid_placed", data: { index: 0 } }], relayer_cost: "1" } };
    });
    const placed = await h.client.bid("fairt", ALICE, 5n * USDC, TERMS);
    expect(placed).toMatchObject({ saleId: "fairt", bidder: ALICE, deposit: 5n * USDC, index: 0, txHash: "RELAYTX" });
    expect(placed.relay).toEqual({ paidBy: "relayer", fallbackReason: null, txHash: "RELAYTX", status: "succeeded", requestId: null, simulated: false });
    expect(h.signer.signDelegate).toHaveBeenCalledTimes(1);
    expect(h.signer.sendTransaction).not.toHaveBeenCalled();
    expect(h.relayer.relay).toHaveBeenCalledWith("delegate:ft_transfer_call");
    expect(h.notices).toEqual([]);

    // The signed call: USDC ft_transfer_call into Fairground with 1 yocto and the padded sealed bid.
    const action = h.signer.signDelegate.mock.calls[0][0];
    expect(action).toMatchObject({ receiverId: USDC_ID, methodName: "ft_transfer_call", deposit: 1n, gas: 100n * TGAS });
    expect(action.args).toMatchObject({ receiver_id: CONTRACT, amount: "5000000" });
    const msg = JSON.parse(String(action.args.msg)) as { sale_id: string; ciphertext: string };
    expect(Object.keys(msg)).toEqual(["sale_id", "ciphertext"]);
    expect(msg.sale_id).toBe("fairt");
    expect(fromB64(msg.ciphertext).length).toBe(sealedBidLen("fairt", ALICE));
    // Built by the relayer client's own builder, with the bidder that the length check needs.
    expect(action).toEqual(bidAction(USDC_ID, CONTRACT, "fairt", 5n * USDC, { ciphertext: msg.ciphertext, bidder: ALICE }));
    // The timeline now knows this browser's transaction.
    expect((await h.client.getEvents("fairt")).find((e) => e.kind === "bid")).toMatchObject({ txHash: "RELAYTX", account: ALICE });
  });

  it("falls back to a paid transaction when the relayer refuses for its own reasons", async () => {
    for (const reason of ["rate_limited", "budget_exhausted", "relay_failed"] as const) {
      const h = await sealedHarness();
      h.relayer.relay.mockRejectedValue(refusal(reason));
      h.land.effect = () => h.addBid(ALICE, 5n * USDC);
      h.signer.sendTransaction.mockImplementation(async (action) => {
        h.land.effect(action);
        return outcome("PAIDTX", [{ event: "bid_placed", data: {} }]);
      });
      const asked: PaidReason[] = [];
      const placed = await h.client.bid("fairt", ALICE, 5n * USDC, TERMS, { onPaidFallback: (r) => void asked.push(r) });
      expect(asked).toEqual([reason]);
      expect(placed.relay).toEqual({ paidBy: "user", fallbackReason: reason, txHash: "PAIDTX", status: "succeeded", requestId: null, simulated: false });
      expect(h.relayer.relay).toHaveBeenCalledTimes(1);
      expect(h.signer.sendTransaction).toHaveBeenCalledTimes(1);
      // The same call, now as a transaction.
      expect(h.signer.sendTransaction.mock.calls[0][0]).toEqual(h.signer.signDelegate.mock.calls[0][0]);
      expect(h.notices).toMatchObject([{ kind: "paid_fallback", reason, message: PAID_REASON_MESSAGES[reason] }]);
    }
  });

  it("pays directly when the wallet cannot sign delegates or there is no relayer", async () => {
    const noDelegates = await sealedHarness({ signsDelegates: false });
    noDelegates.land.effect = () => noDelegates.addBid(ALICE, 5n * USDC);
    const a = await noDelegates.client.bid("fairt", ALICE, 5n * USDC, TERMS);
    expect(a.relay).toMatchObject({ paidBy: "user", fallbackReason: "delegates_unsupported", txHash: "PAIDTX" });
    expect(noDelegates.signer.signDelegate).not.toHaveBeenCalled();
    expect(noDelegates.relayer.relay).not.toHaveBeenCalled();
    expect(noDelegates.notices[0]).toMatchObject({ kind: "paid_fallback", reason: "delegates_unsupported" });

    const noRelayer = await sealedHarness({ relayer: false });
    noRelayer.land.effect = () => noRelayer.addBid(ALICE, 5n * USDC);
    const b = await noRelayer.client.bid("fairt", ALICE, 5n * USDC, TERMS);
    expect(b.relay).toMatchObject({ paidBy: "user", fallbackReason: "no_relayer" });
    expect(noRelayer.client.capabilities.relayer).toBe(false);
    expect(noRelayer.signer.signDelegate).not.toHaveBeenCalled();
  });

  it("sends nothing when the paid prompt is declined", async () => {
    const h = await sealedHarness();
    h.relayer.relay.mockRejectedValue(refusal("budget_exhausted"));
    const e = await failure(
      h.client.bid("fairt", ALICE, 5n * USDC, TERMS, {
        onPaidFallback: () => {
          throw new Error("no thanks");
        },
      }),
    );
    expect(e).toMatchObject({ code: "cancelled", reason: "budget_exhausted", maybeSubmitted: false });
    expect(h.signer.sendTransaction).not.toHaveBeenCalled();
  });

  it("turns the contract's bid_rejected into a readable error and logs it", async () => {
    const h = await sealedHarness();
    h.relayer.relay.mockResolvedValue({
      tx_hash: "REJTX",
      status: "succeeded",
      outcome: { failures: [], events: [{ event: "bid_rejected", data: { reason: "sale_full" } }], relayer_cost: "1" },
    });
    const e = await failure(h.client.bid("fairt", ALICE, 5n * USDC, TERMS));
    expect(e).toMatchObject({ code: "bid_rejected", reason: "sale_full", txHash: "REJTX", maybeSubmitted: false });
    expect(e.message).toBe("This sale has taken its maximum number of bids. Your deposit was returned.");
    expect(e.relay).toMatchObject({ paidBy: "relayer", txHash: "REJTX" });
    const logged = (await h.client.getEvents("fairt")).find((ev) => ev.kind === "bid_rejected")!;
    expect(logged).toMatchObject({ reason: "sale_full", account: ALICE, amount: 5n * USDC, txHash: "REJTX", source: "tx" });
  });

  it("reports a relayer refusal of the call itself and does not pay instead", async () => {
    for (const reason of ["needs_full_access_key", "expired", "sender_busy", "nonce_already_used", "wrong_ciphertext_length", "insufficient_balance"] as const) {
      const h = await sealedHarness();
      h.relayer.relay.mockRejectedValue(refusal(reason, false, "req-9"));
      const e = await failure(h.client.bid("fairt", ALICE, 5n * USDC, TERMS));
      expect(e).toMatchObject({ code: "relayer_refused", reason, requestId: "req-9", maybeSubmitted: false });
      expect(e.message).toBe(RELAYER_REFUSAL_MESSAGES[reason]);
      expect(h.signer.sendTransaction).not.toHaveBeenCalled();
      expect(h.notices).toEqual([]);
    }
  });

  it("after a lost answer, confirms the bid from the chain without sending again", async () => {
    for (const reason of ["timeout", "network_error", "bad_response", "internal_error"] as const) {
      const h = await sealedHarness();
      h.relayer.relay.mockImplementation(async () => {
        // The relay did land; only its answer was lost.
        setTimeout(() => h.addBid(ALICE, 5n * USDC), 40);
        throw refusal(reason, true, "req-lost");
      });
      const placed = await h.client.bid("fairt", ALICE, 5n * USDC, TERMS);
      expect(placed.relay).toEqual({ paidBy: "relayer", fallbackReason: null, txHash: null, status: "succeeded", requestId: "req-lost", simulated: false });
      expect(placed.txHash).toBe("");
      expect(h.relayer.relay).toHaveBeenCalledTimes(1);
      expect(h.signer.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it("after a lost answer with no bid on chain, says it may still land and never resends", async () => {
    const h = await sealedHarness();
    h.relayer.relay.mockRejectedValue(refusal("timeout", true, "req-lost"));
    const asked: PaidReason[] = [];
    const e = await failure(h.client.bid("fairt", ALICE, 5n * USDC, TERMS, { onPaidFallback: (r) => void asked.push(r) }));
    expect(e).toMatchObject({ code: "maybe_submitted", reason: "timeout", maybeSubmitted: true, requestId: "req-lost" });
    expect(e.message).toMatch(/may still land/);
    expect(e.relay).toMatchObject({ paidBy: "relayer", status: "pending" });
    expect(h.relayer.relay).toHaveBeenCalledTimes(1);
    expect(h.signer.signDelegate).toHaveBeenCalledTimes(1);
    expect(h.signer.sendTransaction).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
    // It polled the bid book while waiting.
    expect(h.views.filter((v) => v.method === "get_bid").length).toBeGreaterThan(3);
  });

  it("polls get_bid after a pending answer", async () => {
    const h = await sealedHarness();
    h.relayer.relay.mockImplementation(async () => {
      setTimeout(() => h.addBid(ALICE, 5n * USDC), 40);
      return { tx_hash: "PENDTX", status: "pending", outcome: null };
    });
    const placed = await h.client.bid("fairt", ALICE, 5n * USDC, TERMS);
    expect(placed.relay).toMatchObject({ paidBy: "relayer", txHash: "PENDTX", status: "succeeded" });

    const never = await sealedHarness();
    never.relayer.relay.mockResolvedValue({ tx_hash: "PENDTX", status: "pending", outcome: null });
    const e = await failure(never.client.bid("fairt", ALICE, 5n * USDC, TERMS));
    expect(e).toMatchObject({ code: "maybe_submitted", maybeSubmitted: true, txHash: "PENDTX" });
    expect(never.relayer.relay).toHaveBeenCalledTimes(1);
    expect(never.signer.sendTransaction).not.toHaveBeenCalled();
  });

  it("reads a failed transaction's reason", async () => {
    const h = await sealedHarness({ relayer: false });
    h.signer.sendTransaction.mockResolvedValue(
      outcome("FAILTX", [], { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: The account doesn't have enough balance" } } } }),
    );
    const e = await failure(h.client.bid("fairt", ALICE, 5n * USDC, TERMS));
    expect(e).toMatchObject({ code: "tx_failed", txHash: "FAILTX" });
    expect(e.message).toBe("The transaction failed: The account doesn't have enough balance");
  });

  it("tells a declined wallet from one that may have sent", async () => {
    const declined = await sealedHarness({ relayer: false });
    declined.signer.sendTransaction.mockRejectedValue(new Error("User rejected the request"));
    expect(await failure(declined.client.bid("fairt", ALICE, 5n * USDC, TERMS))).toMatchObject({ code: "wallet_error", maybeSubmitted: false });

    const unclear = await sealedHarness({ relayer: false });
    unclear.signer.sendTransaction.mockRejectedValue(new Error("popup lost its connection"));
    const e = await failure(unclear.client.bid("fairt", ALICE, 5n * USDC, TERMS));
    expect(e).toMatchObject({ code: "maybe_submitted", maybeSubmitted: true });
    expect(e.relay).toMatchObject({ paidBy: "user", fallbackReason: "no_relayer" });
    expect(unclear.signer.sendTransaction).toHaveBeenCalledTimes(1);

    const noSign = await sealedHarness();
    noSign.signer.signDelegate.mockRejectedValue(new Error("locked"));
    expect(await failure(noSign.client.bid("fairt", ALICE, 5n * USDC, TERMS))).toMatchObject({ code: "wallet_error", maybeSubmitted: false });
    expect(noSign.relayer.relay).not.toHaveBeenCalled();
  });

  it("refuses before signing what the contract would return", async () => {
    const h = await sealedHarness();
    const good = await sealBid(h.key.publicKey, { sale_id: "fairt", bidder: ALICE, max_price: "2000", max_spend: "5000000", salt: "00".repeat(16) });
    const forBob = await sealBid(h.key.publicKey, { sale_id: "fairt", bidder: "bob.test.near", max_price: "2000", max_spend: "5000000", salt: "00".repeat(16) });
    const cases: [Promise<unknown>, string][] = [
      [h.client.placeBid("fairt", ALICE, 5n * USDC, forBob), "wrong_ciphertext_length"],
      [h.client.placeBid("fairt", ALICE, 5n * USDC, "###"), "bad_base64"],
      [h.client.placeBidPayload("fairt", ALICE, 5n * USDC, { commitment: "ab".repeat(32) }), "wrong_payload"],
      [h.client.placeBid("fairt", ALICE, USDC - 1n, good), "below_min_deposit"],
      [h.client.placeBid("fairt", ALICE, 10n * USDC + 1n, good), "above_max_deposit"],
      [h.client.placeBid("nope", ALICE, 5n * USDC, good), "unknown_sale"],
    ];
    for (const [call, reason] of cases) expect(await failure(call)).toMatchObject({ code: "invalid", reason });
    expect((await failure(h.client.bid("fairt", ALICE, 5n * USDC, { maxPrice: 2000n, maxSpend: 6n * USDC }))).message).toMatch(/lose 1 % of its deposit/);

    h.addBid(ALICE, 5n * USDC);
    expect(await failure(h.client.placeBid("fairt", ALICE, 5n * USDC, good))).toMatchObject({ reason: "already_bid" });
    const closed = await sealedHarness({ sale: { status: "awaiting_close" } });
    expect(await failure(closed.client.placeBid("fairt", ALICE, 5n * USDC, good))).toMatchObject({ reason: "not_open", message: "The bid window is closed." });
    const full = await sealedHarness({ sale: { bid_count: 100 } });
    expect(await failure(full.client.placeBid("fairt", ALICE, 5n * USDC, good))).toMatchObject({ reason: "sale_full" });
    const noKey = harness({ sale: { status: "setup", sealer_pubkey: null } });
    expect((await failure(noKey.client.bid("fairt", ALICE, 5n * USDC, TERMS))).message).toMatch(/no sale key yet/);

    for (const x of [h, closed, full, noKey]) {
      expect(x.signer.signDelegate).not.toHaveBeenCalled();
      expect(x.signer.sendTransaction).not.toHaveBeenCalled();
      expect(x.relayer.relay).not.toHaveBeenCalled();
    }
  });

  it("needs the bidder's own wallet", async () => {
    const h = await sealedHarness({ accounts: ["bob.test.near"] });
    const e = await failure(h.client.bid("fairt", ALICE, 5n * USDC, TERMS));
    expect(e).toMatchObject({ code: "not_connected" });
    expect(e.message).toMatch(/alice\.test\.near/);
  });
});

describe("commit-reveal", () => {
  const CR = { reveal_mode: "CommitReveal" as const, sealer_pubkey: null, reveal_window: ns(600_000) };

  it("commits, keeps the salt before sending, and reveals with it", async () => {
    const h = harness({ sale: CR });
    h.relayer.relay.mockImplementation(async (delegate) => {
      if (delegate === "delegate:ft_transfer_call") {
        const action = h.signer.signDelegate.mock.calls.at(-1)![0];
        const msg = JSON.parse(String(action.args.msg)) as { commitment: string };
        // The secret is already stored when the relay happens.
        expect(getBidSecret(CONTRACT, "fairt", ALICE)?.commitment).toBe(msg.commitment);
        h.addBid(ALICE, 5n * USDC, toB64(fromHex(msg.commitment)));
        return { tx_hash: "BIDTX", status: "succeeded", outcome: { failures: [], events: [{ event: "bid_placed", data: {} }], relayer_cost: "1" } };
      }
      h.chain.bids.get("fairt")![0].revealed = true;
      return { tx_hash: "REVEALTX", status: "succeeded", outcome: { failures: [], events: [{ event: "bid_revealed", data: {} }], relayer_cost: "1" } };
    });
    const placed = await h.client.bid("fairt", ALICE, 5n * USDC, TERMS);
    expect(placed).toMatchObject({ payloadKind: "commitment", revealed: false, txHash: "BIDTX" });
    expect(placed.secret?.commitment).toBe(bidCommitment({ saleId: "fairt", bidder: ALICE, ...TERMS, salt: placed.secret!.salt }));
    const msg = JSON.parse(String(h.signer.signDelegate.mock.calls[0][0].args.msg)) as Record<string, string>;
    expect(msg).toEqual({ sale_id: "fairt", commitment: placed.secret!.commitment });

    // Not yet: the sale is still open.
    expect(await failure(h.client.revealBid("fairt", ALICE))).toMatchObject({ code: "invalid", reason: "wrong_phase" });
    h.chain.sales.set("fairt", saleView({ ...CR, status: "revealing", closed_at: ns(NOW), reveal_end: ns(NOW + 600_000) }));
    // A wrong salt costs no signature.
    const signed = h.signer.signDelegate.mock.calls.length;
    expect(await failure(h.client.revealBid("fairt", ALICE, { ...TERMS, salt: "11".repeat(16) }))).toMatchObject({ reason: "commitment_mismatch" });
    expect(h.signer.signDelegate.mock.calls.length).toBe(signed);

    const revealed = await h.client.revealBid("fairt", ALICE);
    expect(revealed).toMatchObject({ txHash: "REVEALTX", relay: { paidBy: "relayer" } });
    const action = h.signer.signDelegate.mock.calls.at(-1)![0];
    expect(action).toMatchObject({ receiverId: CONTRACT, methodName: "reveal_bid", deposit: 0n });
    expect(action.args).toEqual({ sale_id: "fairt", max_price: "2000", max_spend: "5000000", salt: placed.secret!.salt });
    expect(action).toEqual(revealAction(CONTRACT, "fairt", { ...TERMS, salt: placed.secret!.salt }));
    expect(await failure(h.client.revealBid("fairt", ALICE))).toMatchObject({ reason: "already_revealed" });
    expect((await h.client.getEvents("fairt")).find((e) => e.detail === "bid_revealed")).toMatchObject({ kind: "bid", txHash: "REVEALTX" });
  });

  it("explains a missing salt", async () => {
    const h = harness({ sale: { ...CR, status: "revealing", closed_at: ns(NOW), reveal_end: ns(NOW + 600_000) } });
    h.addBid("alice.test.near", 5n * USDC, toB64(new Uint8Array(32).fill(9)));
    // Another browser placed this bid: nothing is stored here for this sale id.
    h.chain.sales.set("other", saleView({ ...CR, sale_id: "other", status: "revealing" }));
    h.chain.bids.set("other", [bidView(0, ALICE, USDC, { payload: toB64(new Uint8Array(32).fill(9)) })]);
    const e = await failure(h.client.revealBid("other", ALICE));
    expect(e).toMatchObject({ code: "invalid", reason: "missing_secret" });
    expect(e.message).toMatch(/Import your bid secrets file/);
    expect(await failure(h.client.revealBid("fairt", "bob.test.near"))).toMatchObject({ reason: "no_bid" });
  });

  it("clears on chain through the relayer, and pays when an older relayer does not relay it", async () => {
    const revealing = { ...CR, status: "revealing" as const, closed_at: ns(NOW - 700_000), reveal_end: ns(NOW - 100_000) };
    const h = harness({ sale: revealing });
    h.relayer.relay.mockImplementation(async () => {
      h.chain.sales.set("fairt", saleView({ ...revealing, status: "settled", refund_mode_at: null }));
      return { tx_hash: "CLEARTX", status: "succeeded", outcome: { failures: [], events: [{ event: "sale_settled", data: {} }], relayer_cost: "1" } };
    });
    const cleared = await h.client.clearOnchain("fairt", ALICE);
    expect(cleared).toMatchObject({ status: "settled", relay: { paidBy: "relayer", txHash: "CLEARTX" } });
    // Exactly the relayer client's own action: its gas (150 TGas, the relayer's cap), no number of ours.
    expect(h.signer.signDelegate.mock.calls[0][0]).toEqual(clearOnchainAction(CONTRACT, "fairt"));
    expect(h.signer.signDelegate.mock.calls[0][0]).toMatchObject({ receiverId: CONTRACT, methodName: "clear_onchain", args: { sale_id: "fairt" }, gas: 150n * TGAS, deposit: 0n });
    expect(await failure(h.client.clearOnchain("fairt", ALICE))).toMatchObject({ reason: "wrong_phase" });

    const old = harness({ sale: revealing });
    old.relayer.relay.mockRejectedValue(new RelayerError("method_not_allowed", { status: 400, requestId: "r", maybeSubmitted: false }));
    old.land.effect = () => old.chain.sales.set("fairt", saleView({ ...revealing, status: "failed", refund_mode_at: null }));
    const paid = await old.client.clearOnchain("fairt", ALICE);
    expect(paid).toMatchObject({ status: "failed", relay: { paidBy: "user", fallbackReason: "method_not_relayed" } });
    expect(old.signer.sendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("claims and refund mode", () => {
  const settled = { status: "settled" as const, closed_at: ns(NOW), refund_mode_at: null, bid_count: 1 };

  it("lets any connected account push a bidder's claim", async () => {
    const h = harness({ sale: settled, accounts: ["pusher.test.near"] });
    h.addBid(ALICE, 5n * USDC);
    h.chain.fills.set("fairt", [{ index: 0, bidder: ALICE, tokens: "7", spent: "1", refund: "4999999", penalty: "0" }]);
    h.relayer.relay.mockImplementation(async () => {
      h.chain.bids.get("fairt")![0].claimed = true;
      return {
        tx_hash: "CLAIMTX",
        status: "succeeded",
        outcome: { failures: [], events: [{ event: "claimed", data: { bidder: ALICE, tokens: "7", refund: "4999999", failed: [] } }], relayer_cost: "1" },
      };
    });
    const receipt = await h.client.claim("fairt", ALICE);
    expect(receipt).toMatchObject({ saleId: "fairt", bidder: ALICE, tokens: 7n, refund: 4_999_999n, txHash: "CLAIMTX", relay: { paidBy: "relayer" } });
    // Signed by the connected account, paid to the bidder.
    expect(h.signers["pusher.test.near"].signDelegate.mock.calls[0][0]).toMatchObject({
      receiverId: CONTRACT,
      methodName: "claim",
      args: { sale_id: "fairt", bidder: ALICE },
      deposit: 0n,
    });
    expect(await failure(h.client.claim("fairt", ALICE))).toMatchObject({ code: "invalid", reason: "already_claimed" });
    expect(h.signers["pusher.test.near"].signDelegate.mock.calls[0][0]).toEqual(claimAction(CONTRACT, "fairt", ALICE));
    expect(await failure(h.client.claim("fairt", "bob.test.near"))).toMatchObject({ reason: "no_bid" });
    expect((await h.client.getBid("fairt", ALICE))?.claimTx).toBe("CLAIMTX");
  });

  it("reads the paid amounts from the fill when the answer carried no event", async () => {
    const h = harness({ sale: settled });
    h.addBid(ALICE, 5n * USDC);
    h.chain.fills.set("fairt", [{ index: 0, bidder: ALICE, tokens: "0", spent: "0", refund: "4950000", penalty: "50000" }]);
    h.relayer.relay.mockImplementation(async () => {
      setTimeout(() => (h.chain.bids.get("fairt")![0].claimed = true), 30);
      return { tx_hash: "PEND", status: "pending", outcome: null };
    });
    expect(await h.client.claim("fairt", ALICE)).toMatchObject({ tokens: 0n, refund: 4_950_000n, txHash: "PEND" });
    expect(await failure(harness().client.claim("fairt", ALICE))).toMatchObject({ reason: "wrong_phase" });
  });

  it("pays the creator once", async () => {
    const h = harness({ sale: settled });
    h.relayer.relay.mockImplementation(async () => {
      h.chain.results.set("fairt", resultView({ status: "settled", proceeds: { raise_paid: true, allocation_paid: true, unsold_burned: true, reserve_returned: true } }));
      return { tx_hash: "PROCTX", status: "succeeded", outcome: { failures: [], events: [], relayer_cost: "1" } };
    });
    expect(await h.client.claimProceeds("fairt", ALICE)).toMatchObject({ txHash: "PROCTX", relay: { paidBy: "relayer" } });
    expect(h.signer.signDelegate.mock.calls[0][0]).toMatchObject({ methodName: "claim_proceeds", gas: 150n * TGAS });
    expect(h.signer.signDelegate.mock.calls[0][0]).toEqual(claimProceedsAction(CONTRACT, "fairt"));
    expect(await failure(h.client.claimProceeds("fairt", ALICE))).toMatchObject({ reason: "already_claimed" });
  });

  it("does not send claim_proceeds when no part is left, whatever the contract's flags say", async () => {
    // A sold-out sale after its payout: unsold_burned stays false on chain for good, because nothing was burned.
    const h = harness({ sale: settled });
    h.chain.results.set(
      "fairt",
      resultView({ status: "settled", total_raised: "8000000", unsold: "0", proceeds: { raise_paid: true, allocation_paid: true, unsold_burned: false, reserve_returned: true } }),
    );
    expect(await failure(h.client.claimProceeds("fairt", ALICE))).toMatchObject({ code: "invalid", reason: "already_claimed" });
    expect(h.signer.signDelegate).not.toHaveBeenCalled();
    expect(h.relayer.relay).not.toHaveBeenCalled();
    expect((await h.client.getResult("fairt"))?.proceeds).toEqual({ raisePaid: true, allocationPaid: true, unsoldBurned: true, reserveReturned: true });

    // A failed sale with nothing but the NEAR reserve open: no raise and no allocation were ever owed. The call goes out once.
    const unsold = (600_000n * TOKEN).toString();
    const f = harness({ sale: { ...settled, status: "failed", creator_allocation: "0" } });
    const failed = (reserveReturned: boolean) =>
      resultView({ status: "failed", fail_reason: "no_bids", unsold, proceeds: { raise_paid: false, allocation_paid: false, unsold_burned: true, reserve_returned: reserveReturned } });
    f.chain.results.set("fairt", failed(false));
    f.chain.reserveRefund = "1250000000000000000000";
    f.relayer.relay.mockImplementation(async () => {
      f.chain.reserveRefund = "0";
      f.chain.results.set("fairt", failed(true));
      return { tx_hash: "RESERVETX", status: "succeeded", outcome: { failures: [], events: [], relayer_cost: "1" } };
    });
    expect((await f.client.getResult("fairt"))?.proceeds).toEqual({ raisePaid: true, allocationPaid: true, unsoldBurned: true, reserveReturned: false });
    expect(await f.client.claimProceeds("fairt", ALICE)).toMatchObject({ txHash: "RESERVETX", relay: { paidBy: "relayer" } });
    expect((await f.client.getResult("fairt"))?.proceeds?.reserveReturned).toBe(true);
    expect(await failure(f.client.claimProceeds("fairt", ALICE))).toMatchObject({ code: "invalid", reason: "already_claimed" });
    expect(f.relayer.relay).toHaveBeenCalledTimes(1);

    // The reserve view cannot be read: the result still loads, with the contract's own flag for the reserve.
    const g = harness({ sale: settled });
    g.chain.results.set("fairt", resultView({ status: "settled", proceeds: { raise_paid: true, allocation_paid: true, unsold_burned: true, reserve_returned: false } }));
    const view = g.rpc.view.bind(g.rpc);
    g.rpc.view = (async (contract: string, method: string, args?: Record<string, unknown>) => {
      if (method === "get_reserve_refund") throw new FairgroundError("rpc_error", "node busy");
      return view(contract, method, args);
    }) as NearRpc["view"];
    expect((await g.client.getResult("fairt"))?.proceeds?.reserveReturned).toBe(false);
  });

  it("triggers refund mode gaslessly", async () => {
    const h = harness({ sale: { status: "clearing", closed_at: ns(NOW - 8_000_000), refund_mode_at: ns(NOW - 800_000) } });
    h.relayer.relay.mockImplementation(async () => {
      h.chain.sales.set("fairt", saleView({ status: "failed", closed_at: ns(NOW - 8_000_000), refund_mode_at: null }));
      h.chain.results.set("fairt", resultView({ status: "failed", fail_reason: "refund_mode" }));
      return { tx_hash: "REFTX", status: "succeeded", outcome: { failures: [], events: [], relayer_cost: "1" } };
    });
    const sale = await h.client.triggerRefundMode("fairt", ALICE);
    expect(sale).toMatchObject({ status: "failed", chainFailReason: "refund_mode", relay: { paidBy: "relayer", txHash: "REFTX" } });
    expect(h.signer.signDelegate.mock.calls[0][0]).toMatchObject({ methodName: "trigger_refund_mode", args: { sale_id: "fairt" } });
    expect(h.signer.signDelegate.mock.calls[0][0]).toEqual(triggerRefundModeAction(CONTRACT, "fairt"));
    expect(await failure(h.client.triggerRefundMode("fairt", ALICE))).toMatchObject({ reason: "wrong_phase" });
  });
});

describe("wallet transactions (never relayed)", () => {
  it("closes a sale attaching get_close_deposit", async () => {
    const h = harness({ sale: { status: "awaiting_close" } });
    h.land.effect = () => h.chain.sales.set("fairt", saleView({ status: "clearing", closed_at: ns(NOW) }));
    const sale = await h.client.closeSale("fairt", ALICE);
    expect(sale.status).toBe("clearing");
    expect(h.relayer.relay).not.toHaveBeenCalled();
    expect(h.signer.signDelegate).not.toHaveBeenCalled();
    expect(h.signer.sendTransaction.mock.calls[0][0]).toEqual({
      receiverId: CONTRACT,
      methodName: "close_sale",
      args: { sale_id: "fairt" },
      gas: 300n * TGAS,
      deposit: OUTLAYER_COMPUTE_DEPOSIT,
    });
    expect(h.notices).toEqual([]);
    expect((await h.client.getEvents("fairt")).find((e) => e.kind === "closed")?.txHash).toBe("PAIDTX");
    expect(await failure(harness().client.closeSale("fairt", ALICE))).toMatchObject({ code: "invalid", message: "The bid window has not ended yet." });

    // Commit-reveal: the view says 0 and nothing is attached.
    const cr = harness({ sale: { status: "awaiting_close", reveal_mode: "CommitReveal" } });
    cr.chain.closeDeposit = "0";
    cr.land.effect = () => cr.chain.sales.set("fairt", saleView({ status: "revealing", reveal_mode: "CommitReveal" }));
    await cr.client.closeSale("fairt", ALICE);
    expect(cr.signer.sendTransaction.mock.calls[0][0].deposit).toBe(0n);
  });

  it("creates a sale attaching get_create_cost, with a start the chain will accept", async () => {
    const h = harness();
    const config = saleFromView(saleView()).config;
    const starting = { ...config, tokenSymbol: "NEWT", bidStart: NOW, bidEnd: NOW + 3_600_000 };
    h.land.effect = (action) => {
      const params = (action.args as { params: { sale_id: string; bid_start: string; bid_end: string } }).params;
      h.chain.sales.set(params.sale_id, saleView({ sale_id: params.sale_id, status: "setup", bid_start: params.bid_start, bid_end: params.bid_end }));
    };
    expect(await h.client.getCreateCost(ALICE, starting, { description: "", hue: 0 })).toBe(5_000_000_000_000_000_000_000_000n);
    const sale = await h.client.createSale(ALICE, starting, { description: "New.", hue: 0 });
    expect(sale).toMatchObject({ id: "newt", status: "upcoming", chainStatus: "setup" });
    const action = h.signer.sendTransaction.mock.calls[0][0];
    expect(action).toMatchObject({ receiverId: CONTRACT, methodName: "create_sale", gas: 300n * TGAS, deposit: 5_000_000_000_000_000_000_000_000n });
    const params = (action.args as { params: Record<string, unknown> }).params;
    // bid_start "now" would be in the past by the time the transaction lands: moved 2 minutes out, same window length.
    const start = Math.max(NOW, Date.now()) + 120_000;
    expect(nsToMs(String(params.bid_start))).toBeGreaterThanOrEqual(start - 5_000);
    expect(nsToMs(String(params.bid_end)) - nsToMs(String(params.bid_start))).toBe(3_600_000);
    expect(params).toMatchObject({ sale_id: "newt", quote_token: USDC_ID, reveal_mode: "Tee", max_bids: 100 });
    expect(sale.config.bidStart).toBe(nsToMs(String(params.bid_start)));
    expect(h.relayer.relay).not.toHaveBeenCalled();

    // A later start is left alone; an explicit id and lead are honoured.
    const later = { ...starting, tokenSymbol: "LATE", bidStart: NOW + 86_400_000, bidEnd: NOW + 90_000_000 };
    await h.client.createSale(ALICE, later, { description: "", hue: 0 }, { saleId: "late-1", minStartLeadMs: 1000 });
    const lateParams = (h.signer.sendTransaction.mock.calls[1][0].args as { params: Record<string, unknown> }).params;
    expect(lateParams).toMatchObject({ sale_id: "late-1", bid_start: ns(later.bidStart), bid_end: ns(later.bidEnd) });

    expect(await failure(h.client.createSale(ALICE, starting, { description: "", hue: 0 }))).toMatchObject({ message: "a sale with this id already exists" });
    expect((await failure(h.client.createSale(ALICE, starting, { description: "", hue: 0 }, { saleId: "Bad" }))).message).toMatch(/^invalid sale_id/);
    h.chain.createError = "invalid min_deposit: must satisfy 1 USDC (1000000) <= min_deposit <= max_deposit_per_account";
    const refused = await failure(h.client.createSale(ALICE, { ...starting, tokenSymbol: "LOW", minDeposit: 1n }, { description: "", hue: 0 }));
    expect(refused).toMatchObject({ code: "invalid", message: h.chain.createError });
    expect(h.signer.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("retries setup with OutLayer's deposit only when the key step failed", async () => {
    const h = harness({ sale: { status: "setup", sealer_key_setup: "failed", sealer_pubkey: null } });
    h.land.effect = () => h.chain.sales.set("fairt", saleView({ status: "setup", sealer_key_setup: "pending", sealer_pubkey: null }));
    const sale = await h.client.retrySetup("fairt", ALICE);
    expect(sale.sealerKeySetup).toBe("pending");
    expect(h.signer.sendTransaction.mock.calls[0][0]).toMatchObject({ methodName: "retry_setup", args: { sale_id: "fairt" }, deposit: OUTLAYER_COMPUTE_DEPOSIT, gas: 300n * TGAS });
    const token = harness({ sale: { status: "setup", token_setup: "failed" } });
    token.land.effect = () => token.chain.sales.set("fairt", saleView({ status: "setup", token_setup: "pending" }));
    await token.client.retrySetup("fairt", ALICE);
    expect(token.signer.sendTransaction.mock.calls[0][0].deposit).toBe(0n);
  });
});

describe("USDC storage and the faucet", () => {
  const NEWBIE = "newbie.test.near";

  it("does nothing for a registered account", async () => {
    const h = harness();
    expect(await h.client.ensureUsdcStorage(ALICE)).toEqual({ status: "already_registered", txHash: null });
    expect(h.relayer.sponsorStorage).not.toHaveBeenCalled();
  });

  it("has the relayer register a new account", async () => {
    const h = harness({ accounts: [NEWBIE] });
    h.relayer.sponsorStorage.mockImplementation(async (account) => {
      h.chain.registered.add(account);
      return { status: "registered", token_id: USDC_ID, tx_hash: "STORAGETX" };
    });
    expect(await h.client.ensureUsdcStorage(NEWBIE)).toEqual({ status: "sponsored", txHash: "STORAGETX" });
    expect(h.relayer.sponsorStorage).toHaveBeenCalledWith(NEWBIE, USDC_ID);
    expect(h.signers[NEWBIE].sendTransaction).not.toHaveBeenCalled();
    expect(h.notices).toMatchObject([{ kind: "storage_sponsored" }]);
  });

  it("counts already_registered, and rate_limited once the account is registered, as success", async () => {
    const a = harness({ accounts: [NEWBIE] });
    a.relayer.sponsorStorage.mockResolvedValue({ status: "already_registered", token_id: USDC_ID });
    expect(await a.client.ensureUsdcStorage(NEWBIE)).toEqual({ status: "already_registered", txHash: null });

    const b = harness({ accounts: [NEWBIE] });
    b.relayer.sponsorStorage.mockImplementation(async (account) => {
      // An earlier registration of this account is still landing.
      setTimeout(() => b.chain.registered.add(account), 30);
      throw refusal("rate_limited");
    });
    expect(await b.client.ensureUsdcStorage(NEWBIE)).toEqual({ status: "already_registered", txHash: null });
    expect(b.signers[NEWBIE].sendTransaction).not.toHaveBeenCalled();
  });

  it("pays the storage deposit itself when the relayer's budget is used up", async () => {
    for (const [make, reason] of [
      [() => harness({ accounts: [NEWBIE] }), "budget_exhausted"],
      [() => harness({ accounts: [NEWBIE], relayer: false }), "no_relayer"],
    ] as const) {
      const h = make();
      h.relayer.sponsorStorage.mockRejectedValue(new RelayerError("budget_exhausted", { status: 503, requestId: "r", maybeSubmitted: false }));
      h.land.effect = (action) => h.chain.registered.add(String(action.args.account_id));
      const asked: PaidReason[] = [];
      const result = await h.client.ensureUsdcStorage(NEWBIE, { onPaidFallback: (r) => void asked.push(r) });
      expect(result).toEqual({ status: "paid", txHash: "PAIDTX" });
      expect(asked).toEqual([reason]);
      expect(h.signers[NEWBIE].sendTransaction.mock.calls[0][0]).toEqual({
        receiverId: USDC_ID,
        methodName: "storage_deposit",
        args: { account_id: NEWBIE, registration_only: true },
        gas: 30n * TGAS,
        deposit: TOKEN_STORAGE_DEPOSIT,
      });
      expect(TOKEN_STORAGE_DEPOSIT).toBe(1_250_000_000_000_000_000_000n);
      expect(h.notices.at(-1)).toMatchObject({ kind: "storage_paid", reason });
      expect(h.notices.at(-1)!.message).toMatch(/0\.00125 NEAR/);
    }
  });

  it("stops when the storage payment is declined, and reports other refusals", async () => {
    const h = harness({ accounts: [NEWBIE] });
    h.relayer.sponsorStorage.mockRejectedValue(new RelayerError("budget_exhausted", { status: 503, requestId: "r", maybeSubmitted: false }));
    const e = await failure(
      h.client.ensureUsdcStorage(NEWBIE, {
        onPaidFallback: () => {
          throw new Error("no");
        },
      }),
    );
    expect(e.code).toBe("cancelled");
    expect(h.signers[NEWBIE].sendTransaction).not.toHaveBeenCalled();

    const unknown = harness({ accounts: [NEWBIE] });
    unknown.relayer.sponsorStorage.mockRejectedValue(new RelayerError("unknown_account", { status: 400, requestId: "r2", maybeSubmitted: false }));
    expect(await failure(unknown.client.ensureUsdcStorage(NEWBIE))).toMatchObject({ code: "relayer_refused", reason: "unknown_account", requestId: "r2" });

    const lost = harness({ accounts: [NEWBIE] });
    lost.relayer.sponsorStorage.mockRejectedValue(refusal("timeout", true, null));
    expect(await failure(lost.client.ensureUsdcStorage(NEWBIE))).toMatchObject({ code: "maybe_submitted", maybeSubmitted: true });
    expect(lost.signers[NEWBIE].sendTransaction).not.toHaveBeenCalled();
  });

  it("mints test USDC with a wallet transaction, registering first", async () => {
    const h = harness({ accounts: [NEWBIE] });
    h.relayer.sponsorStorage.mockImplementation(async (account) => {
      h.chain.registered.add(account);
      return { status: "registered", token_id: USDC_ID };
    });
    h.land.effect = (action) => {
      if (action.methodName === "mint") h.chain.usdc.set(NEWBIE, (h.chain.usdc.get(NEWBIE) ?? 0n) + BigInt(String(action.args.amount)));
    };
    expect(await h.client.faucet(NEWBIE, 25n * USDC)).toMatchObject({ account: NEWBIE, usdc: 25n * USDC });
    expect(h.relayer.sponsorStorage).toHaveBeenCalledTimes(1);
    expect(h.signers[NEWBIE].sendTransaction.mock.calls[0][0]).toEqual({
      receiverId: USDC_ID,
      methodName: "mint",
      args: { account_id: NEWBIE, amount: "25000000" },
      gas: 30n * TGAS,
      deposit: 0n,
    });
    const mainnet = new NearClient({ ...CONFIG, network: "mainnet" }, { rpc: h.rpc, relayer: null, signers: staticSigners({}) });
    expect(mainnet.capabilities.faucet).toBe(false);
    expect(await failure(mainnet.faucet(NEWBIE, USDC))).toMatchObject({ code: "not_supported" });
  });
});

describe("asking the relayer before signing", () => {
  it("pays directly, with the reason, when the relayer cannot be reached", async () => {
    const h = await sealedHarness();
    h.relayer.getPolicy.mockRejectedValue(new RelayerError("network_error", { status: null, requestId: null, maybeSubmitted: true }));
    h.land.effect = () => h.addBid(ALICE, 5n * USDC);
    h.signer.sendTransaction.mockImplementation(async (action) => {
      h.land.effect(action);
      return outcome("PAIDTX", [{ event: "bid_placed", data: {} }]);
    });
    const asked: PaidReason[] = [];
    const placed = await h.client.bid("fairt", ALICE, 5n * USDC, TERMS, { onPaidFallback: (r) => void asked.push(r) });
    expect(placed.relay).toMatchObject({ paidBy: "user", fallbackReason: "relay_failed", txHash: "PAIDTX", status: "succeeded" });
    expect(asked).toEqual(["relay_failed"]);
    // Nothing was signed for the relayer and nothing was sent to it, so nothing can land twice.
    expect(h.signer.signDelegate).not.toHaveBeenCalled();
    expect(h.relayer.relay).not.toHaveBeenCalled();
    expect(h.signer.sendTransaction).toHaveBeenCalledTimes(1);
    expect(await h.client.getRelayerPolicy()).toBeNull();
    // It asks again next time: the relayer may be back.
    expect(h.relayer.getPolicy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("pays directly when the relayer's policy does not cover the call", async () => {
    const revealing = { reveal_mode: "CommitReveal" as const, status: "revealing" as const, closed_at: ns(NOW - 700_000), reveal_end: ns(NOW - 100_000) };
    const h = harness({ sale: revealing });
    const policy = await h.relayer.getPolicy();
    // An older relayer that does not relay clear_onchain.
    h.relayer.getPolicy.mockResolvedValue({ ...policy, fairground_methods: ["claim", "claim_proceeds", "reveal_bid", "trigger_refund_mode"] });
    h.land.effect = () => h.chain.sales.set("fairt", saleView({ ...revealing, status: "settled", refund_mode_at: null }));
    const cleared = await h.client.clearOnchain("fairt", ALICE);
    expect(cleared.relay).toMatchObject({ paidBy: "user", fallbackReason: "method_not_relayed" });
    expect(h.signer.signDelegate).not.toHaveBeenCalled();
    expect(h.relayer.relay).not.toHaveBeenCalled();
    expect(h.notices).toMatchObject([{ kind: "paid_fallback", reason: "method_not_relayed" }]);

    // A sale paid in a USDC contract the relayer does not sponsor.
    const other = await sealedHarness({ sale: { quote_token: "other-usdc.test.near" } });
    other.land.effect = () => other.addBid(ALICE, 5n * USDC);
    const placed = await other.client.bid("fairt", ALICE, 5n * USDC, TERMS);
    expect(placed.relay).toMatchObject({ paidBy: "user", fallbackReason: "method_not_relayed" });
    expect(other.signer.sendTransaction.mock.calls[0][0].receiverId).toBe("other-usdc.test.near");
    expect(other.relayer.relay).not.toHaveBeenCalled();
  });

  it("asks once for several calls in a row, and not at all for a wallet that cannot sign delegates", async () => {
    const h = await sealedHarness();
    h.relayer.relay.mockImplementation(async () => {
      h.addBid(ALICE, 5n * USDC);
      return { tx_hash: "T", status: "succeeded", outcome: { failures: [], events: [{ event: "bid_placed", data: {} }], relayer_cost: "0" } };
    });
    await h.client.bid("fairt", ALICE, 5n * USDC, TERMS);
    await h.client.getRelayerPolicy();
    await h.client.getRelayerPolicy();
    expect(h.relayer.getPolicy).toHaveBeenCalledTimes(1);

    const plain = await sealedHarness({ signsDelegates: false });
    plain.land.effect = () => plain.addBid(ALICE, 5n * USDC);
    plain.relayer.getPolicy.mockRejectedValue(new RelayerError("network_error", { status: null, requestId: null, maybeSubmitted: true }));
    const placed = await plain.client.bid("fairt", ALICE, 5n * USDC, TERMS);
    // The wallet is the reason, whatever state the relayer is in.
    expect(placed.relay).toMatchObject({ paidBy: "user", fallbackReason: "delegates_unsupported" });
    expect(plain.relayer.getPolicy).not.toHaveBeenCalled();
  });
});
