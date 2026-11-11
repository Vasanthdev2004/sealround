/**
 * Fund from any chain: 1Click (NEAR Intents) client logic.
 *
 * Quotes are live and dry: the browser calls our /api/oneclick/* proxy, which
 * forces `dry: true`, so no deposit address is ever created. There is no
 * Intents testnet, so on testnet the swap itself is simulated: a FundingRecord
 * walks through the real 1Click statuses and then test USDC is minted.
 *
 * Delivery needs the recipient registered on the USDC contract (NEP-145): a
 * transfer to an unregistered account fails. In NEAR mode `ensureDeliverable`
 * has the relayer register the account for free before any USDC is sent
 * (the wallet pays the 0.00125 NEAR itself only when the relayer's storage
 * budget is used up). The simulated chain has no registration.
 *
 * Money is bigint everywhere. USD values from 1Click arrive as decimal strings
 * and are parsed to micro-USD (6 dp), the same scale as USDC.
 */

import { parseUnits } from "@fairground/clearing";
import { getClient } from "./client";
import { fakeTxHash, randomHex } from "./crypto";
import { getFundings, saveFunding, type FundingRecord, type OneClickStatus } from "./funding";
import type { StorageResult, WriteOptions } from "./types";

// ---------- delivery ----------

/**
 * Makes sure `account` can receive USDC, before a swap delivers to it:
 * - already registered on the USDC contract: nothing happens;
 * - otherwise the relayer registers it at its own cost (POST /storage); an
 *   answer of already_registered, or rate_limited while the account turns out
 *   to be registered, counts as success;
 * - when the relayer's storage budget is used up for the day (or there is no
 *   relayer), the connected wallet pays a storage_deposit of 0.00125 NEAR.
 *   `opts.onPaidFallback` is awaited first, so the UI can say why the wallet
 *   is about to ask; throwing there stops it.
 *
 * Returns how the account got registered. Always "already_registered" on the
 * simulated chain. Throws a FairgroundError when the account could not be
 * registered; no USDC must be sent to it then.
 */
export function ensureDeliverable(account: string, opts?: WriteOptions): Promise<StorageResult> {
  return getClient().ensureUsdcStorage(account, opts);
}

/** Whether a swap can be simulated here: it ends by minting test USDC, which mainnet has not. */
export const canSimulateSwaps = (): boolean => getClient().capabilities.faucet;

// ---------- constants ----------

/** USDC (NEP-141, native Circle) on NEAR mainnet, as listed by GET /v0/tokens. */
export const NEAR_USDC_ASSET = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const NEAR_USDC_CONTRACT = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/**
 * 1Click only delivers to existing mainnet NEAR accounts. A testnet account is
 * rejected, so dry quotes for testnet users are priced for this stand-in.
 * The quoted price does not depend on the recipient.
 */
export const STANDIN_RECIPIENT = "intents.near";

/** 1% slippage, in basis points. */
export const SLIPPAGE_BPS = 100;
/** How long we treat a dry quote as fresh before refreshing it. */
export const QUOTE_TTL_MS = 30_000;
/** 1Click deposit addresses go cold after about 10 minutes. */
export const DEPOSIT_WINDOW_MS = 10 * 60_000;

export type OriginId = "base-usdc" | "arb-usdc" | "eth-eth" | "sol-sol" | "btc-btc";

export type Origin = {
  id: OriginId;
  /** Display chain name, also stored on the FundingRecord. */
  chain: string;
  /** 1Click `blockchain` code. */
  blockchain: string;
  symbol: string;
  /** Fallback asset id if the token list is unreachable. */
  assetId: string;
  decimals: number;
  /** Orb hue. */
  hue: number;
  /** Example amount shown when the field is empty. */
  placeholder: string;
  /** Valid-format sample refund address, used for dry quotes when none is given. */
  sampleRefund: string;
  refundHint: string;
  /** Rough USD reference, only for the offline estimate. Labelled when used. */
  referenceUsd: number;
  /** Seconds, only for the offline estimate. */
  referenceTimeSec: number;
  /** How long until 1Click refunds an unfinished swap. BTC needs longer. */
  deadlineMs: number;
};

const EVM_SAMPLE = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";

