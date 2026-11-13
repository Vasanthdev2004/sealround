/**
 * In-browser mock of the Fairground contract + OutLayer sealer.
 *
 * What is real here: libsodium sealed-box encryption of every bid (padded
 * plaintext, exact ciphertext length), the clearing algorithm
 * (@fairground/clearing, the code the enclave mirrors), the running bid-set
 * hash and commitments (DESIGN v1), the contract's rules (rules.ts): bid
 * rejections with the contract's reason codes, the result checks, the 1 %
 * invalid-bid penalty, commit-reveal with on-chain clearing.
 * What is simulated: chain state (localStorage), tx hashes, the enclave's
 * secret key (held in this browser), the TDX attestation, test USDC, the
 * relayer (every call is "gasless").
 * Every simulated thing is labelled in the UI.
 */

import {
  BidSetHasher,
  bidSetHash,
  clear,
  ClearingError,
  MAX_POOL_FEE_BPS,
  MAX_RAISE_SHARE_BPS,
  poolPlan,
  type Bid as ClearingBid,
  type InvalidReason,
  type SaleParams,
} from "@fairground/clearing";
import type {
  AttestationFact,
  AttestedRun,
  Balances,
  BidRecord,
  BidResult,
  BidTerms,
  ChainFailReason,
  ClaimReceipt,
  ClaimResult,
  ClientCapabilities,
  ClientNotice,
  CreateOptions,
  DexPool,
  LiquidityState,
  LiquidityStep,
  LiquidityWriteResult,
  RelayerPolicyInfo,
  RelayInfo,
  RevealTerms,
  RunCheck,
  RunKind,
  Sale,
  SaleConfig,
  SaleEvent,
  SaleEventKind,
  SaleMeta,
  SaleResult,
  SaleStatus,
  SaleVerification,
  SaleWithRelay,
  StorageResult,
  WriteResult,
} from "../types";
import {
  bidCommitment,
  fakeTxHash,
  fromB64,
  fromHex,
  newSaleKeypair,
  openBid,
  randomHex,
  sealBid,
  sha256Hex,
  toB64,
} from "../crypto";
import { getBidSecret, saveBidSecret } from "../bid-secrets";
import { locksTokens, poolUsdcKept, SEED_STEPS, STAGE_LABEL, stepPhrase } from "../liquidity";
import { iconError, markIcon } from "../token-icon";
import { makeBots, makeCrowd, type CrowdBidder } from "./crowd";
import { bidRejected, BID_REJECT_MESSAGES, FairgroundError } from "./errors";
import type { BidPayload, FairgroundClient, JudgeProgress } from "./index";
import {
  appFailReason,
  bidTermsProblem,
  checkClearOutput,
  checkRows,
  ciphertextProblem,
  commitmentProblem,
  DEFAULT_REVEAL_WINDOW_MS,
  invalidBidPenalty,
  MAX_BID_WINDOW_MS,
  MAX_BIDS_PER_SALE,
  MAX_REVEAL_WINDOW_MS,
  MAX_SETTLE_TIMEOUT_MS,
  MIN_DEPOSIT_FLOOR,
  MIN_DEPOSIT_MESSAGE,
  MIN_REVEAL_WINDOW_MS,
  MIN_SETTLE_TIMEOUT_MS,
  outcomeReason,
  saleIdError,
  tokenAccountOf,
  unsoldOf,
  type SealerClearOutput,
} from "./rules";

const STORAGE_KEY = "fairground:mock:v2";
/** State written by earlier builds (other hash and result formats). Read once for guest balances, then removed. */
const OLD_STORAGE_KEY = "fairground:mock:v1";
export const CONTRACT_ID = "fairground.testnet";
export const USDC_TOKEN = "usdc.fakes.testnet";
/** Scope of the mock's commit-reveal secrets in lib/bid-secrets, so they never mix with a real contract's. */
export const MOCK_SECRETS_SCOPE = `mock:${CONTRACT_ID}`;
/**
 * The sha256 of our reproducible fairground-sealer build (enclave/res), the
 * build the real contract pins. The simulated enclave claims to run it.
 */
export const SEALER_CODE_HASH =
  "f8408a875ec685394d00937cfc320c8b5e8c2a1e8398cfdf34987aa91001d8cb";
/** The placeholder earlier builds stored on every sale; read as SEALER_CODE_HASH. */
const OLD_SEALER_CODE_HASH = "7f3a9c2e51d84b06a1e9f0c3d27b8e4f6a5c1d903e2b7f48c6a0d15e9b3f2a71";

const USDC = 1_000_000n;
const TOKEN = 10n ** 18n;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** What a guest account is given again when state from an earlier build is replaced. */
const WELCOME_USDC = 100n * USDC;
/** The exchange the simulated chain pretends to seed launch pools on: Rhea on testnet. */
export const MOCK_DEX = "ref-finance-101.testnet";
/** LP shares a new Ref simple pool mints for its first liquidity (INIT_SHARES_SUPPLY). */
const INIT_POOL_SHARES = 10n ** 24n;
/** How long each simulated seeding step takes. */
const STEP_MS = 450;

type Phase = "bidding" | "clearing" | "revealing" | "settled" | "failed";
/** Fields of Sale that `view` derives from the rest on every read. */
type Derived =
  | "status"
  | "chainStatus"
  | "revealEnd"
  | "refundModeFrom"
  | "chainFailReason"
  | "runningBidSetHash"
  | "maxBids"
  | "tokenSetup"
  | "sealerKeySetup";
type StoredSale = Omit<Sale, Derived> & {
  phase: Phase;
  /** The running bid-set hash h_n over the bids so far, hex (the contract's `bid_set_state`). */
  bidSetState: string;
  /** Demo: simulate an enclave that never answers, to show refund mode. */
  enclaveDown?: boolean;
};

type State = {
  version: 2;
  sales: Record<string, StoredSale>;
  bids: Record<string, BidRecord[]>;
  events: Record<string, SaleEvent[]>;
  results: Record<string, SaleResult>;
  balances: Record<string, Balances>;
  /** Simulated enclave memory. In production these never leave the TEE. */
  keys: Record<string, { pk: string; sk: string }>;
  /** Commit-reveal: revealed terms by sale and bid index (the contract's `record.reveal`). */
  reveals: Record<string, Record<number, { maxPrice: bigint; maxSpend: bigint }>>;
  judgeCount: number;
  /** Faucet idempotency keys already used (simulated 1Click swaps). */
  faucetKeys?: Record<string, true>;
  /** Ids of rolling copies of the live demo sale ("fairt-2", ...), in order. */
  rolled?: string[];
  /** What claim_proceeds has paid per sale (the contract's `proceeds`), so a part owed later is paid then. */
  paid?: Record<string, ProceedsPaid>;
};

type ProceedsPaid = { raise: bigint; burned: bigint; allocation: boolean; reserve: boolean };

/** The demo sales seeded on first visit. Their times are relative to that visit. */
const SEEDED_IDS = ["lantern", "driftwood", "ashfall", "kiln", "fairt", "moth"];
/** The seeded sale that is taking bids on first visit. Rolling copies are made from it. */
const LIVE_SEED = "fairt";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const txLatency = () => delay(180 + Math.random() * 320);

function replacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? { $b: v.toString() } : v;
}
function reviver(_k: string, v: unknown) {
  if (v && typeof v === "object" && "$b" in v && Object.keys(v).length === 1) {
    return BigInt((v as { $b: string }).$b);
  }
  return v;
}

function deriveStatus(s: StoredSale, now: number): SaleStatus {
  if (s.phase !== "bidding") return s.phase;
  if (now < s.config.bidStart) return "upcoming";
  if (now < s.config.bidEnd) return "open";
  return "awaiting_close";
}

const revealWindowOf = (c: SaleConfig) => c.revealWindowMs ?? DEFAULT_REVEAL_WINDOW_MS;
const maxBidsOf = (c: SaleConfig) => c.maxBids ?? MAX_BIDS_PER_SALE;
const isFinal = (s: StoredSale) => s.phase === "settled" || s.phase === "failed";

/** End of the reveal window (commit-reveal, once closed), like sale.rs `reveal_end`. */
function revealEndOf(s: StoredSale): number | null {
  return s.config.revealMode === "commit_reveal" && s.closedAt !== null ? s.closedAt + revealWindowOf(s.config) : null;
}

/** When trigger_refund_mode becomes possible (sale.rs `refund_mode_at`); null once final. */
function refundModeFromOf(s: StoredSale): number | null {
  if (isFinal(s)) return null;
  const reference =
    s.phase === "revealing"
      ? (revealEndOf(s) ?? s.config.bidEnd)
      : s.phase === "clearing"
        ? (s.closedAt ?? s.config.bidEnd)
        : s.config.bidEnd;
  return reference + s.config.settleTimeoutMs;
}

function usdcOf(whole: number): bigint {
  return BigInt(Math.round(whole * 1_000_000));
}

/** The bytes a bid adds to the bid-set hash: the ciphertext, or the 32-byte commitment. */
const payloadBytes = (b: BidRecord): Uint8Array => fromB64(b.ciphertext);

/** A simulated relay: on the mock chain every call counts as paid by the relayer. */
const simRelay = (txHash: string): RelayInfo => ({
  paidBy: "relayer",
  fallbackReason: null,
  txHash,
  status: "succeeded",
  requestId: null,
  simulated: true,
});

const invalid = (message: string, reason?: string) => new FairgroundError("invalid", message, { reason });

/**
 * A copied ciphertext is only accepted from an account whose id is as long as
 * the victim's: the contract checks the exact sealed length, which includes
 * the bidder id. The demo's copycat registers a name of the right length.
 */
function copycatAccount(length: number): string {
  const suffix = ".testnet";
  const base = "copycat-bot";
  const want = Math.max(2, length - suffix.length);
  if (want >= base.length) return base + "0".repeat(want - base.length) + suffix;
  return base.slice(0, want).replace(/-$/, "x") + suffix;
}

/** The first bid by a fictional person at or after `from` whose id is as long as the usual copycat's, else the one at `from`. */
function pickVictim(people: BidRecord[], from: number): BidRecord {
  const usual = copycatAccount(19).length;
  return people.slice(from).find((b) => b.bidder.length === usual) ?? people[Math.min(from, people.length - 1)];
}

export class MockClient implements FairgroundClient {
  readonly mode = "mock" as const;
  readonly contractId = CONTRACT_ID;
  readonly usdcContract = USDC_TOKEN;
  readonly secretsScope = MOCK_SECRETS_SCOPE;
  readonly capabilities: ClientCapabilities = {
    judgeMode: true,
    faucet: true,
    reset: true,
    relayer: true,
    simulated: true,
  };

  private state: State | null = null;
  private loading: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private clearing = new Map<string, Promise<void>>();

  // ---------- lifecycle ----------

  ready(): Promise<void> {
    // Not `if (this.state)`: state is assigned before seeding finishes, and a
    // caller must never see (or act on) a half-seeded state.
    if (!this.loading) this.loading = this.load();
    return this.loading;
  }

