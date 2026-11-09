/**
 * In-browser mock of the Fairground contract + OutLayer sealer.
 *
 * What is real here: libsodium sealed-box encryption of every bid, the
 * clearing algorithm (@fairground/clearing, the same code the enclave will
 * mirror), the contract-side result checks, sha256 bid-set hashes.
 * What is simulated: chain state (localStorage), tx hashes, the enclave's
 * secret key (held in this browser), the TDX attestation, test USDC.
 * Every simulated thing is labelled in the UI.
 */

import {
  clear,
  contractChecks,
  type Bid as ClearingBid,
  type SaleParams,
} from "@fairground/clearing";
import type {
  Attestation,
  Balances,
  BidRecord,
  ClaimReceipt,
  ContractCheck,
  Sale,
  SaleConfig,
  SaleEvent,
  SaleEventKind,
  SaleMeta,
  SaleResult,
  SaleStatus,
} from "../types";
import {
  fakeTxHash,
  newSaleKeypair,
  openBid,
  randomHex,
  sealBid,
  sha256Hex,
} from "../crypto";
import { makeBots, makeCrowd, type CrowdBidder } from "./crowd";
import type { FairgroundClient, JudgeProgress } from "./index";

const STORAGE_KEY = "fairground:mock:v1";
export const CONTRACT_ID = "fairground.testnet";
export const USDC_TOKEN = "usdc.fakes.testnet";
/** Stand-in for the hash of our reproducible fairground-sealer build. */
export const SEALER_CODE_HASH =
  "7f3a9c2e51d84b06a1e9f0c3d27b8e4f6a5c1d903e2b7f48c6a0d15e9b3f2a71";

const USDC = 1_000_000n;
const TOKEN = 10n ** 18n;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Phase = "bidding" | "clearing" | "settled" | "failed";
type StoredSale = Omit<Sale, "status"> & {
  phase: Phase;
  /** Demo: simulate an enclave that never answers, to show refund mode. */
  enclaveDown?: boolean;
};

type State = {
  version: 1;
  sales: Record<string, StoredSale>;
  bids: Record<string, BidRecord[]>;
  events: Record<string, SaleEvent[]>;
  results: Record<string, SaleResult>;
  balances: Record<string, Balances>;
  /** Simulated enclave memory. In production these never leave the TEE. */
  keys: Record<string, { pk: string; sk: string }>;
  judgeCount: number;
  /** Faucet idempotency keys already used (simulated 1Click swaps). */
  faucetKeys?: Record<string, true>;
};

/** The demo sales seeded on first visit. Their times are relative to that visit. */
const SEEDED_IDS = ["lantern", "driftwood", "ashfall", "kiln", "fairt", "moth"];

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

function usdcOf(whole: number): bigint {
  return BigInt(Math.round(whole * 1_000_000));
}

export class MockClient implements FairgroundClient {
  readonly mode = "mock" as const;
  readonly contractId = CONTRACT_ID;

  private state: State | null = null;
  private loading: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private clearing = new Map<string, Promise<void>>();

  // ---------- lifecycle ----------

  ready(): Promise<void> {
    if (this.state) return Promise.resolve();
    if (!this.loading) this.loading = this.load();
    return this.loading;
  }

  private async load() {
    const raw = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) {
      try {
        this.state = JSON.parse(raw, reviver) as State;
      } catch {
        this.state = null;
      }
    }
    if (!this.state) {
      this.state = this.empty();
      await this.seed();
      this.persist();
    } else if (this.seedIsStale(Date.now())) {
      await this.refreshSeed();
      this.persist();
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
      version: 1,
      sales: {},
      bids: {},
      events: {},
      results: {},
      balances: {},
      keys: {},
      judgeCount: 0,
    };
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

  async reset() {
    this.state = this.empty();
    this.clearing.clear();
    await this.seed();
    this.commit();
  }

  /**
   * The seeded sales are timed from the first visit, so after a while none is
   * live. Once the live demo sale (Fair Test) has closed, re-seed them, unless
   * this browser still has an unclaimed bid in one of them.
   */
  private seedIsStale(now: number): boolean {
    const live = this.s.sales.fairt;
    if (live && live.config.bidEnd > now) return false;
    const pending = SEEDED_IDS.some((id) => (this.s.bids[id] ?? []).some((b) => !b.tag && !b.claimed));
    return !pending;
  }