export const ORIGINS: Origin[] = [
  {
    id: "base-usdc",
    chain: "Base",
    blockchain: "base",
    symbol: "USDC",
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    decimals: 6,
    hue: 218,
    placeholder: "25",
    sampleRefund: EVM_SAMPLE,
    refundHint: "0x… address on Base",
    referenceUsd: 1,
    referenceTimeSec: 35,
    deadlineMs: 30 * 60_000,
  },
  {
    id: "arb-usdc",
    chain: "Arbitrum",
    blockchain: "arb",
    symbol: "USDC",
    assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    decimals: 6,
    hue: 200,
    placeholder: "25",
    sampleRefund: EVM_SAMPLE,
    refundHint: "0x… address on Arbitrum",
    referenceUsd: 1,
    referenceTimeSec: 25,
    deadlineMs: 30 * 60_000,
  },
  {
    id: "eth-eth",
    chain: "Ethereum",
    blockchain: "eth",
    symbol: "ETH",
    assetId: "nep141:eth.omft.near",
    decimals: 18,
    hue: 228,
    placeholder: "0.01",
    sampleRefund: EVM_SAMPLE,
    refundHint: "0x… address on Ethereum",
    referenceUsd: 2100,
    referenceTimeSec: 45,
    deadlineMs: 30 * 60_000,
  },
  {
    id: "sol-sol",
    chain: "Solana",
    blockchain: "sol",
    symbol: "SOL",
    assetId: "nep141:sol.omft.near",
    decimals: 9,
    hue: 162,
    placeholder: "0.3",
    sampleRefund: "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK",
    refundHint: "Solana address",
    referenceUsd: 87,
    referenceTimeSec: 20,
    deadlineMs: 30 * 60_000,
  },
  {
    id: "btc-btc",
    chain: "Bitcoin",
    blockchain: "btc",
    symbol: "BTC",
    assetId: "nep141:btc.omft.near",
    decimals: 8,
    hue: 32,
    placeholder: "0.0005",
    sampleRefund: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    refundHint: "bc1… address",
    referenceUsd: 74000,
    referenceTimeSec: 800,
    deadlineMs: 2 * 60 * 60_000,
  },
];

export const originById = (id: OriginId): Origin => ORIGINS.find((o) => o.id === id) ?? ORIGINS[0];

// ---------- token list ----------

export type OneClickToken = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
};

let tokenCache: { at: number; tokens: OneClickToken[] } | null = null;
let tokenInflight: Promise<OneClickToken[]> | null = null;

/** GET /v0/tokens through our proxy. Cached in memory for a minute. */
export async function fetchTokens(): Promise<OneClickToken[]> {
  if (tokenCache && Date.now() - tokenCache.at < 60_000) return tokenCache.tokens;
  if (!tokenInflight) {
    tokenInflight = (async () => {
      const res = await fetch("/api/oneclick/tokens");
      if (!res.ok) throw new Error(await errorMessage(res));
      const tokens = (await res.json()) as OneClickToken[];
      if (!Array.isArray(tokens)) throw new Error("Unexpected token list.");
      tokenCache = { at: Date.now(), tokens };
      return tokens;
    })().finally(() => {
      tokenInflight = null;
    });
  }
  return tokenInflight;
}

function findOrigin(tokens: OneClickToken[] | null, o: Origin): OneClickToken | null {
  return tokens?.find((t) => t.blockchain === o.blockchain && t.symbol === o.symbol) ?? null;
}

function findNearUsdc(tokens: OneClickToken[] | null): OneClickToken | null {
  return tokens?.find((t) => t.blockchain === "near" && t.contractAddress === NEAR_USDC_CONTRACT) ?? null;
}

// ---------- amounts ----------

/** Parse a human amount on the origin chain. Returns base units or a plain-words error. */
export function parseOriginAmount(input: string, origin: Origin): { value: bigint } | { error: string } | null {
  const s = input.trim();
  if (!s) return null;
  try {
    const v = parseUnits(s, origin.decimals);
    if (v <= 0n) return { error: "Enter an amount above zero." };
    return { value: v };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("too many decimals")) return { error: `${origin.symbol} has at most ${origin.decimals} decimals.` };
    return { error: "Enter a number, like " + origin.placeholder + "." };
  }
}

/** "24.987675000000" -> micro-USD bigint. Null when missing or malformed. */
export function usdToMicro(s: string | undefined | null): bigint | null {
  if (!s) return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return null;
  return parseUnits(`${m[1]}.${(m[2] ?? "").slice(0, 6) || "0"}`, 6);
}