  private async load() {
    const raw = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw, reviver) as State;
        this.state = parsed.version === 2 ? parsed : null;
      } catch {
        this.state = null;
      }
    }
    if (!this.state) {
      this.state = this.empty();
      await this.seed();
      this.carryOverGuests();
      this.persist();
    } else if (!this.hasLiveSeed(Date.now())) {
      await this.refreshSeed(Date.now());
      this.persist();
    }
    // Sales stored by builds that used a placeholder build hash.
    for (const s of Object.values(this.state.sales)) {
      if (s.sealerCodeHash === OLD_SEALER_CODE_HASH) s.sealerCodeHash = SEALER_CODE_HASH;
      // Demo sales stored before tokens had icons get their generated mark.
      if (s.meta.icon === undefined) {
        const mark = demoMark(s.id, s.isJudgeSale);
        if (mark) s.meta.icon = markIcon(mark, s.meta.hue);
      }
    }
    // A seeding step cut off by a closed page: its callback never ran, so count it failed and let it run again.
    for (const r of Object.values(this.state.results)) {
      const l = r.liquidity;
      if (l?.inFlight) {
        l.nextStep = l.inFlight;
        l.inFlight = null;
        l.failures += 1;
      }
    }
    if (typeof window !== "undefined") {
      window.addEventListener("storage", (e) => {
        if (e.key === STORAGE_KEY && e.newValue) {
          this.state = JSON.parse(e.newValue, reviver) as State;
          this.emit();
        }
      });
    }
    // Resume any clearing that was in flight when the page closed.
    for (const s of Object.values(this.state.sales)) {
      if (s.phase === "clearing" && !s.enclaveDown) this.scheduleClearing(s.id, 800);
    }
  }

  private empty(): State {
    return {
      version: 2,
      sales: {},
      bids: {},
      events: {},
      results: {},
      balances: {},
      keys: {},
      reveals: {},
      judgeCount: 0,
      rolled: [],
    };
  }

  /**
   * State from an earlier build cannot be read (its hashes and results had
   * another format), so it is replaced. Guest accounts get their welcome USDC
   * again so a returning visitor is not left with an empty wallet.
   */
  private carryOverGuests() {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(OLD_STORAGE_KEY);
      if (!raw) return;
      const old = JSON.parse(raw, reviver) as { balances?: Record<string, unknown> };
      for (const account of Object.keys(old.balances ?? {})) {
        if (/^guest-[0-9a-f]+\.testnet$/.test(account)) this.credit(account, WELCOME_USDC);
      }
      localStorage.removeItem(OLD_STORAGE_KEY);
    } catch {
      /* unreadable old state: nothing to carry over */
    }
  }

  private get s(): State {
    if (!this.state) throw new Error("client not ready: await client.ready()");
    return this.state;
  }

  private persist() {
    if (typeof window === "undefined" || !this.state) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state, replacer));
    } catch {
      /* storage full or blocked: state stays in memory */
    }
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  private commit() {
    this.persist();
    this.emit();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The mock has nothing to announce: no call is ever paid by the user. */
  subscribeNotices(listener: (n: ClientNotice) => void) {
    void listener;
    return () => {};
  }

  async reset() {
    this.state = this.empty();
    this.clearing.clear();
    this.seeding = true;
    try {
      await this.seed();
    } finally {
      this.seeding = false;
    }
    this.commit();
  }

  // ---------- demo seed upkeep ----------
  //
  // The seeded sales are timed from the first visit, so after a while none of
  // them is taking bids. Two rules keep the board alive:
  // - On load, when no seeded sale is live, re-seed them from now. Sales this
  //   browser has bid in are never touched; if the live demo sale is one of
  //   them, a rolling copy of it opens instead ("Fair Test 2", id fairt-2).
  // - During a session nothing is re-seeded (sales would change under the
  //   viewer); a rolling copy opens as soon as no seeded sale is live.

  /** The seeded sales plus their rolling copies. */
  private seededIds(): string[] {
    return [...SEEDED_IDS, ...(this.s.rolled ?? [])];
  }

  /** Whether a seeded sale has a bid made in this browser (seeded bidders are tagged). */
  private hasUserBids(id: string): boolean {
    return (this.s.bids[id] ?? []).some((b) => !b.tag || b.tag === "you");
  }

  private hasLiveSeed(now: number): boolean {
    return this.seededIds().some((id) => {
      const s = this.s.sales[id];
      return !!s && deriveStatus(s, now) === "open";
    });
  }

  /** Re-seed from `now`. User-created sales, judge runs, balances and any seeded sale with a user bid stay. */
  private async refreshSeed(now: number) {
    const keep = new Set(this.seededIds().filter((id) => this.hasUserBids(id)));
    for (const id of this.seededIds()) {
      if (keep.has(id)) continue;
      delete this.s.sales[id];
      delete this.s.bids[id];
      delete this.s.events[id];
      delete this.s.results[id];
      delete this.s.keys[id];
      delete this.s.reveals[id];
      this.clearing.delete(id);
    }
    this.s.rolled = (this.s.rolled ?? []).filter((id) => keep.has(id));
    await this.seed(now, keep);
    if (!this.hasLiveSeed(now)) await this.rollLive(now);
  }

  /**
   * Opens a fresh copy of the live demo sale: same rules and bidder mix, a new
   * window (opened 40 minutes ago, 2 hours left) and a new id, symbol and name.
   * Touches no existing sale. Deterministic: round N always gets the same
   * fictional bidders.
   */
  private async rollLive(now: number) {
    const base = seedDefs(now).find((d) => d.id === LIVE_SEED);
    if (!base) return;
    const taken = (n: number) =>
      !!this.s.sales[`${LIVE_SEED}-${n}`] ||
      Object.values(this.s.sales).some((s) => s.config.tokenSymbol === `${base.symbol}${n}`);
    let n = 2;
    while (taken(n)) n++;
    const id = `${LIVE_SEED}-${n}`;
    await this.seedSale(
      {
        ...base,
        id,
        name: `${base.name} ${n}`,
        symbol: `${base.symbol}${n}`,
        description: `Round ${n} of the reference sale: same rules, a fresh bid window.`,
        crowdSeed: n,
      },
      now,
    );
    (this.s.rolled ??= []).push(id);
  }

  private ensuring: Promise<void> | null = null;
  /** True while reset() re-seeds: the state is half-built, so upkeep waits. */
  private seeding = false;

  /** Session-time upkeep (see above): open a rolling copy when no seeded sale is live. */
  private ensureLiveSeed(): Promise<void> {
    if (this.ensuring) return this.ensuring;
    if (this.seeding || this.hasLiveSeed(Date.now())) return Promise.resolve();
    this.ensuring = this.rollLive(Date.now())
      .then(() => this.commit())
      .catch((e: unknown) => console.warn("fairground: could not open a rolling demo sale", e))
      .finally(() => {
        this.ensuring = null;
      });
    return this.ensuring;
  }

  /** Whether another tab already stored this faucet key (it may not have reached us yet). */
  private storedFaucetKey(key: string): boolean {
    if (typeof window === "undefined") return false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return !!raw && !!(JSON.parse(raw, reviver) as State).faucetKeys?.[key];
    } catch {
      return false;
    }
  }

  // ---------- views ----------

  private view(s: StoredSale): Sale {
    const { phase, enclaveDown, bidSetState, ...rest } = s;
    void phase;
    void enclaveDown;
    const status = deriveStatus(s, Date.now());
    return {
      ...rest,
      status,
      // The mock has no setup phase and never leaves a sale "closed" for a retry.
      chainStatus: status,
      maxBids: maxBidsOf(s.config),
      revealEnd: revealEndOf(s),
      refundModeFrom: refundModeFromOf(s),
      chainFailReason: s.phase === "failed" ? (this.s.results[s.id]?.chainFailReason ?? null) : null,
      tokenSetup: "done",
      sealerKeySetup: "done",
      runningBidSetHash: bidSetState,
    };
  }

  private sale(saleId: string): StoredSale {
    const sale = this.s.sales[saleId];
    if (!sale) throw invalid("There is no sale with this id.", "unknown_sale");
    return sale;
  }

  async listSales() {
    await this.ready();
    await this.ensureLiveSeed();
    return Object.values(this.s.sales)
      .map((s) => this.view(s))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async getSale(id: string) {
    await this.ready();
    const s = this.s.sales[id];
    return s ? this.view(s) : null;
  }

  async getBids(id: string) {
    await this.ready();
    return [...(this.s.bids[id] ?? [])];
  }

  async getBid(saleId: string, bidder: string) {
    await this.ready();
    return (this.s.bids[saleId] ?? []).find((b) => b.bidder === bidder) ?? null;
  }

  async getEvents(id: string) {
    await this.ready();
    return [...(this.s.events[id] ?? [])].sort((a, b) => b.at - a.at);
  }

  async getResult(id: string) {
    await this.ready();
    return this.s.results[id] ?? null;
  }

  async getBalances(account: string): Promise<Balances> {
    await this.ready();
    return this.balancesOf(account);
  }

  private balancesOf(account: string): Balances {
    if (!this.s.balances[account]) {
      this.s.balances[account] = { account, usdc: 0n, tokens: {} };
    }
    const b = this.s.balances[account];
    return { ...b, tokens: { ...b.tokens } };
  }

  private credit(account: string, usdc: bigint, saleId?: string, tokens?: bigint) {
    const b = (this.s.balances[account] ??= { account, usdc: 0n, tokens: {} });
    b.usdc += usdc;
    if (saleId && tokens) b.tokens[saleId] = (b.tokens[saleId] ?? 0n) + tokens;
  }

  expectedCodeHash() {
    return SEALER_CODE_HASH;
  }

  async getRelayerPolicy(): Promise<RelayerPolicyInfo> {
    return {
      relayerAccountId: `relayer.${CONTRACT_ID}`,
      methods: ["claim", "claim_proceeds", "clear_onchain", "reveal_bid", "trigger_refund_mode"],
      usdcContracts: [USDC_TOKEN],
      simulated: true,
    };
  }

  // ---------- events ----------

  private log(
    saleId: string,
    kind: SaleEventKind,
    note: string,
    extra: Partial<SaleEvent> = {},
  ): SaleEvent {
    const e: SaleEvent = {
      saleId,
      kind,
      at: extra.at ?? Date.now(),
      txHash: extra.txHash ?? fakeTxHash(),
      note,
      source: "simulated",
      ...extra,
    };
    (this.s.events[saleId] ??= []).push(e);
    return e;
  }

  // ---------- create ----------

  /** The mock charges no NEAR; it validates like create_sale does. */
  async getCreateCost(creator: string, config: SaleConfig, meta: SaleMeta): Promise<bigint> {
    void creator;
    await this.ready();
    validateConfig(config, Object.values(this.s.sales));
    validateIcon(meta);
    return 0n;
  }

  async createSale(creator: string, config: SaleConfig, meta: SaleMeta, opts: CreateOptions = {}) {
    await this.ready();
    validateConfig(config, Object.values(this.s.sales));
    validateIcon(meta);
    const id = opts.saleId ?? config.tokenSymbol.toLowerCase();
    const idError = saleIdError(id, CONTRACT_ID);
    if (idError) throw invalid(idError);
    if (opts.saleId && this.s.sales[id]) throw invalid("a sale with this id already exists");
    await txLatency();
    const sale = await this.insertSale(creator, config, meta, Date.now(), { id });
    this.commit();
    return this.view(sale);
  }

  private async insertSale(
    creator: string,
    config: SaleConfig,
    meta: SaleMeta,
    createdAt: number,
    opts: { id?: string; judge?: boolean } = {},
  ): Promise<StoredSale> {
    const sym = config.tokenSymbol.toLowerCase();
    let id = opts.id ?? sym;
    for (let i = 2; this.s.sales[id]; i++) id = `${sym}-${i}`;
    const idError = saleIdError(id, CONTRACT_ID);
    if (idError) throw invalid(idError);
    const keys = await newSaleKeypair();
    this.s.keys[id] = { pk: keys.publicKey, sk: keys.secretKey };
    const createTx = fakeTxHash();
    const sale: StoredSale = {
      id,
      creator,
      tokenAccount: tokenAccountOf(id, CONTRACT_ID),
      config,
      meta,
      phase: "bidding",
      createdAt,
      createTx,
      sealerPubkey: keys.publicKey,
      sealerCodeHash: SEALER_CODE_HASH,
      bidSetHash: null,
      bidSetState: new BidSetHasher(id).hex(),
      closedAt: null,
      settledAt: null,
      refundModeAt: null,
      bidCount: 0,
      totalDeposits: 0n,
      isJudgeSale: !!opts.judge,
    };
    this.s.sales[id] = sale;
    this.s.bids[id] = [];
    this.log(id, "created", `Sale created. ${config.tokenSymbol} deployed with fixed supply, no admin key.`, {
      at: createdAt,
      account: creator,
      txHash: createTx,
    });
    return sale;
  }

  // ---------- bid ----------

  async placeBid(saleId: string, bidder: string, deposit: bigint, ciphertext: string): Promise<BidResult> {
    return this.placeBidPayload(saleId, bidder, deposit, { ciphertext });
  }

  async placeBidPayload(saleId: string, bidder: string, deposit: bigint, payload: BidPayload): Promise<BidResult> {
    await this.ready();
    await txLatency();
    const bid = this.insertBid(saleId, bidder, deposit, payload, Date.now());
    this.commit();
    return { ...bid, relay: simRelay(bid.txHash) };
  }

  async bid(saleId: string, bidder: string, deposit: bigint, terms: BidTerms): Promise<BidResult> {
    await this.ready();
    const sale = this.sale(saleId);
    const problem = bidTermsProblem(terms, deposit, sale.config.floorPrice);
    if (problem) throw invalid(`${problem} Such a bid would be void and lose 1 % of its deposit.`);
    const salt = randomHex(16);
    if (sale.config.revealMode === "tee") {
      const ciphertext = await sealBid(sale.sealerPubkey, {
        sale_id: saleId,
        bidder,
        max_price: terms.maxPrice.toString(),
        max_spend: terms.maxSpend.toString(),
        salt,
      });
      return this.placeBidPayload(saleId, bidder, deposit, { ciphertext });
    }
    // One bid per account: never replace the secret of a bid that is already in the sale.
    if ((this.s.bids[saleId] ?? []).some((b) => b.bidder === bidder)) {
      throw invalid(BID_REJECT_MESSAGES.already_bid, "already_bid");
    }
    const commitment = bidCommitment({ saleId, bidder, maxPrice: terms.maxPrice, maxSpend: terms.maxSpend, salt });
    // Saved before the bid is sent: a bid that landed can always be revealed.
    saveBidSecret({
      contract: MOCK_SECRETS_SCOPE,
      saleId,
      bidder,
      maxPrice: terms.maxPrice.toString(),
      maxSpend: terms.maxSpend.toString(),
      salt,
      commitment,
      deposit: deposit.toString(),
      savedAt: Date.now(),
    });
    const placed = await this.placeBidPayload(saleId, bidder, deposit, { commitment });
    return { ...placed, secret: { salt, commitment } };
  }

  /**
   * The contract's ft_on_transfer, in its order (bids.rs): a refused bid gets
   * its deposit back with a `bid_rejected` event and the reason. The balance
   * check comes first, as on chain the USDC transfer does.
   */
  private insertBid(
    saleId: string,
    bidder: string,
    deposit: bigint,
    payload: BidPayload,
    at: number,
    tag?: BidRecord["tag"],
    opts: { skipBalance?: boolean; skipWindow?: boolean } = {},
  ): BidRecord {
    const sale = this.s.sales[saleId];
    if (!sale) throw bidRejected("unknown_sale");
    const c = sale.config;
    if (!opts.skipBalance && this.balancesOf(bidder).usdc < deposit) {
      // Nothing reaches Fairground: the token refuses the transfer.
      throw invalid("Not enough USDC. Use the faucet or fund from another chain.", "insufficient_balance");
    }
    const reject = (reason: keyof typeof BID_REJECT_MESSAGES, detail?: string): never => {
      const error = bidRejected(reason, detail);
      this.log(saleId, "bid_rejected", `Deposit returned: ${detail ?? BID_REJECT_MESSAGES[reason]}`, {
        at,
        account: bidder,
        amount: deposit,
        reason,
      });
      this.commit();
      throw error;
    };
    if (!opts.skipWindow) {
      const st = deriveStatus(sale, at);
      if (st !== "open") {
        reject("not_open", st === "upcoming" ? "The bid window has not opened yet." : "The bid window is closed.");
      }
    }
    const isCiphertext = "ciphertext" in payload;
    if (isCiphertext !== (c.revealMode === "tee")) reject("wrong_payload");
    const problem = isCiphertext
      ? ciphertextProblem(payload.ciphertext, saleId, bidder)
      : commitmentProblem(payload.commitment);
    if (problem) reject(problem);
    if (deposit < c.minDeposit) reject("below_min_deposit", `Minimum deposit is ${fmt(c.minDeposit)} USDC.`);
    if (deposit > c.maxDepositPerAccount) {
      reject("above_max_deposit", `Maximum deposit per account is ${fmt(c.maxDepositPerAccount)} USDC.`);
    }
    const bids = (this.s.bids[saleId] ??= []);
    if (bids.some((b) => b.bidder === bidder)) reject("already_bid");
    if (bids.length >= maxBidsOf(c)) reject("sale_full");

    if (!opts.skipBalance) this.s.balances[bidder].usdc -= deposit;
    const rec: BidRecord = {
      saleId,
      index: bids.length,
      bidder,
      deposit,
      // Both kinds are stored as the contract's view shows them: standard base64.
      ciphertext: isCiphertext ? payload.ciphertext : toB64(fromHex(payload.commitment.toLowerCase())),
      placedAt: at,
      txHash: fakeTxHash(),
      claimed: false,
      claimTx: null,
      payloadKind: isCiphertext ? "ciphertext" : "commitment",
      ...(isCiphertext ? {} : { revealed: false }),
      ...(tag ? { tag } : {}),
    };
    bids.push(rec);
    sale.bidCount += 1;
    sale.totalDeposits += deposit;
    sale.bidSetState = BidSetHasher.resume(fromHex(sale.bidSetState), rec.index)
      .push(bidder, deposit, payloadBytes(rec))
      .hex();
    this.log(
      saleId,
      "bid",
      isCiphertext
        ? `Sealed bid with ${fmt(deposit)} USDC deposit. Price hidden.`
        : `Committed bid with ${fmt(deposit)} USDC deposit. Price hidden until the reveal.`,
      { at, account: bidder, amount: deposit, txHash: rec.txHash },
    );
    return rec;
  }

  /** The bid-set hash of the whole bid list, from scratch (what the enclave recomputes from its input). */
  private bidSetHashOf(saleId: string): string {
    return bidSetHash(
      saleId,
      (this.s.bids[saleId] ?? []).map((b) => ({ bidder: b.bidder, deposit: b.deposit, payload: payloadBytes(b) })),
    );
  }

  // ---------- close + clear ----------

  /** The mock's close needs no OutLayer deposit. */
  async getCloseDeposit(saleId: string): Promise<bigint> {
    await this.ready();
    this.sale(saleId);
    return 0n;
  }

  async closeSale(saleId: string, caller: string) {
    await this.ready();
    await txLatency();
    const sale = this.closeInternal(saleId, caller, Date.now());
    this.commit();
    if (sale.phase === "clearing" && !sale.enclaveDown) this.scheduleClearing(saleId, 1400 + Math.random() * 1200);
    return this.view(sale);
  }

  /**
   * close_sale (settle.rs): freezes the bid set. No bids: the sale fails.
   * Commit-reveal: the reveal window opens. TEE: the bids go to the enclave.
   */
  private closeInternal(saleId: string, caller: string, at: number): StoredSale {
    const sale = this.sale(saleId);
    const st = deriveStatus(sale, at);
    if (st !== "awaiting_close") {
      throw invalid(st === "open" || st === "upcoming" ? "The bid window has not ended yet." : "This sale is already closed.");
    }
    sale.closedAt = at;
    sale.bidSetHash = sale.bidSetState;
    this.log(saleId, "closed", `Bid set frozen at ${sale.bidCount} bids.`, { at, account: caller });
    if (sale.bidCount === 0) {
      this.finalize(sale, at + 1, {
        clearedBy: "none",
        failReason: "no_bids",
        note: "Closed with no bids. Nothing to refund.",
      });
    } else if (sale.config.revealMode === "commit_reveal") {
      sale.phase = "revealing";
    } else {
      sale.phase = "clearing";
      this.log(saleId, "clearing_requested", "Sealed bids sent to the OutLayer enclave (yield/resume).", { at: at + 1 });
    }
    return sale;
  }

  private scheduleClearing(saleId: string, ms: number) {
    if (this.clearing.has(saleId)) return;
    const p = delay(ms)
      .then(() => this.runEnclave(saleId))
      .then(() => this.commit())
      .finally(() => this.clearing.delete(saleId));
    this.clearing.set(saleId, p);
  }

  private clearingParams(c: SaleConfig): SaleParams {
    return {
      saleSupply: c.saleSupply,
      floorPrice: c.floorPrice,
      minRaise: c.minRaise,
      decimals: c.decimals,
      maxPrice: c.maxPrice,
    };
  }

  /**
   * Simulated fairground-sealer job (decrypt, clear, answer in the DESIGN
   * output format), then the contract's on_clearing_result: every check in
   * rules.ts, penalties for the bids the enclave lists as invalid, and the
   * outcome.
   */
  private async runEnclave(saleId: string, at = Date.now()) {
    const t0 = performance.now();
    const sale = this.s.sales[saleId];
    if (!sale || sale.phase !== "clearing") return;
    const key = this.s.keys[saleId];
    const bids = this.s.bids[saleId] ?? [];
    const c = sale.config;

    // ----- inside the enclave -----
    const decoded: ClearingBid[] = await Promise.all(
      bids.map(async (b) => {
        const pt = await openBid(b.ciphertext, key.pk, key.sk);
        if (!pt) return { bidder: b.bidder, deposit: b.deposit, maxPrice: null, maxSpend: null };
        return {
          bidder: b.bidder,
          deposit: b.deposit,
          maxPrice: BigInt(pt.max_price),
          maxSpend: BigInt(pt.max_spend),
          mismatch: pt.sale_id !== saleId || pt.bidder !== b.bidder,
        };
      }),
    );
    const params = this.clearingParams(c);
    // The enclave reports the hash of the bid set it actually received.
    const receivedHash = this.bidSetHashOf(saleId);
    const inputSha256 = await sha256Hex(
      JSON.stringify({
        v: 1,
        op: "clear",
        contract: CONTRACT_ID,
        sale_id: saleId,
        params: {
          sale_supply: c.saleSupply.toString(),
          floor_price: c.floorPrice.toString(),
          max_price: c.maxPrice === null ? null : c.maxPrice.toString(),
          min_raise: c.minRaise.toString(),
          decimals: c.decimals,
        },
        bid_set_hash: sale.bidSetHash,
        bids: bids.map((b) => [b.bidder, b.deposit.toString(), b.ciphertext]),
      }),
    );
    let r: ReturnType<typeof clear>;
    try {
      r = clear(params, decoded);
    } catch (e) {
      // Params are validated at creation, so this does not happen.
      this.finalize(sale, at, {
        clearedBy: "enclave",
        failReason: "checks_failed",
        failed: [e instanceof ClearingError ? e.code : "output_well_formed"],
        inputSha256,
        note: "A contract check failed. Every bidder can claim a full refund.",
      });
      return;
    }
    const out: SealerClearOutput = {
      saleId,
      bidSetHash: receivedHash,
      pubkey: key.pk,
      clearingPrice: r.clearingPrice,
      nValid: r.nValid,
      nInvalid: r.nInvalid,
      invalid: r.fills.filter((f) => !f.valid).map((f) => f.index),
      fills: r.fills.map((f) => [f.tokens, f.spent]),
    };
    const resultSha256 = await sha256Hex(sealerOutputText(out));

    // ----- back in the contract -----
    const report = checkClearOutput(
      {
        saleId,
        bidSetHash: sale.bidSetHash ?? "",
        sealerPubkey: sale.sealerPubkey || null,
        deposits: bids.map((b) => b.deposit),
        floorPrice: c.floorPrice,
        maxPrice: c.maxPrice,
        saleSupply: c.saleSupply,
        minRaise: c.minRaise,
        decimals: c.decimals,
      },
      out,
    );
    const reasons = r.fills.map((f) => f.invalidReason);
    const common = {
      clearedBy: "enclave" as const,
      price: out.clearingPrice,
      nValid: out.nValid,
      nInvalid: out.nInvalid,
      reasons,
      failed: report.failed,
      reportedHash: receivedHash,
      oversubscribed: r.oversubscribed,
      inputSha256,
      resultSha256,
      clearingMs: Math.round(performance.now() - t0) + 900,
    };
    if (report.integrityFailed) {
      // The result is not trusted: nobody is penalised and everyone is refunded.
      this.finalize(sale, at, {
        ...common,
        failReason: "checks_failed",
        note: "A contract check failed. Every bidder can claim a full refund.",
      });
      return;
    }
    const failReason = outcomeReason(report.sold, report.raised, out.nValid, c.minRaise);
    this.finalize(sale, at, {
      ...common,
      invalid: new Set(out.invalid),
      failReason,
      fills: failReason === null ? out.fills : undefined,
    });
  }

  /**
   * Makes a sale final and stores its result the way the contract's views
   * report it: fills only when settled, the 1 % penalty on every bid a trusted
   * clearing found invalid (whether the sale then settles or fails), refunds
   * net of it.
   */
  private finalize(
    sale: StoredSale,
    at: number,
    o: {
      clearedBy: "enclave" | "onchain" | "none";
      /** null = settled. */
      failReason: ChainFailReason | null;
      /** Clearing price; the floor when there is none. */
      price?: bigint;
      /** [tokens, spent] per bid when settled. */
      fills?: [bigint, bigint][];
      /** Bids that pay the penalty. Leave out when the clearing is not trusted (failed checks, refund mode). */
      invalid?: ReadonlySet<number>;
      /** Why each bid is void (the mock's enclave knows; the real contract only knows the list). */
      reasons?: (InvalidReason | undefined)[];
      nValid?: number;
      nInvalid?: number;
      failed?: string[];
      reportedHash?: string;
      oversubscribed?: boolean;
      inputSha256?: string;
      resultSha256?: string;
      clearingMs?: number;
      note?: string;
      account?: string;
    },
  ) {
    const saleId = sale.id;
    const c = sale.config;
    const bids = this.s.bids[saleId] ?? [];
    const settled = o.failReason === null;
    const settleTx = fakeTxHash();
    const reveals = this.s.reveals[saleId] ?? {};
    const fills = bids.map((b, i) => {
      const [tokens, spent] = settled ? (o.fills?.[i] ?? [0n, 0n]) : [0n, 0n];
      const penalized = !!o.invalid?.has(i);
      const penalty = penalized ? invalidBidPenalty(b.deposit) : 0n;
      const reason = o.reasons?.[i];
      return {
        index: i,
        bidder: b.bidder,
        deposit: b.deposit,
        tokens,
        spent,
        refund: b.deposit - spent - penalty,
        valid: !penalized && !reason,
        ...(reason ? { invalidReason: reason } : {}),
        penalty,
        claimed: false,
        claimTx: null,
        ...(c.revealMode === "commit_reveal" ? { revealed: !!reveals[i] } : {}),
        ...(b.tag ? { tag: b.tag } : {}),
      };
    });
    const totalSold = fills.reduce((a, f) => a + f.tokens, 0n);
    const totalRaised = fills.reduce((a, f) => a + f.spent, 0n);
    const totalPenalties = fills.reduce((a, f) => a + f.penalty, 0n);
    const failedNames = o.failed ?? [];
    const clearingPrice = o.price ?? c.floorPrice;
    const liquidity = c.liquidity ? plannedPool(c, settled, totalRaised, clearingPrice, at) : null;
    const result: SaleResult = {
      status: settled ? "settled" : "failed",
      ...(settled ? {} : { failReason: appFailReason(o.failReason) }),
      clearingPrice,
      fills,
      totalSold,
      totalRaised,
      unsold: unsoldWithPool(c, settled, totalSold, liquidity),
      oversubscribed: o.oversubscribed ?? false,
      nValid: o.nValid ?? bids.length,
      nInvalid: o.nInvalid ?? 0,
      bidSetHash: o.reportedHash ?? sale.bidSetHash ?? "",
      checks:
        o.clearedBy === "none"
          ? []
          : checkRows(failedNames, { clearedBy: o.clearedBy, hasCeiling: c.maxPrice !== null }),
      settleTx,
      clearingMs: o.clearingMs ?? 0,
      totalPenalties,
      ...(o.failReason ? { chainFailReason: o.failReason } : {}),
      failedChecks: failedNames.slice(0, 8),
      failedChecksTotal: failedNames.length,
      resultSha256: o.resultSha256 ?? null,
      inputSha256: o.inputSha256 ?? null,
      clearedBy: o.clearedBy,
      proceeds: { raisePaid: false, allocationPaid: false, unsoldBurned: false, reserveReturned: false },
      ...(liquidity ? { liquidity } : {}),
    };
    if (liquidity && locksTokens(liquidity) && c.creatorAllocation > 0n) {
      // claim_proceeds cannot pay the allocation while the pool is being seeded.
      result.proceeds = { ...result.proceeds!, allocationPaid: true, allocationLocked: true };
    }
    this.s.results[saleId] = result;
    sale.phase = settled ? "settled" : "failed";
    sale.settledAt = at;
    const penaltyNote =
      totalPenalties > 0n ? ` Void bids lose the 1 % penalty (${fmt(totalPenalties)} USDC in all).` : "";
    if (settled) {
      this.log(
        saleId,
        "settled",
        o.note ??
          `Cleared at ${fmt(result.clearingPrice)} USDC per token. ${result.nValid} valid bids, ${result.nInvalid} void. All contract checks passed.`,
        { at, txHash: settleTx, amount: totalRaised, ...(o.account ? { account: o.account } : {}) },
      );
    } else {
      this.log(
        saleId,
        o.failReason === "refund_mode" ? "refund_mode" : "failed",
        o.note ??
          (o.failReason === "below_min_raise" || o.failReason === "nothing_sold"
            ? `Minimum raise not met. Every bidder can claim their deposit back.${penaltyNote}`
            : o.failReason === "no_valid_bids"
              ? `No valid bids. Every bidder can claim their deposit back.${penaltyNote}`
              : "A contract check failed. Every bidder can claim a full refund."),
        { at, txHash: settleTx, ...(o.account ? { account: o.account } : {}) },
      );
    }
  }

  // ---------- commit-reveal ----------

  async revealBid(saleId: string, bidder: string, reveal?: RevealTerms): Promise<WriteResult> {
    await this.ready();
    const sale = this.sale(saleId);
    const now = Date.now();
    if (sale.phase !== "revealing") {
      throw invalid(`Cannot reveal a bid: the sale is ${deriveStatus(sale, now).replace(/_/g, " ")}.`, "wrong_phase");
    }
    if (now >= (revealEndOf(sale) ?? 0)) throw invalid("The reveal window has ended.", "wrong_phase");
    const bid = (this.s.bids[saleId] ?? []).find((b) => b.bidder === bidder);
    if (!bid) throw invalid("No bid from this account in this sale.", "no_bid");
    if (bid.revealed) throw invalid("This bid has been revealed already.", "already_revealed");
    const secret = getBidSecret(MOCK_SECRETS_SCOPE, saleId, bidder);
    const terms: RevealTerms | null =
      reveal ??
      (secret ? { maxPrice: BigInt(secret.maxPrice), maxSpend: BigInt(secret.maxSpend), salt: secret.salt } : null);
    if (!terms) {
      throw invalid(
        "The salt for this bid is not saved in this browser. Import your bid secrets file, or enter the price, spend and salt you committed to.",
        "missing_secret",
      );
    }
    if (!/^[0-9a-fA-F]{32}$/.test(terms.salt)) throw invalid("salt must be 32 hex characters");
    const commitment = bidCommitment({ saleId, bidder, ...terms });
    if (toB64(fromHex(commitment)) !== bid.ciphertext) {
      throw invalid("The reveal does not match your commitment. Use the salt saved when you bid.", "commitment_mismatch");
    }
    await txLatency();
    (this.s.reveals[saleId] ??= {})[bid.index] = { maxPrice: terms.maxPrice, maxSpend: terms.maxSpend };
    bid.revealed = true;
    const e = this.log(saleId, "bid", "Bid revealed.", { account: bidder, detail: "bid_revealed" });
    this.commit();
    return { txHash: e.txHash, relay: simRelay(e.txHash) };
  }

  /** clear_onchain (settle.rs): the contract clears the revealed bids itself; unrevealed and rule-breaking bids pay the penalty. */
  async clearOnchain(saleId: string, caller: string): Promise<SaleWithRelay> {
    await this.ready();
    const sale = this.sale(saleId);
    const now = Date.now();
    if (sale.phase !== "revealing") {
      throw invalid(`Cannot clear on chain: the sale is ${deriveStatus(sale, now).replace(/_/g, " ")}.`, "wrong_phase");
    }
    if (now < (revealEndOf(sale) ?? 0)) throw invalid("The reveal window has not ended yet.", "wrong_phase");
    await txLatency();
    const c = sale.config;
    const bids = this.s.bids[saleId] ?? [];
    const reveals = this.s.reveals[saleId] ?? {};
    const decoded: ClearingBid[] = bids.map((b, i) => ({
      bidder: b.bidder,
      deposit: b.deposit,
      maxPrice: reveals[i]?.maxPrice ?? null,
      maxSpend: reveals[i]?.maxSpend ?? null,
    }));
    const at = Date.now();
    let r: ReturnType<typeof clear>;
    try {
      r = clear(this.clearingParams(c), decoded);
    } catch (e) {
      this.finalize(sale, at, {
        clearedBy: "onchain",
        failReason: "checks_failed",
        failed: [e instanceof ClearingError ? e.code : "overflow"],
        account: caller,
      });
      this.commit();
      return this.withRelay(sale);
    }
    const settled = r.status === "settled" && r.totalSold > 0n;
    const failReason: ChainFailReason | null = settled
      ? null
      : r.status === "settled"
        ? "nothing_sold"
        : r.failReason === "no_valid_bids"
          ? "no_valid_bids"
          : "below_min_raise";
    this.finalize(sale, at, {
      clearedBy: "onchain",
      failReason,
      price: r.clearingPrice,
      fills: settled ? r.fills.map((f) => [f.tokens, f.spent]) : undefined,
      invalid: new Set(r.fills.filter((f) => !f.valid).map((f) => f.index)),
      reasons: r.fills.map((f) => f.invalidReason),
      nValid: r.nValid,
      nInvalid: r.nInvalid,
      failed: failReason === null ? [] : [failReason === "below_min_raise" ? "raise_at_least_min" : "something_sold"],
      oversubscribed: r.oversubscribed,
      account: caller,
      ...(settled
        ? {
            note: `Cleared on chain at ${fmt(r.clearingPrice)} USDC per token. ${r.nValid} valid bids, ${r.nInvalid} void (not revealed or against the rules).`,
          }
        : {}),
    });
    this.commit();
    return this.withRelay(sale);
  }

  private withRelay(sale: StoredSale): SaleWithRelay {
    const txHash = this.s.results[sale.id]?.settleTx ?? fakeTxHash();
    return { ...this.view(sale), relay: simRelay(txHash) };
  }

  // ---------- refund mode ----------

  async triggerRefundMode(saleId: string, caller: string): Promise<SaleWithRelay> {
    await this.ready();
    const sale = this.sale(saleId);
    const due = refundModeFromOf(sale);
    if (due === null) {
      throw invalid(`Cannot trigger refund mode: the sale is ${sale.phase}.`, "wrong_phase");
    }
    if (Date.now() < due) throw invalid("Settle timeout has not passed yet.", "wrong_phase");
    await txLatency();
    const now = Date.now();
    sale.refundModeAt = now;
    this.finalize(sale, now, {
      clearedBy: "none",
      failReason: "refund_mode",
      note: "Settle timeout passed with no result. Sale moved to refunds. Every deposit can be claimed in full.",
      account: caller,
    });
    this.commit();
    return this.withRelay(sale);
  }

  // ---------- claim ----------

  async claim(saleId: string, bidder: string): Promise<ClaimResult> {
    await this.ready();
    await txLatency();
    const r = this.claimInternal(saleId, bidder, Date.now());
    this.commit();
    return { ...r, relay: simRelay(r.txHash) };
  }

  private claimInternal(saleId: string, bidder: string, at: number): ClaimReceipt {
    const sale = this.s.sales[saleId];
    const result = this.s.results[saleId];
    if (!sale || !result) throw invalid("This sale has no result yet.", "wrong_phase");
    const bid = (this.s.bids[saleId] ?? []).find((b) => b.bidder === bidder);
    if (!bid) throw invalid("No bid from this account in this sale.", "no_bid");
    if (bid.claimed) throw invalid("Already claimed.", "already_claimed");
    const fill = result.fills[bid.index];
    const txHash = fakeTxHash();
    // While the launch pool is being seeded the sale tokens stay locked: a claim pays only the USDC (claims.rs `claim`).
    if (fill.tokens > 0n && locksTokens(result.liquidity)) {
      if (fill.refundClaimed || fill.refund === 0n) {
        throw invalid(
          "Your tokens unlock once the launch pool is seeded (or abandoned after its deadline). Anyone can seed it from the result page.",
          "liquidity_pending",
        );
      }
      this.credit(bidder, fill.refund);
      fill.refundClaimed = true;
      this.log(
        saleId,
        "claimed",
        `Claimed ${fmt(fill.refund)} USDC unspent. The tokens unlock once the launch pool is seeded.`,
        { at, account: bidder, amount: fill.refund, txHash, detail: "refund_claimed" },
      );
      return { saleId, bidder, tokens: 0n, refund: fill.refund, txHash };
    }
    const refund = fill.refundClaimed ? 0n : fill.refund;
    this.credit(bidder, refund, saleId, fill.tokens);
    bid.claimed = true;
    bid.claimTx = txHash;
    fill.claimed = true;
    fill.claimTx = txHash;
    const penalty = fill.penalty ?? 0n;
    this.log(
      saleId,
      "claimed",
      fill.tokens > 0n
        ? fill.refundClaimed
          ? "Claimed tokens. The unspent USDC was paid earlier."
          : `Claimed tokens and ${fmt(fill.refund)} USDC unspent.`
        : penalty > 0n
          ? `Claimed ${fmt(fill.refund)} USDC: the deposit less the 1 % penalty for a void bid.`
          : `Claimed full refund of ${fmt(fill.refund)} USDC.`,
      { at, account: bidder, amount: refund, txHash },
    );
    return { saleId, bidder, tokens: fill.tokens, refund, txHash };
  }

  async claimProceeds(saleId: string, caller: string): Promise<WriteResult> {
    void caller;
    await this.ready();
    const sale = this.sale(saleId);
    if (!isFinal(sale)) {
      throw invalid(`Cannot claim proceeds: the sale is ${deriveStatus(sale, Date.now()).replace(/_/g, " ")}.`, "wrong_phase");
    }
    await txLatency();
    const txHash = this.claimProceedsInternal(sale, Date.now());
    if (!txHash) {
      if (this.s.results[saleId]?.proceeds?.allocationLocked) {
        throw invalid(
          "Nothing to pay out now: the creator allocation unlocks once the launch pool is seeded (or abandoned after its deadline).",
          "liquidity_pending",
        );
      }
      throw invalid("The creator's proceeds were already paid.", "already_claimed");
    }
    this.commit();
    return { txHash, relay: simRelay(txHash) };
  }

  /** What claim_proceeds paid so far. State saved before this record existed has only the flags: read them. */
  private paidOf(sale: StoredSale, result: SaleResult): ProceedsPaid {
    const all = (this.s.paid ??= {});
    const p = result.proceeds;
    return (all[sale.id] ??= {
      raise: p?.raisePaid && result.status === "settled" ? result.totalRaised - poolUsdcKept(result.liquidity) : 0n,
      burned: p?.unsoldBurned ? result.unsold : 0n,
      allocation: !!p?.allocationPaid && !p.allocationLocked && !!p.reserveReturned,
      reserve: !!p?.reserveReturned,
    });
  }

  /**
   * The proceeds flags from what was paid and what is owed now: the raise less
   * the launch pool's USDC, the burn (the unsold sale supply and the reserve
   * the pool did not take), the allocation (locked while the pool is being
   * seeded), the NEAR reserve. A part owed later (after abandonment) clears
   * its flag again.
   */
  private refreshProceeds(sale: StoredSale, result: SaleResult) {
    const paid = this.paidOf(sale, result);
    // The first claim_proceeds always returns the NEAR reserve; until then every flag is false, as finalize sets them.
    const claimed = paid.reserve;
    const raiseOwed = result.status === "settled" ? result.totalRaised - poolUsdcKept(result.liquidity) : 0n;
    const allocationOwed = sale.config.creatorAllocation > 0n && !paid.allocation;
    const allocationLocked = allocationOwed && locksTokens(result.liquidity);
    result.proceeds = {
      raisePaid: claimed && paid.raise >= raiseOwed,
      allocationPaid: allocationLocked || (claimed && !allocationOwed),
      unsoldBurned: claimed && paid.burned >= result.unsold,
      reserveReturned: claimed,
      ...(allocationLocked ? { allocationLocked: true } : {}),
    };
  }

  /** claim_proceeds (claims.rs): each part is paid once, as far as it is owed. Returns null when nothing was left. */
  private claimProceedsInternal(sale: StoredSale, at: number): string | null {
    const result = this.s.results[sale.id];
    if (!result) return null;
    const paid = this.paidOf(sale, result);
    const l = result.liquidity ?? null;
    const locked = locksTokens(l);
    const raiseOwed = result.status === "settled" ? result.totalRaised - poolUsdcKept(l) : 0n;
    const raise = raiseOwed > paid.raise ? raiseOwed - paid.raise : 0n;
    const burn = result.unsold > paid.burned ? result.unsold - paid.burned : 0n;
    const allocation = sale.config.creatorAllocation > 0n && !paid.allocation && !locked;
    const reserve = !paid.reserve;
    if (raise === 0n && burn === 0n && !allocation && !reserve) return null;
    if (raise > 0n) this.credit(sale.creator, raise);
    paid.raise += raise;
    paid.burned += burn;
    if (allocation) paid.allocation = true;
    paid.reserve = true;
    this.refreshProceeds(sale, result);
    const allocationLeft = sale.config.creatorAllocation > 0n && !paid.allocation;
    const e = this.log(
      sale.id,
      "claimed",
      result.status === "settled"
        ? allocationLeft
          ? `Creator paid ${fmt(raise)} USDC of the raise. The creator allocation unlocks once the launch pool is seeded.`
          : raise > 0n
            ? `Creator paid: ${fmt(raise)} USDC raised and the creator allocation. Unsold tokens burned.`
            : "Creator allocation paid. Unsold tokens burned."
        : "Creator allocation paid. The unsold sale tokens were burned.",
      { at, account: sale.creator, detail: "proceeds_claimed", ...(raise > 0n ? { amount: raise } : {}) },
    );
    return e.txHash;
  }

  // ---------- launch liquidity ----------

  async getLiquidityDex(): Promise<string | null> {
    return MOCK_DEX;
  }

  async getPool(saleId: string): Promise<DexPool | null> {
    await this.ready();
    const sale = this.s.sales[saleId];
    const l = this.s.results[saleId]?.liquidity;
    if (!sale || !l || l.poolId === null) return null;
    // Nothing trades on the simulated pool: its reserves are what was added.
    const filled = l.stage === "seeded";
    return {
      dex: l.dex,
      poolId: l.poolId,
      tokenIds: [sale.tokenAccount, USDC_TOKEN],
      amounts: filled ? [l.tokens, l.usdc] : [0n, 0n],
      feeBps: sale.config.liquidity?.feeBps ?? 0,
      sharesTotal: l.shares,
      contractShares: l.shares,
      readAt: Date.now(),
      simulated: true,
    };
  }

  private liquidityOf(saleId: string): { sale: StoredSale; result: SaleResult; l: LiquidityState } {
    const sale = this.sale(saleId);
    const result = this.s.results[saleId];
    const l = result?.liquidity;
    if (!result || !l) throw invalid("This sale has no launch pool.", "no_liquidity");
    return { sale, result, l };
  }

  /** A wallet transaction in NEAR mode (the relayer does not list these methods): simulated, paid by the caller. */
  private paidRelay(txHash: string): RelayInfo {
    return { ...simRelay(txHash), paidBy: "user" };
  }

  async seedLiquidity(saleId: string, caller: string): Promise<LiquidityWriteResult> {
    await this.ready();
    const { l } = this.liquidityOf(saleId);
    if (l.stage !== "seeding") {
      throw invalid(`Cannot seed the launch pool: it is ${STAGE_LABEL[l.stage].toLowerCase()}.`, "wrong_stage");
    }
    if (l.inFlight) throw invalid("A launch pool step is still waiting for its result. Try again in a few seconds.", "liquidity_busy");
    if (l.deadline !== null && Date.now() >= l.deadline) {
      throw invalid("The seeding deadline has passed. Anyone can now abandon the launch pool.", "too_late");
    }
    const txHash = await this.seedInternal(saleId, caller);
    return { txHash, relay: this.paidRelay(txHash), liquidity: { ...this.liquidityOf(saleId).l } };
  }

  /**
   * seed_liquidity with 300 TGas: each step's callback starts the next, so
   * one call runs them all. Each step shows as in flight for a moment.
   */
  private async seedInternal(saleId: string, caller: string, onStep?: (step: LiquidityStep) => void): Promise<string> {
    const txHash = fakeTxHash();
    for (;;) {
      const { l } = this.liquidityOf(saleId);
      const step = l.nextStep;
      if (l.stage !== "seeding" || !step || step === "withdraw") break;
      onStep?.(step);
      l.inFlight = step;
      l.nextStep = null;
      this.commit();
      await delay(STEP_MS);
      // The state may have been replaced meanwhile (another tab): act on the current one.
      const { sale, result, l: now } = this.liquidityOf(saleId);
      now.inFlight = null;
      if (step === "create_pool") now.poolId = poolIdOf(saleId);
      if (step === "deposit") {
        now.usdcOnDex = now.usdc;
        now.tokensOnDex = now.tokens;
      }
      if (step === "add_liquidity") {
        now.usdcOnDex = 0n;
        now.tokensOnDex = 0n;
        now.shares = INIT_POOL_SHARES;
        now.stage = "seeded";
        now.nextStep = null;
        this.refreshProceeds(sale, result);
        this.log(
          saleId,
          "settled",
          `Launch pool seeded at the clearing price: ${fmt(now.usdc)} USDC and ${fmtTokens(now.tokens, sale.config.decimals)} ${sale.config.tokenSymbol} in pool ${now.poolId}. The sale contract keeps the LP shares.`,
          { account: caller, amount: now.usdc, txHash, detail: "liquidity_seeded" },
        );
      } else {
        now.nextStep = SEED_STEPS[SEED_STEPS.indexOf(step) + 1] ?? null;
      }
      this.commit();
    }
    return txHash;
  }

  async abandonLiquidity(saleId: string, caller: string): Promise<LiquidityWriteResult> {
    await this.ready();
    const { sale, result, l } = this.liquidityOf(saleId);
    if (l.stage !== "seeding" && l.stage !== "abandoned") {
      throw invalid(`Cannot abandon the launch pool: it is ${STAGE_LABEL[l.stage].toLowerCase()}.`, "wrong_stage");
    }
    if (l.stage === "abandoned" && l.usdcOnDex === 0n && l.tokensOnDex === 0n) {
      throw invalid("The launch pool is already abandoned and nothing is left on the exchange.", "already_done");
    }
    if (l.inFlight) throw invalid("A launch pool step is still waiting for its result. Try again in a few seconds.", "liquidity_busy");
    if (l.stage === "seeding" && l.deadline !== null && Date.now() < l.deadline) {
      throw invalid(`The launch pool can be abandoned from ${new Date(l.deadline).toLocaleString("en-GB")}, if it is not seeded by then.`, "too_early");
    }
    await txLatency();
    const txHash = fakeTxHash();
    const first = l.stage === "seeding";
    l.stage = "abandoned";
    l.nextStep = null;
    // What sat on the exchange comes back; the pool's USDC goes to the creator and its tokens are burned.
    l.usdcOnDex = 0n;
    l.tokensOnDex = 0n;
    result.unsold = unsoldWithPool(sale.config, true, result.totalSold, l);
    this.refreshProceeds(sale, result);
    if (first) {
      this.log(
        saleId,
        "settled",
        `Launch pool not seeded by its deadline and abandoned. Its ${fmt(l.usdc)} USDC goes to the creator and its tokens are burned.`,
        { account: caller, txHash, detail: "liquidity_abandoned" },
      );
    }
    this.commit();
    return { txHash, relay: this.paidRelay(txHash), liquidity: { ...l } };
  }

  /** The mock has no setup phase, so there is never a step to retry. */
  async retrySetup(saleId: string, caller: string): Promise<Sale> {
    void caller;
    await this.ready();
    this.sale(saleId);
    throw invalid("nothing to retry: no setup step has failed");
  }

  // ---------- attestation ----------

  /**
   * The checks NEAR mode runs (near/attestation.ts), with the same rows, over
   * a simulated run: there is no OutLayer, no TDX quote and no register
   * contract here, so the quote and measurement rows say "simulated". The
   * hashes are real sha256 of the mock's own sealer input and output.
   */
  async verifySale(saleId: string): Promise<SaleVerification> {
    await this.ready();
    await delay(400 + Math.random() * 400);
    const sale = this.sale(saleId);
    const result = this.s.results[saleId];
    const tee = sale.config.revealMode === "tee";
    const pk = this.s.keys[saleId]?.pk ?? sale.sealerPubkey;
    const closer = (this.s.events[saleId] ?? []).findLast((e) => e.kind === "closed")?.account ?? sale.creator;

    const run = async (kind: RunKind): Promise<AttestedRun> => {
      const clearing = kind === "clear";
      const op = clearing ? "clear" : "pubkey";
      const input = clearing
        ? (result?.inputSha256 ?? "")
        : await sha256Hex(JSON.stringify({ v: 1, op, contract: CONTRACT_ID, sale_id: saleId }));
      const output = clearing
        ? (result?.resultSha256 ?? "")
        : await sha256Hex(JSON.stringify(JSON.stringify({ v: 1, ok: true, op, sale_id: saleId, pubkey: pk })));
      const eq = (values: [string, string][]): AttestationFact => ({
        kind: "equal",
        values: values.map(([label, value]) => ({ label, value })),
        ok: values.every(([, v]) => !!v && v === values[0][1]),
      });
      const fact = (label: string, value: string, ok = true): AttestationFact => ({ kind: "fact", label, value, ok });
      const checks: RunCheck[] = [
        { id: "build", items: [eq([["attested", SEALER_CODE_HASH], ["contract pins", sale.sealerCodeHash], ["public build", SEALER_CODE_HASH]])] },
        { id: "executed", items: [eq([["measured", SEALER_CODE_HASH], ["contract pins", sale.sealerCodeHash]])] },
        {
          id: "input",
          items: [eq([["sha256(input)", input], ["attested", input], ...(clearing ? ([["contract stored", input]] as [string, string][]) : [])])],
        },
        {
          id: "output",
          items: [eq([["sha256(output)", output], ["attested", output], ...(clearing ? ([["contract stored", output]] as [string, string][]) : [])])],
        },
        { id: "task", items: [fact("task hash", "simulated: no TDX quote")] },
        { id: "measurements", items: [fact("register contract", "simulated: no TEE")] },
        {
          id: "request",
          items: [
            fact("sent by", CONTRACT_ID),
            fact("for", `${saleId}, op ${op}`),
            fact("source", `fairground-sealer @ ${SEALER_CODE_HASH}`),
          ],
        },
        {
          id: "key",
          items: [
            eq([[clearing ? "job opened bids with" : "job made", pk], ["sale key", sale.sealerPubkey]]),
            fact("answer for", `${saleId}, op ${op}`),
          ],
        },
      ].map((c) => ({ ...c, ok: c.items.every((i) => i.ok) }) as RunCheck);
      return {
        kind,
        found: true,
        simulated: true,
        attestationId: 0,
        taskId: 0,
        requestId: null,
        txHash: clearing ? (result?.settleTx ?? "") : sale.createTx,
        signer: clearing ? closer : sale.creator,
        method: clearing ? "close_sale" : "create_sale",
        txSource: "simulated",
        blockHeight: null,
        at: clearing ? (sale.settledAt ?? sale.closedAt ?? Date.now()) : sale.createdAt,
        quote: toB64(fromHex(randomHex(96))),
        verifierUrl: null,
        checks,
      };
    };

    return {
      simulated: true,
      checkedAt: Date.now(),
      pinnedWasm: sale.sealerCodeHash,
      key: tee ? await run("key") : null,
      clear: tee && result?.clearedBy === "enclave" && result.resultSha256 ? await run("clear") : null,
    };
  }

  // ---------- faucet ----------

  async faucet(account: string, amount: bigint, opts: { key?: string } = {}) {
    await this.ready();
    await txLatency();
    if (opts.key) {
      // Check, mark and credit with no await in between, against this tab and
      // the stored state, so a second tab or a resumed swap never credits twice.
      const used = (this.s.faucetKeys ??= {});
      if (used[opts.key] || this.storedFaucetKey(opts.key)) {
        used[opts.key] = true;
        return this.balancesOf(account);
      }
      used[opts.key] = true;
    }
    this.credit(account, amount);
    this.commit();
    return this.balancesOf(account);
  }

  /** The simulated USDC has no storage registration. */
  async ensureUsdcStorage(account: string): Promise<StorageResult> {
    void account;
    return { status: "already_registered", txHash: null };
  }

  // ---------- judge mode ----------

  async runJudgeMode(opts: { onProgress: (p: JudgeProgress) => void; windowSeconds?: number }) {
    await this.ready();
    const n = ++this.s.judgeCount;
    const windowMs = (opts.windowSeconds ?? 25) * 1000;
    const progress = (p: Omit<JudgeProgress, "saleId"> & { saleId?: string | null }) =>
      opts.onProgress({ saleId: null, ...p });

    progress({ step: "create", bidsPlaced: 0, message: "Creating a sale with locked rules and a fixed-supply token." });
    await delay(700);
    const now = Date.now();
    const config = judgeConfig(n, now, windowMs);
    const hue = (n * 47) % 360;
    const sale = await this.insertSale("judge.testnet", config, {
      description: "A seeded judge-mode sale. Every bidder is fictional.",
      hue,
      icon: markIcon(JUDGE_MARK, hue),
    }, now, { id: `judge-${n}`, judge: true });
    this.commit();
    const saleId = sale.id;

    progress({ step: "key", saleId, bidsPlaced: 0, message: "Sale key derived inside the enclave. Public key stored on-chain." });
    await delay(900);

    // The simulated bidders stand in for other people's machines, so a slow or
    // background tab (timers throttled to about one per second) must not push
    // them out of the window: they skip the window check, and their
    // timestamps never pass the close.
    const sim = { skipBalance: true, skipWindow: true };
    const at = () => Math.min(Date.now(), config.bidEnd - 1);

    progress({ step: "bots", saleId, bidsPlaced: 0, message: "3 sniper bots bid at second 0 with a huge max price." });
    const bots = makeBots(3, 10, "testnet");
    let placed = 0;
    for (const b of bots) {
      await this.seedBid(sale, b, at(), "bot", sim);
      placed++;
      this.commit();
      await delay(250);
    }

    const crowd = makeCrowd(1000 + n, 50, 10);
    const spread = Math.max(4000, windowMs * 0.55);
    const gap = spread / crowd.length;
    progress({ step: "crowd", saleId, bidsPlaced: placed, message: "The bots went first. People trickle in, each bid sealed in their own browser." });
    // Paced by the wall clock, not by how often timers fire: when a timer
    // fires late, that tick places every bid that is already due.
    const crowdStart = Date.now();
    let next = 0;
    while (next < crowd.length) {
      await delay(gap);
      const due = Math.min(crowd.length, Math.max(next + 1, Math.floor((Date.now() - crowdStart) / gap)));
      for (; next < due; next++) {
        await this.seedBid(sale, crowd[next], at(), "sim", sim);
        placed++;
        this.commit();
      }
      progress({ step: "crowd", saleId, bidsPlaced: placed, message: `${placed} sealed bids so far. Nobody can see a single price.` });
    }

    progress({ step: "copycat", saleId, bidsPlaced: placed, message: "A copycat bot resubmits someone else's ciphertext under its own account." });
    const victim = pickVictim(this.s.bids[saleId].filter((b) => b.tag === "sim"), 2);
    this.insertBid(saleId, copycatAccount(victim.bidder.length), victim.deposit, { ciphertext: victim.ciphertext }, at(), "bot", sim);
    placed++;
    this.commit();
    await delay(600);

    const wait = sale.config.bidEnd - Date.now();
    progress({ step: "window", saleId, bidsPlaced: placed, message: "Waiting for the bid window to end. You can add your own bid now." });
    if (wait > 0) await delay(wait + 50);

    progress({ step: "close", saleId, bidsPlaced: placed, message: "Anyone can call close_sale. Bid set frozen and hashed." });
    await this.closeSale(saleId, "judge.testnet");

    progress({ step: "clearing", saleId, bidsPlaced: placed, message: "Enclave decrypts every bid and computes one clearing price." });
    await this.clearing.get(saleId);

    // Anyone may seed the launch pool; here the judge run does it at once.
    if (this.s.results[saleId]?.liquidity?.stage === "seeding") {
      await this.seedInternal(saleId, "judge.testnet", (step) =>
        progress({
          step: "clearing",
          saleId,
          bidsPlaced: placed,
          message: `Settled. Seeding the launch pool at the clearing price: ${stepPhrase(step)}.`,
        }),
      );
    }

    progress({ step: "done", saleId, bidsPlaced: placed, message: "Settled. Bots and people paid the same price." });
    return saleId;
  }

  // ---------- seeding ----------

  private async seedBid(
    sale: StoredSale,
    b: CrowdBidder,
    at: number,
    tag: BidRecord["tag"],
    opts: { skipBalance?: boolean; skipWindow?: boolean } = {},
  ) {
    const maxPrice = BigInt(Math.round(Number(sale.config.floorPrice) * b.priceMultiple));
    const ciphertext = await sealBid(sale.sealerPubkey, {
      sale_id: sale.id,
      bidder: b.account,
      max_price: maxPrice.toString(),
      max_spend: usdcOf(b.spend).toString(),
      salt: randomHex(16),
    });
    return this.insertBid(sale.id, b.account, usdcOf(b.deposit), { ciphertext }, at, tag, opts);
  }

  private async seedSale(def: SeedDef, now: number) {
    const config: SaleConfig = {
      tokenName: def.name,
      tokenSymbol: def.symbol,
      decimals: 18,
      totalSupply: 1_000_000n * TOKEN,
      saleSupply: BigInt(def.saleSupply) * TOKEN,
      creatorAllocation: 100_000n * TOKEN,
      lpReserve: (1_000_000n - 100_000n - BigInt(def.saleSupply)) * TOKEN,
      floorPrice: usdcOf(def.floor),
      maxPrice: null,
      minRaise: usdcOf(def.minRaise),
      bidStart: def.start,
      bidEnd: def.end,
      minDeposit: USDC,
      maxDepositPerAccount: 10n * USDC,
      revealMode: "tee",
      unsoldRule: "burn",
      settleTimeoutMs: 2 * HOUR,
      quoteToken: USDC_TOKEN,
    };
    const sale = await this.insertSale(
      def.creator,
      config,
      { description: def.description, hue: def.hue, icon: markIcon(def.mark, def.hue) },
      def.start - 6 * HOUR,
      { id: def.id },
    );
    sale.enclaveDown = def.enclaveDown;
    const lastBidAt = Math.min(now, def.end);
    for (const b of makeBots(def.bots, 10)) {
      await this.seedBid(sale, b, def.start + 400, "bot", { skipBalance: true, skipWindow: true });
    }
    for (const b of makeCrowd(def.hue * 31 + def.crowd + (def.crowdSeed ?? 0) * 7919, def.crowd, 10)) {
      const at = def.start + Math.floor(b.arrival * (lastBidAt - def.start));
      await this.seedBid(sale, b, at, "sim", { skipBalance: true, skipWindow: true });
    }
    if (def.copycat) {
      // A copy can only exist after the bid it copies: it lands 30 s later.
      const victim = pickVictim(this.s.bids[sale.id].filter((b) => b.tag === "sim"), 1);
      const copyAt = Math.min(victim.placedAt + 30_000, lastBidAt - 1);
      this.insertBid(sale.id, copycatAccount(victim.bidder.length), victim.deposit, { ciphertext: victim.ciphertext }, copyAt, "bot", {
        skipBalance: true,
        skipWindow: true,
      });
    }
    // Keep bids in time order, like the chain would, and hash them in that order.
    const bids = this.s.bids[sale.id].sort((a, b) => a.placedAt - b.placedAt);
    bids.forEach((b, i) => (b.index = i));
    sale.bidSetState = this.bidSetHashOf(sale.id);

    if (def.closeAt !== undefined) {
      this.closeInternal(sale.id, "keeper.testnet", def.closeAt);
      if (!def.enclaveDown) {
        await this.runEnclave(sale.id, def.closeAt + 95_000);
        // The creator collected: the raise when settled, the allocation either way.
        this.claimProceedsInternal(sale, def.closeAt + 2 * HOUR);
        const share = def.claimShare ?? 0;
        bids.forEach((b, i) => {
          if (i % 10 < share * 10) this.claimInternal(sale.id, b.bidder, def.closeAt! + 3 * HOUR + i * MIN);
        });
      }
    }
  }

  /** Seed the demo sales, timed from `now`, except the ids in `skip`. */
  private async seed(now = Date.now(), skip: ReadonlySet<string> = new Set()) {
    for (const def of seedDefs(now)) {
      if (!skip.has(def.id)) await this.seedSale(def, now);
    }
  }
}