  /** Replace only the seeded sales. User-created sales, judge runs and balances stay. */
  private async refreshSeed() {
    for (const id of SEEDED_IDS) {
      delete this.s.sales[id];
      delete this.s.bids[id];
      delete this.s.events[id];
      delete this.s.results[id];
      delete this.s.keys[id];
      this.clearing.delete(id);
    }
    await this.seed();
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
    const { phase, enclaveDown, ...rest } = s;
    void phase;
    void enclaveDown;
    return { ...rest, status: deriveStatus(s, Date.now()) };
  }

  async listSales() {
    await this.ready();
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
      ...extra,
    };
    (this.s.events[saleId] ??= []).push(e);
    return e;
  }

  // ---------- create ----------

  async createSale(creator: string, config: SaleConfig, meta: SaleMeta) {
    await this.ready();
    validateConfig(config, Object.values(this.s.sales));
    await txLatency();
    const sale = await this.insertSale(creator, config, meta, Date.now());
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
    const keys = await newSaleKeypair();
    this.s.keys[id] = { pk: keys.publicKey, sk: keys.secretKey };
    const createTx = fakeTxHash();
    const sale: StoredSale = {
      id,
      creator,
      tokenAccount: `${sym}.${CONTRACT_ID}`,
      config,
      meta,
      phase: "bidding",
      createdAt,
      createTx,
      sealerPubkey: keys.publicKey,
      sealerCodeHash: SEALER_CODE_HASH,
      bidSetHash: null,
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

  async placeBid(saleId: string, bidder: string, deposit: bigint, ciphertext: string) {
    await this.ready();
    await txLatency();
    const bid = this.insertBid(saleId, bidder, deposit, ciphertext, Date.now());
    this.commit();
    return bid;
  }

  private insertBid(
    saleId: string,
    bidder: string,
    deposit: bigint,
    ciphertext: string,
    at: number,
    tag?: BidRecord["tag"],
    opts: { skipBalance?: boolean; skipWindow?: boolean } = {},
  ): BidRecord {
    const sale = this.s.sales[saleId];
    if (!sale) throw new Error("Sale not found.");
    const c = sale.config;
    const reject = (msg: string): never => {
      this.log(saleId, "bid_rejected", `Deposit returned: ${msg}`, { at, account: bidder, amount: deposit });
      this.commit();
      throw new Error(msg);
    };
    if (!opts.skipWindow) {
      const st = deriveStatus(sale, at);
      if (st !== "open") reject(st === "upcoming" ? "The bid window has not opened yet." : "The bid window is closed.");
    }
    if (deposit < c.minDeposit) reject(`Minimum deposit is ${fmt(c.minDeposit)} USDC.`);
    if (deposit > c.maxDepositPerAccount) reject(`Maximum deposit per account is ${fmt(c.maxDepositPerAccount)} USDC.`);
    if ((this.s.bids[saleId] ?? []).some((b) => b.bidder === bidder)) {
      reject("This account already has a bid in this sale. One bid per account.");
    }
    if (!opts.skipBalance) {
      const bal = this.balancesOf(bidder);
      if (bal.usdc < deposit) reject("Not enough USDC. Use the faucet or fund from another chain.");
      this.s.balances[bidder].usdc -= deposit;
    }
    const bids = (this.s.bids[saleId] ??= []);
    const rec: BidRecord = {
      saleId,
      index: bids.length,
      bidder,
      deposit,
      ciphertext,
      placedAt: at,
      txHash: fakeTxHash(),
      claimed: false,
      claimTx: null,
      ...(tag ? { tag } : {}),
    };
    bids.push(rec);
    sale.bidCount += 1;
    sale.totalDeposits += deposit;
    this.log(saleId, "bid", `Sealed bid with ${fmt(deposit)} USDC deposit. Price hidden.`, {
      at,
      account: bidder,
      amount: deposit,
      txHash: rec.txHash,
    });
    return rec;
  }

  // ---------- close + clear ----------

  async closeSale(saleId: string, caller: string) {
    await this.ready();
    await txLatency();
    const sale = this.closeInternal(saleId, caller, Date.now());
    const hash = await this.bidSetHash(saleId);
    sale.bidSetHash = hash;
    this.commit();
    if (!sale.enclaveDown) this.scheduleClearing(saleId, 1400 + Math.random() * 1200);
    return this.view(sale);
  }

  private closeInternal(saleId: string, caller: string, at: number): StoredSale {
    const sale = this.s.sales[saleId];
    if (!sale) throw new Error("Sale not found.");
    const st = deriveStatus(sale, at);
    if (st !== "awaiting_close") {
      throw new Error(st === "open" || st === "upcoming" ? "The bid window has not ended yet." : "This sale is already closed.");
    }
    sale.phase = "clearing";
    sale.closedAt = at;
    this.log(saleId, "closed", `Bid set frozen at ${sale.bidCount} bids.`, { at, account: caller });
    this.log(saleId, "clearing_requested", "Sealed bids sent to the OutLayer enclave (yield/resume).", { at: at + 1 });
    return sale;
  }

  private async bidSetHash(saleId: string): Promise<string> {
    const bids = this.s.bids[saleId] ?? [];
    const canon = bids.map((b) => `${b.index}|${b.bidder}|${b.deposit}|${b.ciphertext}`).join("\n");
    return sha256Hex(`${saleId}\n${canon}`);
  }

  private scheduleClearing(saleId: string, ms: number) {
    if (this.clearing.has(saleId)) return;
    const p = delay(ms)
      .then(() => this.runEnclave(saleId))
      .then(() => this.commit())
      .finally(() => this.clearing.delete(saleId));
    this.clearing.set(saleId, p);
  }

  /** Simulated fairground-sealer job: decrypt, clear, return; then the contract checks. */
  private async runEnclave(saleId: string, at = Date.now()) {
    const t0 = performance.now();
    const sale = this.s.sales[saleId];
    if (!sale || sale.phase !== "clearing") return;
    const key = this.s.keys[saleId];
    const bids = this.s.bids[saleId] ?? [];
    const c = sale.config;

    const decoded: ClearingBid[] = await Promise.all(
      bids.map(async (b) => {
        const pt = await openBid(b.ciphertext, key.pk, key.sk);
        if (!pt) return { bidder: b.bidder, deposit: b.deposit, maxPrice: null, maxSpend: null };
        let maxPrice = BigInt(pt.max_price);
        if (c.maxPrice !== null && maxPrice > c.maxPrice) maxPrice = c.maxPrice;
        return {
          bidder: b.bidder,
          deposit: b.deposit,
          maxPrice,
          maxSpend: BigInt(pt.max_spend),
          mismatch: pt.sale_id !== saleId || pt.bidder !== b.bidder,
        };
      }),
    );

    const params: SaleParams = {
      saleSupply: c.saleSupply,
      floorPrice: c.floorPrice,
      minRaise: c.minRaise,
      decimals: c.decimals,
    };
    const r = clear(params, decoded);
    // The enclave reports the hash of the bid set it actually received.
    const reportedHash = await this.bidSetHash(saleId);
    const checks = buildChecks(params, bids, r, reportedHash, sale.bidSetHash);
    const allPass = checks.every((ch) => ch.passed || ch.id === "raise_at_least_min");
    const settled = r.status === "settled" && allPass;

    const settleTx = fakeTxHash();
    const result: SaleResult = {
      ...r,
      status: settled ? "settled" : "failed",
      // A failed sale (including one rejected by a contract check after the
      // enclave reported "settled") pays out full deposits and no tokens.
      fills: r.fills.map((f, i) => ({
        ...f,
        ...(settled ? {} : { tokens: 0n, spent: 0n, refund: f.deposit }),
        claimed: false,
        claimTx: null,
        ...(bids[i].tag ? { tag: bids[i].tag } : {}),
      })),
      ...(settled ? {} : { totalSold: 0n, totalRaised: 0n, unsold: c.saleSupply }),
      bidSetHash: reportedHash,
      checks,
      settleTx,
      clearingMs: Math.round(performance.now() - t0) + 900,
    };
    this.s.results[saleId] = result;
    sale.phase = settled ? "settled" : "failed";
    sale.settledAt = at;
    if (settled) {
      this.credit(sale.creator, r.totalRaised);
      this.log(
        saleId,
        "settled",
        `Cleared at ${fmt(r.clearingPrice)} USDC per token. ${r.nValid} valid bids, ${r.nInvalid} void. All contract checks passed.`,
        { at, txHash: settleTx, amount: r.totalRaised },
      );
    } else {
      this.log(
        saleId,
        "failed",
        r.failReason === "below_min_raise"
          ? "Minimum raise not met. Every bidder can claim a full refund."
          : r.failReason === "no_valid_bids"
            ? "No valid bids. Every bidder can claim a full refund."
            : "A contract check failed. Every bidder can claim a full refund.",
        { at, txHash: settleTx },
      );
    }
  }

  async triggerRefundMode(saleId: string, caller: string) {
    await this.ready();
    const sale = this.s.sales[saleId];
    if (!sale) throw new Error("Sale not found.");
    if (sale.phase !== "clearing" || sale.closedAt === null) throw new Error("Refund mode is only for a sale stuck in clearing.");
    const due = sale.closedAt + sale.config.settleTimeoutMs;
    if (Date.now() < due) throw new Error("Settle timeout has not passed yet.");
    await txLatency();
    const bids = this.s.bids[saleId] ?? [];
    const now = Date.now();
    sale.phase = "failed";
    sale.refundModeAt = now;
    sale.settledAt = now;
    const settleTx = fakeTxHash();
    this.s.results[saleId] = {
      status: "failed",
      failReason: "settle_timeout",
      clearingPrice: sale.config.floorPrice,
      fills: bids.map((b) => ({
        index: b.index,
        bidder: b.bidder,
        deposit: b.deposit,
        tokens: 0n,
        spent: 0n,
        refund: b.deposit,
        valid: true,
        claimed: false,
        claimTx: null,
        ...(b.tag ? { tag: b.tag } : {}),
      })),
      totalSold: 0n,
      totalRaised: 0n,
      unsold: sale.config.saleSupply,
      oversubscribed: false,
      nValid: bids.length,
      nInvalid: 0,
      bidSetHash: sale.bidSetHash ?? "",
      checks: [],
      settleTx,
      clearingMs: 0,
    };
    this.log(saleId, "refund_mode", "Settle timeout passed with no result. Sale moved to refunds. Every deposit can be claimed in full.", {
      account: caller,
      txHash: settleTx,
    });
    this.commit();
    return this.view(sale);
  }

  // ---------- claim ----------

  async claim(saleId: string, bidder: string): Promise<ClaimReceipt> {
    await this.ready();
    await txLatency();
    const r = this.claimInternal(saleId, bidder, Date.now());
    this.commit();
    return r;
  }

  private claimInternal(saleId: string, bidder: string, at: number): ClaimReceipt {
    const sale = this.s.sales[saleId];
    const result = this.s.results[saleId];
    if (!sale || !result) throw new Error("This sale has no result yet.");
    const bid = (this.s.bids[saleId] ?? []).find((b) => b.bidder === bidder);
    if (!bid) throw new Error("No bid from this account in this sale.");
    if (bid.claimed) throw new Error("Already claimed.");
    const fill = result.fills[bid.index];
    const txHash = fakeTxHash();
    this.credit(bidder, fill.refund, saleId, fill.tokens);
    bid.claimed = true;
    bid.claimTx = txHash;
    fill.claimed = true;
    fill.claimTx = txHash;
    this.log(
      saleId,
      "claimed",
      fill.tokens > 0n
        ? `Claimed tokens and ${fmt(fill.refund)} USDC unspent.`
        : `Claimed full refund of ${fmt(fill.refund)} USDC.`,
      { at, account: bidder, amount: fill.refund, txHash },
    );
    return { saleId, bidder, tokens: fill.tokens, refund: fill.refund, txHash };
  }

  // ---------- attestation ----------

  async getAttestation(saleId: string, nonce: string): Promise<Attestation> {
    await this.ready();
    await delay(400 + Math.random() * 400);
    const sale = this.s.sales[saleId];
    if (!sale) throw new Error("Sale not found.");
    const result = this.s.results[saleId];
    return {
      nonce,
      codeHash: sale.sealerCodeHash,
      reportedPubkey: sale.sealerPubkey,
      inputHash: sale.bidSetHash ?? "",
      outputHash: result ? await sha256Hex(JSON.stringify(result, replacer)) : "",
      quote: randomHex(48),
      fetchedAt: Date.now(),
      url: "https://outlayer.fastnear.com/",
      simulated: true,
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
    const sale = await this.insertSale("judge.testnet", config, {
      description: "A seeded judge-mode sale. Every bidder is fictional.",
      hue: (n * 47) % 360,
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
    progress({ step: "crowd", saleId, bidsPlaced: placed, message: "50 people bid over the window. Each bid is sealed in their browser." });
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
    const victim = this.s.bids[saleId].filter((b) => b.tag === "sim")[2];
    this.insertBid(saleId, "copycat-bot.testnet", victim.deposit, victim.ciphertext, at(), "bot", sim);
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
    const ct = await sealBid(sale.sealerPubkey, {
      sale_id: sale.id,
      bidder: b.account,
      max_price: maxPrice.toString(),
      max_spend: usdcOf(b.spend).toString(),
      salt: randomHex(16),
    });
    return this.insertBid(sale.id, b.account, usdcOf(b.deposit), ct, at, tag, opts);
  }

  private async seedSale(
    def: {
      id: string;
      name: string;
      symbol: string;
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
      copycat?: boolean;
      closeAt?: number;
      enclaveDown?: boolean;
      claimShare?: number;
    },
    now: number,
  ) {
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
      { description: def.description, hue: def.hue },
      def.start - 6 * HOUR,
      { id: def.id },
    );
    sale.enclaveDown = def.enclaveDown;
    const lastBidAt = Math.min(now, def.end);
    for (const b of makeBots(def.bots, 10)) {
      await this.seedBid(sale, b, def.start + 400, "bot", { skipBalance: true, skipWindow: true });
    }
    for (const b of makeCrowd(def.hue * 31 + def.crowd, def.crowd, 10)) {
      const at = def.start + Math.floor(b.arrival * (lastBidAt - def.start));
      await this.seedBid(sale, b, at, "sim", { skipBalance: true, skipWindow: true });
    }
    if (def.copycat) {
      // A copy can only exist after the bid it copies: it lands 30 s later.
      const victim = this.s.bids[sale.id][4];
      const copyAt = Math.min(victim.placedAt + 30_000, lastBidAt - 1);
      this.insertBid(sale.id, "copycat-bot.testnet", victim.deposit, victim.ciphertext, copyAt, "bot", {
        skipBalance: true,
        skipWindow: true,
      });
    }
    // Keep bids in time order, like the chain would.
    const bids = this.s.bids[sale.id].sort((a, b) => a.placedAt - b.placedAt);
    bids.forEach((b, i) => (b.index = i));

    if (def.closeAt !== undefined) {
      this.closeInternal(sale.id, "keeper.testnet", def.closeAt);
      sale.bidSetHash = await this.bidSetHash(sale.id);
      if (!def.enclaveDown) {
        await this.runEnclave(sale.id, def.closeAt + 95_000);
        const share = def.claimShare ?? 0;
        bids.forEach((b, i) => {
          if (i % 10 < share * 10) this.claimInternal(sale.id, b.bidder, def.closeAt! + 3 * HOUR + i * MIN);
        });
      }
    }
  }

  private async seed() {
    const now = Date.now();
    await this.seedSale({
      id: "lantern", name: "Lantern", symbol: "LNTN", creator: "lantern-labs.testnet",
      description: "A community token for a night-market collective. Oversubscribed; cleared well above the floor.",
      hue: 38, saleSupply: 150_000, floor: 0.001, minRaise: 50,
      start: now - 3 * DAY, end: now - 3 * DAY + 4 * HOUR, crowd: 45, bots: 3, copycat: true,
      closeAt: now - 3 * DAY + 4 * HOUR + 2 * MIN, claimShare: 0.6,
    }, now);
    await this.seedSale({
      id: "driftwood", name: "Driftwood", symbol: "DRFT", creator: "shoreline.testnet",
      description: "Missed its minimum raise. Every bidder was refunded in full.",
      hue: 200, saleSupply: 300_000, floor: 0.002, minRaise: 400,
      start: now - 5 * DAY, end: now - 5 * DAY + 3 * HOUR, crowd: 7, bots: 0,
      closeAt: now - 5 * DAY + 3 * HOUR + 5 * MIN, claimShare: 0.3,
    }, now);
    await this.seedSale({
      id: "ashfall", name: "Ashfall", symbol: "ASHF", creator: "kilnworks.testnet",
      description: "The enclave never answered. After the 2-hour settle timeout anyone can switch it to refunds.",
      hue: 12, saleSupply: 200_000, floor: 0.001, minRaise: 50,
      start: now - 9 * HOUR, end: now - 5 * HOUR, crowd: 12, bots: 1,
      closeAt: now - 5 * HOUR + 3 * MIN, enclaveDown: true,
    }, now);
    await this.seedSale({
      id: "kiln", name: "Kiln", symbol: "KILN", creator: "kilnworks.testnet",
      description: "Bid window just ended. Anyone can close it and trigger clearing.",
      hue: 22, saleSupply: 120_000, floor: 0.001, minRaise: 50,
      start: now - 2 * HOUR, end: now - 4 * MIN, crowd: 31, bots: 2,
    }, now);
    await this.seedSale({
      id: "fairt", name: "Fair Test", symbol: "FAIRT", creator: "fairground.testnet",
      description: "The reference sale from the spec: 600k tokens, 0.001 USDC floor, 50 USDC minimum raise.",
      hue: 214, saleSupply: 600_000, floor: 0.001, minRaise: 50,
      start: now - 40 * MIN, end: now + 2 * HOUR, crowd: 26, bots: 2,
    }, now);
    await this.seedSale({
      id: "moth", name: "Moth", symbol: "MOTH", creator: "nightshift.testnet",
      description: "Opens tomorrow. Rules are already locked and readable.",
      hue: 280, saleSupply: 250_000, floor: 0.0015, minRaise: 100,
      start: now + 20 * HOUR, end: now + 26 * HOUR, crowd: 0, bots: 0,
    }, now);
  }
}

// ---------- helpers ----------

function fmt(v: bigint): string {
  const whole = v / USDC;
  const frac = (v % USDC).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function judgeConfig(n: number, now: number, windowMs: number): SaleConfig {
  return {
    tokenName: `Judge Run ${n}`,
    tokenSymbol: `JDG${n}`,
    decimals: 18,
    totalSupply: 1_000_000n * TOKEN,
    saleSupply: 100_000n * TOKEN,
    creatorAllocation: 100_000n * TOKEN,
    lpReserve: 800_000n * TOKEN,
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

export function validateConfig(c: SaleConfig, existing: { config: SaleConfig }[] = []) {
  const fail = (m: string): never => {
    throw new Error(m);
  };
  if (!c.tokenName.trim()) fail("Token name is required.");
  if (!/^[A-Z0-9]{2,8}$/.test(c.tokenSymbol)) fail("Symbol must be 2-8 capital letters or digits.");
  if (existing.some((s) => s.config.tokenSymbol === c.tokenSymbol)) {
    fail(`${c.tokenSymbol} is taken: its token account already exists.`);
  }
  if (c.totalSupply <= 0n) fail("Total supply must be positive.");
  if (c.saleSupply <= 0n) fail("Sale supply must be positive.");
  if (c.saleSupply + c.creatorAllocation > c.totalSupply) fail("Sale supply plus creator allocation exceeds total supply.");
  if (c.lpReserve !== c.totalSupply - c.saleSupply - c.creatorAllocation) fail("LP reserve must be the remainder.");
  if (c.floorPrice <= 0n) fail("Floor price must be positive.");
  if (c.maxPrice !== null && c.maxPrice < c.floorPrice) fail("Max price must be at least the floor.");
  if (c.minRaise < 0n) fail("Minimum raise cannot be negative.");
  if (c.bidEnd <= c.bidStart) fail("Bid window must end after it starts.");
  if (c.bidStart < Date.now() - 5 * MIN) fail("Bid window cannot start in the past.");
  if (c.minDeposit <= 0n) fail("Minimum deposit must be positive.");
  if (c.minDeposit > c.maxDepositPerAccount) fail("Minimum deposit exceeds the per-account cap.");
  if (c.revealMode !== "tee") fail("Commit-reveal mode is not available in this demo yet. Use the TEE mode.");
}

function buildChecks(
  params: SaleParams,
  bids: BidRecord[],
  r: ReturnType<typeof clear>,
  reportedHash: string,
  storedHash: string | null,
): ContractCheck[] {
  const failed = contractChecks(params, bids, r);
  const ok = (prefix: string) => !failed.some((f) => f.startsWith(prefix));
  return [
    { id: "source", label: "Result came from OutLayer for the registered sealer code hash", passed: true },
    { id: "state", label: "Sale was in Clearing when the result arrived", passed: true },
    { id: "bid_set_hash", label: "Result's bid-set hash equals the hash stored at close", passed: reportedHash === storedHash },
    { id: "price_at_least_floor", label: "Clearing price is at least the floor", passed: ok("price_at_least_floor") },
    { id: "sold_at_most_supply", label: "Tokens filled are at most the sale supply", passed: ok("sold_at_most_supply") },
    { id: "bidder_matches", label: "Every fill belongs to a bidder in the frozen bid set", passed: ok("one_fill_per_bid") && ok("bidder_matches") },
    { id: "spent_within_deposit", label: "No fill costs more than that bidder's deposit", passed: ok("spent_within_deposit") },
    { id: "spent_equals_tokens_times_price", label: "Every charge equals tokens × clearing price", passed: ok("spent_equals_tokens_times_price") },
    { id: "raise_sums_fills", label: "Total raise equals the sum of all charges", passed: ok("raise_sums_fills") },
    { id: "raise_at_least_min", label: "Total raise meets the minimum raise (else everyone is refunded)", passed: ok("raise_at_least_min") },
  ];
}