function priceToMicro(price: number): bigint {
  return BigInt(Math.round(price * 1_000_000));
}

// ---------- quotes ----------

export type DryQuoteInput = {
  originId: OriginId;
  /** Origin base units, decimal string. */
  amount: string;
  /** NEAR account that should receive USDC. */
  recipient: string;
  /** Origin-chain refund address. Empty = sample address (dry quotes only). */
  refundTo: string;
};

export type QuoteView = {
  /** live = a real 1Click dry quote. estimate = 1Click gave no quote; we computed one. */
  source: "live" | "estimate";
  /** Priced for STANDIN_RECIPIENT because the real one is a testnet account. */
  standIn: boolean;
  /** Plain-words notes on how this number was produced. */
  notes: string[];
  originId: OriginId;
  amountIn: bigint;
  amountInFormatted: string;
  /** Micro-USD. */
  amountInUsd: bigint | null;
  /** USDC on NEAR, base units. */
  amountOut: bigint;
  minAmountOut: bigint;
  amountOutUsd: bigint | null;
  /** Micro-USD, amountInUsd - amountOutUsd. */
  fee: bigint | null;
  timeEstimateSec: number;
  fetchedAt: number;
  expiresAt: number;
  correlationId?: string;
};

/** A quote problem the user can fix (e.g. a bad refund address). */
export class QuoteInputError extends Error {
  constructor(
    message: string,
    readonly field: "amount" | "refundTo",
  ) {
    super(message);
  }
}

type QuoteResponse = {
  quote: {
    amountIn: string;
    amountInFormatted: string;
    amountInUsd: string;
    minAmountIn: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd: string;
    minAmountOut: string;
    timeEstimate: number;
    refundFee?: string;
    withdrawFee?: string;
  };
  correlationId?: string;
  timestamp?: string;
};

async function errorMessage(res: Response): Promise<string> {
  try {
    const j = (await res.clone().json()) as { message?: unknown };
    if (typeof j.message === "string" && j.message) return j.message;
  } catch {}
  return `HTTP ${res.status}`;
}

const isMainnetRecipient = (r: string) => /\.near$/.test(r) || /^[0-9a-f]{64}$/.test(r);