// ---------- seed data ----------

type SeedDef = {
  id: string;
  name: string;
  symbol: string;
  /** The token's generated mark: letters or one emoji (lib/token-icon.ts). */
  mark: string;
  creator: string;
  description: string;
  hue: number;
  saleSupply: number;
  floor: number;
  minRaise: number;
  start: number;
  end: number;
  crowd: number;
  bots: number;
  /** Varies the fictional crowd (rolling copies use their round number). */
  crowdSeed?: number;
  copycat?: boolean;
  closeAt?: number;
  enclaveDown?: boolean;
  claimShare?: number;
};

/** The demo sales, in seeding order, with times relative to `now`. */
function seedDefs(now: number): SeedDef[] {
  return [
    {
      id: "lantern", mark: "🏮", name: "Lantern", symbol: "LNTN", creator: "lantern-labs.testnet",
      description: "A community token for a night-market collective. Oversubscribed; cleared well above the floor.",
      hue: 38, saleSupply: 150_000, floor: 0.001, minRaise: 50,
      start: now - 3 * DAY, end: now - 3 * DAY + 4 * HOUR, crowd: 45, bots: 3, copycat: true,
      closeAt: now - 3 * DAY + 4 * HOUR + 2 * MIN, claimShare: 0.6,
    },
    {
      id: "driftwood", mark: "🌊", name: "Driftwood", symbol: "DRFT", creator: "shoreline.testnet",
      description: "Missed its minimum raise. Every bidder was refunded in full.",
      hue: 200, saleSupply: 300_000, floor: 0.002, minRaise: 400,
      start: now - 5 * DAY, end: now - 5 * DAY + 3 * HOUR, crowd: 7, bots: 0,
      closeAt: now - 5 * DAY + 3 * HOUR + 5 * MIN, claimShare: 0.3,
    },
    {
      id: "ashfall", mark: "🌋", name: "Ashfall", symbol: "ASHF", creator: "kilnworks.testnet",
      description: "The enclave never answered. After the 2-hour settle timeout anyone can switch it to refunds.",
      hue: 12, saleSupply: 200_000, floor: 0.001, minRaise: 50,
      start: now - 9 * HOUR, end: now - 5 * HOUR, crowd: 12, bots: 1,
      closeAt: now - 5 * HOUR + 3 * MIN, enclaveDown: true,
    },
    {
      id: "kiln", mark: "🔥", name: "Kiln", symbol: "KILN", creator: "kilnworks.testnet",
      description: "Bid window just ended. Anyone can close it and trigger clearing.",
      hue: 22, saleSupply: 120_000, floor: 0.001, minRaise: 50,
      start: now - 2 * HOUR, end: now - 4 * MIN, crowd: 31, bots: 2,
    },
    {
      id: LIVE_SEED, mark: "FT", name: "Fair Test", symbol: "FAIRT", creator: "fairground.testnet",
      description: "The reference sale from the spec: 600k tokens, 0.001 USDC floor, 50 USDC minimum raise.",
      hue: 214, saleSupply: 600_000, floor: 0.001, minRaise: 50,
      start: now - 40 * MIN, end: now + 2 * HOUR, crowd: 26, bots: 2,
    },
    {
      id: "moth", mark: "🌙", name: "Moth", symbol: "MOTH", creator: "nightshift.testnet",
      description: "Opens tomorrow. Rules are already locked and readable.",
      hue: 280, saleSupply: 250_000, floor: 0.0015, minRaise: 100,
      start: now + 20 * HOUR, end: now + 26 * HOUR, crowd: 0, bots: 0,
    },
  ];
}

/** The judge-mode sale's mark. */
const JUDGE_MARK = "⚖️";

/** A demo sale's mark by id (rolling copies "fairt-2" take their base's), for state stored before icons. */
function demoMark(id: string, judge: boolean): string | null {
  if (judge) return JUDGE_MARK;
  const base = id.replace(/-d+$/, "");
  return seedDefs(0).find((d) => d.id === base)?.mark ?? null;
}

/** create_sale's icon rule (sale.rs): a data: URL of at most 2,048 bytes, when there is one. */
function validateIcon(meta: SaleMeta) {
  const problem = iconError(meta.icon);
  if (problem) throw invalid(problem);
}

// ---------- helpers ----------

function fmt(v: bigint): string {
  const whole = v / USDC;
  const frac = (v % USDC).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Whole tokens with separators, up to 2 decimals: "20,000". */
function fmtTokens(v: bigint, decimals: number): string {
  const one = 10n ** BigInt(decimals);
  const whole = (v / one).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = ((v % one) * 100n) / one;
  return cents > 0n ? `${whole}.${cents.toString().padStart(2, "0").replace(/0$/, "")}` : whole;
}

/**
 * The launch pool a sale gets when it becomes final (settle.rs, liquidity.rs
 * `pool_plan`): cancelled when the sale failed, skipped when the plan comes to
 * zero, else seeding until `settleTimeoutMs` after settlement.
 */
function plannedPool(c: SaleConfig, settled: boolean, raise: bigint, price: bigint, at: number): LiquidityState {
  const terms = c.liquidity!;
  const empty = {
    dex: terms.dex,
    poolId: null,
    inFlight: null,
    shares: 0n,
    usdcOnDex: 0n,
    tokensOnDex: 0n,
    failures: 0,
    simulated: true,
  } as const;
  if (!settled) return { ...empty, stage: "cancelled", nextStep: null, usdc: 0n, tokens: 0n, deadline: null };
  const plan = poolPlan(raise, price, c.decimals, terms.raiseShareBps, terms.poolTokens);
  if (plan.tokens === 0n) return { ...empty, stage: "skipped", nextStep: null, usdc: 0n, tokens: 0n, deadline: null };
  return { ...empty, stage: "seeding", nextStep: "register", ...plan, deadline: at + c.settleTimeoutMs };
}

/** Tokens claim_proceeds burns (sale.rs `unsold`): the unsold sale supply plus the reserve the pool does not keep. */
function unsoldWithPool(c: SaleConfig, settled: boolean, totalSold: bigint, l: LiquidityState | null): bigint {
  const salePart = unsoldOf({ final: true, settled, tokenDeployed: true, saleSupply: c.saleSupply, totalSold });
  if (!c.liquidity || !l) return salePart;
  const kept = l.stage === "seeding" || l.stage === "seeded" ? l.tokens : l.stage === "abandoned" ? l.tokensOnDex : 0n;
  return salePart + c.liquidity.poolTokens - kept;
}

/** A pool id that looks like one on the exchange, the same for a sale every time. */
function poolIdOf(saleId: string): number {
  let h = 0;
  for (let i = 0; i < saleId.length; i++) h = (h * 31 + saleId.charCodeAt(i)) % 9000;
  return 1000 + h;
}

/** The sealer's clear answer as text, in the DESIGN field order (its sha256 is the attestation's output hash). */
function sealerOutputText(out: SealerClearOutput): string {
  return JSON.stringify({
    v: 1,
    ok: true,
    op: "clear",
    sale_id: out.saleId,
    bid_set_hash: out.bidSetHash,
    pubkey: out.pubkey,
    clearing_price: out.clearingPrice.toString(),
    n_valid: out.nValid,
    n_invalid: out.nInvalid,
    invalid: out.invalid,
    fills: out.fills.map(([tokens, spent]) => [tokens.toString(), spent.toString()]),
  });
}

/**
 * The judge-mode sale. It seeds a launch pool with 20 % of the raise: a sell-out
 * gives the pool 20 % as many tokens as were sold, so its 20,000-token reserve
 * covers the 100,000 for sale. The sale terms that decide the clearing (supply
 * for sale, floor, deposits, window) are the same as before the pool.
 */
function judgeConfig(n: number, now: number, windowMs: number): SaleConfig {
  return {
    tokenName: `Judge Run ${n}`,
    tokenSymbol: `JDG${n}`,
    decimals: 18,
    totalSupply: 220_000n * TOKEN,
    saleSupply: 100_000n * TOKEN,
    creatorAllocation: 100_000n * TOKEN,
    lpReserve: 20_000n * TOKEN,
    liquidity: { dex: MOCK_DEX, raiseShareBps: 2_000, poolTokens: 20_000n * TOKEN, feeBps: 30 },
    floorPrice: 1_000n, // 0.001 USDC
    maxPrice: null,
    minRaise: 50n * USDC,
    bidStart: now,
    bidEnd: now + windowMs,
    minDeposit: USDC,
    maxDepositPerAccount: 10n * USDC,
    revealMode: "tee",
    unsoldRule: "burn",
    settleTimeoutMs: 2 * HOUR,
    quoteToken: USDC_TOKEN,
  };
}

const U128_MAX = (1n << 128n) - 1n;

/**
 * create_sale's rules (sale.rs `validate`), plus the mock's own: a symbol of
 * 2-8 capitals or digits that no other sale uses, and a window that may start
 * up to 5 minutes ago (the form fills in "now"). Throws with a readable
 * message; the contract's own wording where the contract has the rule.
 */
export function validateConfig(c: SaleConfig, existing: { config: SaleConfig }[] = []) {
  const fail = (m: string): never => {
    throw invalid(m);
  };
  if (!c.tokenName.trim()) fail("Token name is required.");
  if (!/^[A-Z0-9]{2,8}$/.test(c.tokenSymbol)) fail("Symbol must be 2-8 capital letters or digits.");
  if (existing.some((s) => s.config.tokenSymbol === c.tokenSymbol)) {
    fail(`${c.tokenSymbol} is taken: its token account already exists.`);
  }
  const idError = saleIdError(c.tokenSymbol.toLowerCase(), CONTRACT_ID);
  if (idError) fail(idError);
  if (!Number.isInteger(c.decimals) || c.decimals < 0 || c.decimals > 24) fail("invalid decimals: must be at most 24");
  if (c.totalSupply <= 0n) fail("Total supply must be positive.");
  if (c.saleSupply <= 0n) fail("Sale supply must be positive.");
  if (c.saleSupply + c.creatorAllocation > c.totalSupply) fail("Sale supply plus creator allocation exceeds total supply.");
  if (c.lpReserve !== c.totalSupply - c.saleSupply - c.creatorAllocation) fail("LP reserve must be the remainder.");
  if (c.liquidity) {
    // liquidity.rs `LiquidityParams::validate`, plus the mock's own: the remainder is the pool's reserve.
    const l = c.liquidity;
    if (!Number.isInteger(l.raiseShareBps) || l.raiseShareBps < 1 || l.raiseShareBps > MAX_RAISE_SHARE_BPS) {
      fail("invalid liquidity.raise_share_bps: must be between 1 and 5000 (0.01 % to 50 % of the raise)");
    }
    if (l.poolTokens <= 0n || c.saleSupply + l.poolTokens > c.totalSupply) {
      fail("invalid liquidity.pool_tokens: must satisfy 0 < pool_tokens <= total_supply - sale_supply");
    }
    if (!Number.isInteger(l.feeBps) || l.feeBps < 1 || l.feeBps > MAX_POOL_FEE_BPS) {
      fail("invalid liquidity.fee_bps: must be between 1 and 1000 (0.01 % to 10 %)");
    }
    if (l.poolTokens !== c.lpReserve) fail("The launch pool reserve must be the LP reserve.");
  }
  if (c.floorPrice <= 0n) fail("Floor price must be positive.");
  if (c.maxPrice !== null && c.maxPrice < c.floorPrice) fail("Max price must be at least the floor.");
  if (c.minRaise < 0n) fail("Minimum raise cannot be negative.");
  if (c.bidEnd <= c.bidStart) fail("Bid window must end after it starts.");
  if (c.bidStart < Date.now() - 5 * MIN) fail("Bid window cannot start in the past.");
  if (c.bidEnd - c.bidStart > MAX_BID_WINDOW_MS) fail("invalid bid_end: the bid window must be at most 30 days");
  if (c.minDeposit < MIN_DEPOSIT_FLOOR || c.minDeposit > c.maxDepositPerAccount) fail(MIN_DEPOSIT_MESSAGE);
  if (c.maxDepositPerAccount * 10n ** BigInt(c.decimals) > U128_MAX) {
    fail("invalid max_deposit_per_account: max_deposit_per_account * 10^decimals must fit in u128");
  }
  if (c.maxBids !== undefined && (!Number.isInteger(c.maxBids) || c.maxBids < 1 || c.maxBids > MAX_BIDS_PER_SALE)) {
    fail("invalid max_bids: must be between 1 and MAX_BIDS_PER_SALE");
  }
  if (c.revealMode === "tee") {
    if (c.revealWindowMs !== undefined) fail("invalid reveal_window: applies to CommitReveal sales only");
  } else {
    const window = c.revealWindowMs ?? DEFAULT_REVEAL_WINDOW_MS;
    if (window < MIN_REVEAL_WINDOW_MS || window > MAX_REVEAL_WINDOW_MS) {
      fail("invalid reveal_window: must be between 1 minute and 7 days");
    }
  }
  if (c.settleTimeoutMs < MIN_SETTLE_TIMEOUT_MS || c.settleTimeoutMs > MAX_SETTLE_TIMEOUT_MS) {
    fail("invalid settle_timeout: must be between 10 minutes and 7 days");
  }
}