async function postQuote(body: Record<string, unknown>): Promise<{ ok: true; data: QuoteResponse } | { ok: false; status: number; message: string }> {
  let res: Response;
  try {
    res = await fetch("/api/oneclick/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, message: "Could not reach our quote proxy." };
  }
  if (!res.ok) return { ok: false, status: res.status, message: await errorMessage(res) };
  return { ok: true, data: (await res.json()) as QuoteResponse };
}

/**
 * Live dry quote: origin asset -> USDC on NEAR, EXACT_INPUT, 1% slippage.
 * Falls back to a labelled estimate when 1Click is unreachable or gives no quote.
 */
export async function getDryQuote(input: DryQuoteInput): Promise<QuoteView> {
  const origin = originById(input.originId);
  const amount = BigInt(input.amount);
  const notes: string[] = [];

  const tokens = await fetchTokens().catch(() => null);
  const originToken = findOrigin(tokens, origin);
  const dest = findNearUsdc(tokens);

  let recipient = input.recipient.trim();
  let standIn = false;
  if (!isMainnetRecipient(recipient)) {
    recipient = STANDIN_RECIPIENT;
    standIn = true;
  }
  const refundTo = input.refundTo.trim() || origin.sampleRefund;

  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: originToken?.assetId ?? origin.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: dest?.assetId ?? NEAR_USDC_ASSET,
    amount: input.amount,
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + origin.deadlineMs).toISOString(),
  };

  let r = await postQuote(body);
  if (!r.ok && /refundTo/i.test(r.message)) {
    throw new QuoteInputError(`That refund address is not valid on ${origin.chain}.`, "refundTo");
  }
  // A real mainnet recipient that 1Click rejects (e.g. not yet created): price it for the stand-in.
  if (!r.ok && r.status >= 400 && r.status < 500 && !standIn) {
    const retry = await postQuote({ ...body, recipient: STANDIN_RECIPIENT });
    if (retry.ok) {
      standIn = true;
      notes.push(
        `1Click would not quote for ${input.recipient}; it may not exist on mainnet yet. This quote is priced for a stand-in mainnet recipient. The price does not depend on who receives it.`,
      );
    }
    r = retry;
  } else if (standIn) {
    notes.push(
      "1Click only delivers to mainnet NEAR accounts, so this quote is priced for a stand-in mainnet recipient. The price does not depend on who receives it.",
    );
  }

  const now = Date.now();
  if (r.ok) {
    const q = r.data.quote;
    const inUsd = usdToMicro(q.amountInUsd);
    const outUsd = usdToMicro(q.amountOutUsd);
    return {
      source: "live",
      standIn,
      notes,
      originId: origin.id,
      amountIn: BigInt(q.amountIn),
      amountInFormatted: q.amountInFormatted,
      amountInUsd: inUsd,
      amountOut: BigInt(q.amountOut),
      minAmountOut: BigInt(q.minAmountOut),
      amountOutUsd: outUsd,
      fee: inUsd !== null && outUsd !== null ? inUsd - outUsd : null,
      timeEstimateSec: q.timeEstimate,
      fetchedAt: now,
      expiresAt: now + QUOTE_TTL_MS,
      correlationId: r.data.correlationId,
    };
  }

  // ----- Fallback: labelled estimate, never presented as a quote. -----
  const reason =
    r.status === 0 || r.status === 502 || r.status === 504
      ? "1Click is unreachable right now."
      : /failed to get quote/i.test(r.message)
        ? "1Click returned no quote. The amount may be too small for this route."
        : `1Click returned no quote: ${r.message}.`;
  const livePrices = !!originToken && !!dest;
  const priceIn = livePrices ? priceToMicro(originToken.price) : priceToMicro(origin.referenceUsd);
  const priceOut = livePrices ? priceToMicro(dest.price) : 1_000_000n;
  const inUsd = (amount * priceIn) / 10n ** BigInt(origin.decimals);
  // Assume the keyless 1Click fee of about 0.25%.
  const outUsd = (inUsd * 9975n) / 10_000n;
  const out = priceOut > 0n ? (outUsd * 1_000_000n) / priceOut : outUsd;
  notes.unshift(
    reason +
      (livePrices
        ? " This estimate uses 1Click's listed token prices and an assumed 0.25% fee. It is not a quote."
        : " This estimate uses fixed reference prices, not live ones, and an assumed 0.25% fee. It is not a quote."),
  );
  return {
    source: "estimate",
    standIn,
    notes,
    originId: origin.id,
    amountIn: amount,
    amountInFormatted: input.amount,
    amountInUsd: inUsd,
    amountOut: out,
    minAmountOut: (out * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n,
    amountOutUsd: outUsd,
    fee: inUsd - outUsd,
    timeEstimateSec: origin.referenceTimeSec,
    fetchedAt: now,
    expiresAt: now + QUOTE_TTL_MS,
  };
}

// ---------- simulated swap (testnet) ----------

const SIM_KEY = "fairground:oneclick-sim:v1";
type SimPlan = { fail: boolean; credited: boolean };

function readPlans(): Record<string, SimPlan> {
  try {
    return JSON.parse(localStorage.getItem(SIM_KEY) ?? "{}") as Record<string, SimPlan>;
  } catch {
    return {};
  }
}
function writePlan(id: string, plan: SimPlan) {
  try {
    const all = readPlans();
    all[id] = plan;
    localStorage.setItem(SIM_KEY, JSON.stringify(all));
  } catch {}
}

const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function fakeDepositAddress(o: Origin): string {
  if (o.blockchain === "btc") {
    const b = new Uint8Array(38);
    crypto.getRandomValues(b);
    return "bc1q" + Array.from(b, (x) => B32[x % 32]).join("");
  }
  if (o.blockchain === "sol") return fakeTxHash();
  return "0x" + randomHex(20);
}

export const TERMINAL: OneClickStatus[] = ["SUCCESS", "REFUNDED", "FAILED"];
export const isTerminal = (s: OneClickStatus) => TERMINAL.includes(s);
/**
 * Nothing more will happen without the user: a terminal status, or a deposit
 * smaller than quoted (1Click waits for a top-up that a simulated swap never sends).
 */
export const isFinished = (s: OneClickStatus) => isTerminal(s) || s === "INCOMPLETE_DEPOSIT";

/** Status path of a simulated swap. */
export const SIM_PATH: Record<"ok" | "fail", OneClickStatus[]> = {
  ok: ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"],
  fail: ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "REFUNDED"],
};

/** Milliseconds spent in each status before the next one. */
const STEP_MS: Partial<Record<OneClickStatus, number>> = {
  PENDING_DEPOSIT: 1600,
  KNOWN_DEPOSIT_TX: 1800,
  PROCESSING: 2400,
};

/** Swaps this tab is advancing. Another tab may advance the same one. */
const running = new Set<string>();

/** Run `fn` while holding a lock shared by every tab, when the browser has Web Locks. */
async function withTabLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    let out!: T;
    await navigator.locks.request(name, async () => {
      out = await fn();
    });
    return out;
  }
  return fn();
}

/** The stored copy of a funding record, which another tab may have moved on. */
function latest(rec: FundingRecord): FundingRecord {
  return getFundings(rec.account).find((r) => r.id === rec.id) ?? rec;
}

function advance(rec: FundingRecord, plan: SimPlan, delayMs: number) {
  if (running.has(rec.id)) return;
  running.add(rec.id);
  const path = SIM_PATH[plan.fail ? "fail" : "ok"];
  const stop = () => running.delete(rec.id);
  const step = (cur: FundingRecord, wait: number) => {
    setTimeout(async () => {
      // Continue from whichever copy is further along, never step back.
      const stored = latest(cur);
      if (isFinished(stored.status)) return stop();
      const from = path.indexOf(stored.status) > path.indexOf(cur.status) ? stored : cur;
      const nextStatus = path[path.indexOf(from.status) + 1];
      if (!nextStatus) return stop();
      if (nextStatus === "SUCCESS") {
        try {
          // The recipient must be registered on USDC before anything is
          // delivered (a no-op on the simulated chain and for a registered
          // account).
          await ensureDeliverable(from.account);
          // Keyed on the funding id, so a second tab or a resume after a
          // reload never credits twice. Marked credited only once it landed.
          await withTabLock(`fairground:oneclick:${from.id}`, () =>
            getClient().faucet(from.account, from.amountOutUsdc, { key: `oneclick:${from.id}` }),
          );
          writePlan(from.id, { ...plan, credited: true });
        } catch {
          // Registration or the faucet failed: say so instead of claiming the USDC arrived.
          saveFunding({ ...from, status: "FAILED", updatedAt: Date.now() });
          return stop();
        }
      }
      const next: FundingRecord = { ...from, status: nextStatus, updatedAt: Date.now() };
      saveFunding(next);
      if (isFinished(nextStatus)) stop();
      else step(next, STEP_MS[nextStatus] ?? 1500);
    }, wait);
  };
  step(rec, delayMs);
}

/**
 * Start a simulated 1Click swap for testnet: same statuses as the real API,
 * then test USDC equal to the quoted amountOut is minted to `account`.
 * With `fail`, it ends in REFUNDED and nothing is credited.
 */
export function startSimulatedSwap(args: {
  account: string;
  saleId: string;
  origin: Origin;
  amountIn: string;
  amountOutUsdc: bigint;
  refundTo: string;
  fail: boolean;
}): FundingRecord {
  const now = Date.now();
  const rec: FundingRecord = {
    id: randomHex(8),
    account: args.account,
    saleId: args.saleId,
    originChain: args.origin.chain,
    originAsset: args.origin.symbol,
    amountIn: args.amountIn,
    amountOutUsdc: args.amountOutUsdc,
    depositAddress: fakeDepositAddress(args.origin),
    refundTo: args.refundTo.trim() || args.origin.sampleRefund,
    status: "PENDING_DEPOSIT",
    createdAt: now,
    updatedAt: now,
    simulated: true,
  };
  const plan: SimPlan = { fail: args.fail, credited: false };
  writePlan(rec.id, plan);
  saveFunding(rec);
  advance(rec, plan, STEP_MS.PENDING_DEPOSIT ?? 1500);
  return rec;
}

/** Continue simulated swaps that were mid-flight when the page was closed. */
export function resumeSimulatedSwaps(account: string) {
  const plans = readPlans();
  for (const rec of getFundings(account)) {
    if (!rec.simulated || isFinished(rec.status)) continue;
    const plan = plans[rec.id] ?? { fail: false, credited: false };
    advance(rec, plan, 900);
  }
}
