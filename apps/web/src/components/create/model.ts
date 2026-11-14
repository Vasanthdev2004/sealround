/**
 * Creator wizard model: the draft (raw strings from inputs), parsing into
 * bigint base units, field errors, live insights and the final SaleConfig.
 *
 * Pure functions only. Time is passed in (`now`), never read here, so the
 * page can prerender without touching the clock.
 *
 * Units: token amounts in token base units (18 dp), USDC and prices in USDC
 * base units (6 dp), prices per WHOLE token.
 */

import { parseUnits, poolPlan, type PoolPlan } from "@fairground/clearing";
import { MIN_DEPOSIT_FLOOR, invalidBidPenalty, tokenAccountOf } from "@/lib/client/rules";
import { priceStr, tokenFull, usdcStr } from "@/lib/format";
import { MAX_RAISE_SHARE_BPS, reserveForSellOut } from "@/lib/liquidity";
import { iconError, markIcon, markText, tickerMark } from "@/lib/token-icon";
import type { RevealMode, SaleConfig, SaleMeta } from "@/lib/types";
import type { IconUpload } from "./icon-image";

export const DECIMALS = 18;
export const ONE = 10n ** 18n;
const U128_MAX = (1n << 128n) - 1n;
const MINUTE = 60_000;
export const SETTLE_TIMEOUT_MS = 120 * MINUTE;
export const MAX_WINDOW_MINUTES = 30 * 24 * 60;
/**
 * Bid slots of a sale made with this form (the contract's `max_bids`, at most
 * 500). The creator prepays storage for each slot and gets the unused ones
 * back, so the form asks for a modest number and says so. 100 is also what
 * the NEAR client sends when a config names none.
 */
export const BID_SLOTS = 100;

/** Commit-reveal only: how long bidders have to reveal after the close (the contract takes 1 minute to 7 days). */
export type RevealWindowPreset = "1" | "10" | "60" | "1440";
export const REVEAL_WINDOW_PRESETS: { value: RevealWindowPreset; label: string; testnet?: boolean }[] = [
  { value: "1", label: "1m", testnet: true },
  { value: "10", label: "10m" },
  { value: "60", label: "1h" },
  { value: "1440", label: "24h" },
];
/** Creator share above this (basis points of total supply) gets a warning. */
export const CREATOR_WARN_BPS = 2_000n;
export const NAME_MAX = 32;
export const DESCRIPTION_MAX = 280;

/** Avatar hues. No purples. */
export const HUES = [214, 192, 168, 142, 48, 26, 6, 340] as const;

export type DurationPreset = "5" | "30" | "120" | "360" | "1440" | "custom";
export const DURATION_PRESETS: { value: DurationPreset; label: string; testnet?: boolean }[] = [
  { value: "5", label: "5m", testnet: true },
  { value: "30", label: "30m" },
  { value: "120", label: "2h" },
  { value: "360", label: "6h" },
  { value: "1440", label: "24h" },
  { value: "custom", label: "Custom" },
];

export type StartMode = "now" | "scheduled";

/** The token's icon: none (the monogram stands in), a generated mark, or an uploaded image. */
export type IconMode = "none" | "mark" | "upload";

/** Launch pool swap fee, basis points. */
export type PoolFeePreset = "5" | "30" | "100";
export const POOL_FEE_PRESETS: { value: PoolFeePreset; label: string }[] = [
  { value: "5", label: "0.05 %" },
  { value: "30", label: "0.3 %" },
  { value: "100", label: "1 %" },
];

/** Raw form state. Strings exactly as typed. */
export type Draft = {
  name: string;
  symbol: string;
  totalSupply: string;
  description: string;
  hue: number;
  iconMode: IconMode;
  /** The mark's text as typed: 1 to 3 letters or digits, or one emoji. Empty: the ticker's first two. */
  mark: string;
  /** The uploaded image, already cropped and shrunk to fit (icon-image.ts). */
  iconUpload: IconUpload | null;
  saleSupply: string;
  creatorAllocation: string;
  floor: string;
  ceilingOn: boolean;
  ceiling: string;
  minRaise: string;
  startMode: StartMode;
  /** datetime-local value, local time: "2026-11-09T18:30". */
  startAt: string;
  duration: DurationPreset;
  customMinutes: string;
  minDeposit: string;
  maxDeposit: string;
  revealMode: RevealMode;
  /** Minutes. Used only when `revealMode` is commit-reveal. */
  revealWindow: RevealWindowPreset;
  /** Seed a launch pool at settlement. The rest of the supply (Allocation) is its reserve. */
  poolOn: boolean;
  /** Share of the raise for the pool, percent as typed: "20". */
  poolShare: string;
  poolFee: PoolFeePreset;
};

/** The spec demo values. Name and symbol stay empty: FAIRT is already taken. */
export const DEFAULT_DRAFT: Draft = {
  name: "",
  symbol: "",
  totalSupply: "1,000,000",
  description: "",
  hue: 168,
  iconMode: "mark",
  mark: "",
  iconUpload: null,
  saleSupply: "600,000",
  creatorAllocation: "100,000",
  floor: "0.001",
  ceilingOn: false,
  ceiling: "0.01",
  minRaise: "50",
  startMode: "now",
  startAt: "",
  duration: "30",
  customMinutes: "45",
  minDeposit: "1",
  maxDeposit: "10",
  revealMode: "tee",
  revealWindow: "10",
  poolOn: false,
  poolShare: "20",
  poolFee: "30",
};

export type FieldKey =
  | "name"
  | "symbol"
  | "totalSupply"
  | "icon"
  | "description"
  | "saleSupply"
  | "creatorAllocation"
  | "floor"
  | "ceiling"
  | "minRaise"
  | "startAt"
  | "customMinutes"
  | "minDeposit"
  | "maxDeposit"
  | "poolShare"
  | "poolTokens";

export type SectionId = "token" | "allocation" | "price" | "window" | "limits" | "mode" | "pool";

/** Form order, used to scroll to the first error. */
export const FIELD_ORDER: FieldKey[] = [
  "name",
  "symbol",
  "totalSupply",
  "icon",
  "description",
  "saleSupply",
  "creatorAllocation",
  "floor",
  "ceiling",
  "minRaise",
  "startAt",
  "customMinutes",
  "minDeposit",
  "maxDeposit",
  "poolShare",
  "poolTokens",
];

export const SECTION_OF: Record<FieldKey, SectionId> = {
  name: "token",
  symbol: "token",
  totalSupply: "token",
  icon: "token",
  description: "token",
  saleSupply: "allocation",
  creatorAllocation: "allocation",
  floor: "price",
  ceiling: "price",
  minRaise: "price",
  startAt: "window",
  customMinutes: "window",
  minDeposit: "limits",
  maxDeposit: "limits",
  poolShare: "pool",
  // The reserve is the rest of the supply: shown and fixed in the pool section, set through Allocation.
  poolTokens: "pool",
};

export const sectionDomId = (s: SectionId) => `create-${s}`;

/** Every value parsed and consistent: enough to build a SaleConfig. */
export type Ready = {
  total: bigint;
  sale: bigint;
  creator: bigint;
  lp: bigint;
  floor: bigint;
  /** null = no ceiling. */
  ceiling: bigint | null;
  minRaise: bigint;
  minDeposit: bigint;
  maxDeposit: bigint;
  /** null = opens at creation. */
  startAt: number | null;
  durationMs: number;
  /** The launch pool's terms; null = no pool. `tokens` is `lp`. */
  pool: { shareBps: number; feeBps: number; tokens: bigint } | null;
};

/** The launch pool as the form stands. */
export type PoolInsight = {
  /** Share of the raise, basis points; null until it parses. */
  shareBps: number | null;
  feeBps: number;
  /** Tokens reserved: the rest of the supply. */
  reserve: bigint | null;
  /** The reserve a sell-out needs: the share of the sale supply. */
  sellOut: bigint | null;
  /** The pool at a sell-out at the floor, with this reserve. */
  atFloor: PoolPlan | null;
};

/** Whatever parsed so far. `ceiling: undefined` means invalid, `null` means off. */
export type Values = Partial<Omit<Ready, "pool">>;

/** `live` errors show while typing; the rest wait for blur or a review attempt. */
export type FieldError = { msg: string; live?: boolean };

export type Notice = {
  id: string;
  tone: "warn" | "bad" | "neutral";
  section: SectionId;
  text: string;
};

export type Insights = {
  /** Raise if every token sells at the floor. USDC base units. */
  raiseAtFloor: bigint | null;
  /** saleSupply × max price, when a ceiling is set. */
  maxRaise: bigint | null;
  /** Fewest bidders (each at the cap) whose spend can reach the min raise. */
  biddersToSucceed: bigint | null;
  /** Fewest bidders (each at the cap) to buy every token at the floor. */
  biddersToSellOut: bigint | null;
  /** Most tokens one account can buy at the floor. Token base units. */
  perAccountTokens: bigint | null;
  /** That, as basis points of the sale supply. */
  perAccountBps: bigint | null;
  /** Min raise above the most the sale can ever raise. */
  impossible: boolean;
  /** Min raise above a sell-out at the floor: the price must clear higher. */
  needsAboveFloor: boolean;
  /**
   * What filling every bid slot with junk bids costs an attacker: the 1 %
   * penalty on each (lost for good) and the deposits tied up until the sale
   * ends. USDC base units. Grows with the minimum deposit: that is the
   * creator's lever against it.
   */
  slotBlockLost: bigint | null;
  slotBlockHeld: bigint | null;
};

/** Basis points of total supply. */
export type Shares = { sale: bigint; creator: bigint; lp: bigint };

export type Derived = {
  values: Values;
  errors: Partial<Record<FieldKey, FieldError>>;
  notices: Notice[];
  insights: Insights;
  shares: Shares | null;
  ready: Ready | null;
  /** The contract takes launch liquidity: the pool section shows. */
  poolAvailable: boolean;
  /** The launch pool, when available and switched on. */
  pool: PoolInsight | null;
  /** The creator gets the whole rest of the supply (the contract, no launch pool): the creator field is not used. */
  restToCreator: boolean;
};

// ---------- parsing ----------

type Parsed<T> = { v: T; e?: undefined } | { v?: undefined; e: string };

const clean = (s: string) => s.replace(/[,_\s]/g, "");

function wholeTokens(raw: string, zeroMsg: string | null): Parsed<bigint> {
  const s = clean(raw);
  if (!s) return { e: "Required." };
  if (/^\d*\.\d*$/.test(s)) return { e: "Whole tokens only, no decimals." };
  if (!/^\d+$/.test(s)) return { e: "Enter a whole number." };
  const v = BigInt(s) * ONE;
  if (v > U128_MAX) return { e: "Too large for the token contract." };
  if (v === 0n && zeroMsg) return { e: zeroMsg };
  return { v };
}

function usdcAmount(raw: string, zeroMsg: string | null): Parsed<bigint> {
  const s = clean(raw);
  if (!s) return { e: "Required." };
  if (!/^\d*\.?\d*$/.test(s) || s === ".") return { e: "Enter a number, like 0.001." };
  if ((s.split(".")[1] ?? "").length > 6) return { e: "USDC has at most 6 decimal places." };
  const v = parseUnits(s, 6);
  if (v > U128_MAX) return { e: "That number is too large." };
  if (v === 0n && zeroMsg) return { e: zeroMsg };
  return { v };
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const maxB = (a: bigint, b: bigint) => (a > b ? a : b);
const minB = (a: bigint, b: bigint) => (a < b ? a : b);

// ---------- derive ----------

/** "20" or "12.5" percent as basis points, 1 to 5000; null when it is not that. */
function shareBps(raw: string): number | null {
  const s = raw.trim().replace(/\s*%$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const bps = Math.round(Number(s) * 100);
  return bps >= 1 && bps <= MAX_RAISE_SHARE_BPS ? bps : null;
}

/** What `derive` needs to know about the chain the sale is created on. */
export type DeriveOpts = {
  /** The contract takes launch liquidity, so `poolOn` counts. */
  pool?: boolean;
  /**
   * The sale is created on the NEAR contract, which keeps no reserve apart
   * from a launch pool: every token not for sale and not in the pool goes to
   * the creator (sale.rs, `creator_allocation`). The simulated chain keeps an
   * LP reserve, so mock mode leaves this off.
   */
  restToCreator?: boolean;
};

/** True when the creator gets the whole rest of the supply: the contract, and no launch pool switched on. */
export function restGoesToCreator(d: Pick<Draft, "poolOn">, opts: DeriveOpts): boolean {
  return !!opts.restToCreator && !(opts.pool && d.poolOn);
}

/**
 * Parse and check the whole draft. `taken` holds symbols that already have a
 * token account. `now` is null until the first edit, so time checks wait.
 */
export function derive(d: Draft, taken: ReadonlySet<string>, now: number | null, opts: DeriveOpts = {}): Derived {
  const errors: Derived["errors"] = {};
  const v: Values = {};
  const notices: Notice[] = [];
  const err = (k: FieldKey, msg: string, live = false) => {
    if (!errors[k]) errors[k] = { msg, live };
  };

  // 1. Token
  const name = d.name.trim();
  if (!name) err("name", "Give the token a name.");
  else if (name.length > NAME_MAX) err("name", `Keep it to ${NAME_MAX} characters.`, true);

  if (!d.symbol) err("symbol", "Pick a symbol.");
  else if (!/^[A-Z0-9]{2,8}$/.test(d.symbol)) err("symbol", "2 to 8 capital letters or digits.");
  else if (taken.has(d.symbol)) err("symbol", `${d.symbol} is taken: its token account already exists.`, true);

  if (d.description.length > DESCRIPTION_MAX) {
    err("description", `Keep it to ${DESCRIPTION_MAX} characters.`, true);
  }

  if (d.iconMode === "mark" && d.mark.trim() && markText(d.mark) === null) {
    err("icon", "1 to 3 letters or digits, or one emoji.", true);
  } else if (d.iconMode === "upload" && !d.iconUpload) {
    err("icon", "Choose an image, or pick another option.");
  } else {
    const problem = iconError(draftIcon(d));
    if (problem) err("icon", problem, true);
  }

  const total = wholeTokens(d.totalSupply, "Total supply must be above zero.");
  if (total.e !== undefined) err("totalSupply", total.e);
  else v.total = total.v;

  // 2. Allocation
  const sale = wholeTokens(d.saleSupply, "Sale supply must be above zero.");
  if (sale.e !== undefined) err("saleSupply", sale.e);
  else v.sale = sale.v;

  // On the contract without a launch pool, the creator's share is simply the
  // rest of the supply (sale.rs: total - sale - pool reserve); the creator
  // field is not read then.
  const restToCreator = restGoesToCreator(d, opts);
  if (!restToCreator) {
    const creator = wholeTokens(d.creatorAllocation, null);
    if (creator.e !== undefined) err("creatorAllocation", creator.e);
    else v.creator = creator.v;
  }

  let shares: Shares | null = null;
  if (v.total !== undefined && v.sale !== undefined) {
    if (v.sale > v.total) {
      err("saleSupply", "More than the total supply.", true);
    } else if (restToCreator) {
      v.creator = v.total - v.sale;
      v.lp = 0n;
      if (v.total > 0n) {
        const s = (v.sale * 10_000n) / v.total;
        shares = { sale: s, creator: 10_000n - s, lp: 0n };
      }
    } else if (v.creator !== undefined) {
      if (v.sale + v.creator > v.total) {
        err("creatorAllocation", "Sale supply plus this is more than the total supply.", true);
      } else {
        v.lp = v.total - v.sale - v.creator;
        if (v.total > 0n) {
          const s = (v.sale * 10_000n) / v.total;
          const c = (v.creator * 10_000n) / v.total;
          shares = { sale: s, creator: c, lp: 10_000n - s - c };
        }
      }
    }
  }
  if (shares && shares.creator > CREATOR_WARN_BPS) {
    notices.push({
      id: "creator-share",
      tone: "warn",
      section: "allocation",
      text: `You keep ${pctStr(shares.creator)} of the supply. Buyers will see this before they bid.`,
    });
  }

  // 3. Price
  const floor = usdcAmount(d.floor, "Floor price must be above zero.");
  if (floor.e !== undefined) err("floor", floor.e);
  else v.floor = floor.v;

  if (d.ceilingOn) {
    const c = usdcAmount(d.ceiling, "Max price must be above zero.");
    if (c.e !== undefined) err("ceiling", c.e);
    else if (v.floor !== undefined && c.v < v.floor) {
      err("ceiling", `Must be at least the floor (${priceStr(v.floor)} USDC).`, true);
    } else v.ceiling = c.v;
  } else {
    v.ceiling = null;
  }

  const minRaise = usdcAmount(d.minRaise, null);
  if (minRaise.e !== undefined) err("minRaise", minRaise.e);
  else v.minRaise = minRaise.v;

  // 4. Bid window
  if (d.startMode === "now") {
    v.startAt = null;
  } else if (!d.startAt) {
    err("startAt", "Pick a date and time.");
  } else {
    const t = new Date(d.startAt).getTime();
    if (Number.isNaN(t)) err("startAt", "Pick a valid date and time.");
    else if (now !== null && t < now - MINUTE) err("startAt", "That time has passed. Pick a future time.", true);
    else v.startAt = t;
  }

  if (d.duration === "custom") {
    const s = d.customMinutes.trim();
    if (!/^\d+$/.test(s)) err("customMinutes", "Whole minutes, like 45.");
    else {
      const m = Number(s);
      if (m < 1 || m > MAX_WINDOW_MINUTES) err("customMinutes", "Between 1 minute and 30 days.", true);
      else v.durationMs = m * MINUTE;
    }
  } else {
    v.durationMs = Number(d.duration) * MINUTE;
  }
  if (d.duration === "5") {
    notices.push({
      id: "short-window",
      tone: "neutral",
      section: "window",
      text: "A 5-minute window is for testnet demos. Real buyers need longer.",
    });
  }

  // 5. Limits
  const minDep = usdcAmount(d.minDeposit, "Minimum deposit must be above zero.");
  if (minDep.e !== undefined) err("minDeposit", minDep.e);
  else if (minDep.v < MIN_DEPOSIT_FLOOR) {
    // The contract's floor (sale.rs MIN_DEPOSIT_FLOOR): below it a junk bid would cost next to nothing.
    err("minDeposit", `At least ${usdcStr(MIN_DEPOSIT_FLOOR)} USDC. The contract refuses a lower minimum.`, true);
  } else v.minDeposit = minDep.v;

  const maxDep = usdcAmount(d.maxDeposit, "The cap must be above zero.");
  if (maxDep.e !== undefined) err("maxDeposit", maxDep.e);
  else v.maxDeposit = maxDep.v;

  if (v.minDeposit !== undefined && v.maxDeposit !== undefined && v.minDeposit > v.maxDeposit) {
    err("minDeposit", `Above the per-account cap (${usdcStr(v.maxDeposit)} USDC).`, true);
  }

  // Insights
  const raiseAtFloor = v.sale !== undefined && v.floor !== undefined ? (v.sale * v.floor) / ONE : null;
  const maxRaise = v.sale !== undefined && v.ceiling ? (v.sale * v.ceiling) / ONE : null;
  const impossible = maxRaise !== null && v.minRaise !== undefined && v.minRaise > maxRaise;
  if (impossible) {
    err("minRaise", `Above the most this sale can raise (${usdcStr(maxRaise)} USDC). It could never succeed.`, true);
  }
  const needsAboveFloor =
    !impossible && raiseAtFloor !== null && v.minRaise !== undefined && v.minRaise > raiseAtFloor;
  if (needsAboveFloor && raiseAtFloor !== null && v.minRaise !== undefined) {
    notices.push({
      id: "above-floor",
      tone: "warn",
      section: "price",
      text: `Selling out at the floor raises ${usdcStr(raiseAtFloor)} USDC, less than your ${usdcStr(v.minRaise)} USDC minimum. The price has to clear above the floor for this sale to succeed.`,
    });
  }
  if (v.minRaise === 0n) {
    notices.push({
      id: "no-min-raise",
      tone: "neutral",
      section: "price",
      text: "No minimum raise. Any valid bid settles the sale.",
    });
  }

  const cap = v.maxDeposit && v.maxDeposit > 0n ? v.maxDeposit : null;
  const biddersToSucceed = cap && v.minRaise !== undefined ? maxB(1n, ceilDiv(v.minRaise, cap)) : null;
  const biddersToSellOut = cap && raiseAtFloor !== null ? maxB(1n, ceilDiv(raiseAtFloor, cap)) : null;
  const perAccountTokens =
    v.maxDeposit !== undefined && v.floor && v.floor > 0n ? (v.maxDeposit * ONE) / v.floor : null;
  const perAccountBps =
    perAccountTokens !== null && v.sale && v.sale > 0n
      ? minB(10_000n, (perAccountTokens * 10_000n) / v.sale)
      : null;
  if (perAccountBps !== null && perAccountBps >= 5_000n) {
    notices.push({
      id: "whale",
      tone: "warn",
      section: "limits",
      text: `One account at the cap could buy ${pctStr(perAccountBps)} of the sale at the floor. Consider a lower cap.`,
    });
  }

  if (d.revealMode === "commit_reveal") {
    notices.push({
      id: "commit-reveal",
      tone: "warn",
      section: "mode",
      text: "Commit-reveal is weaker: max prices become public when bidders reveal, and a bidder who misses the reveal window loses 1 % of their deposit.",
    });
  }

  // 7. Launch pool: the rest of the supply is its reserve.
  const poolAvailable = !!opts.pool;
  let pool: PoolInsight | null = null;
  if (poolAvailable && d.poolOn) {
    const bps = shareBps(d.poolShare);
    if (bps === null) err("poolShare", "Between 0.01 % and 50 % of the raise.", true);
    const reserve = v.lp ?? null;
    if (reserve === 0n) {
      err("poolTokens", "Nothing is left for the pool. Lower the creator allocation or the supply for sale.", true);
    }
    const sellOut =
      bps !== null && v.sale !== undefined && v.floor ? reserveForSellOut(v.sale, v.floor, DECIMALS, bps) : null;
    const atFloor =
      bps !== null && reserve !== null && v.sale !== undefined && v.floor
        ? poolPlan(ceilDiv(v.sale * v.floor, ONE), v.floor, DECIMALS, bps, reserve)
        : null;
    pool = { shareBps: bps, feeBps: Number(d.poolFee), reserve, sellOut, atFloor };
    if (reserve !== null && reserve > 0n && sellOut !== null && sellOut > 0n) {
      if (reserve < sellOut) {
        notices.push({
          id: "pool-short",
          tone: "neutral",
          section: "pool",
          text: `A sell-out fills a reserve of ${tokenFull(sellOut)} tokens. With less, the pool takes fewer tokens and less USDC, still at the clearing price.`,
        });
      } else if (reserve > sellOut) {
        notices.push({
          id: "pool-burn",
          tone: "neutral",
          section: "pool",
          text: `The pool takes at most ${tokenFull(sellOut)} tokens. The other ${tokenFull(reserve - sellOut)} are burned at payout.`,
        });
      }
    }
  }

  const slots = BigInt(BID_SLOTS);
  const insights: Insights = {
    raiseAtFloor,
    maxRaise,
    biddersToSucceed,
    biddersToSellOut,
    perAccountTokens,
    perAccountBps,
    impossible,
    needsAboveFloor,
    slotBlockLost: v.minDeposit !== undefined ? slots * invalidBidPenalty(v.minDeposit) : null,
    slotBlockHeld: v.minDeposit !== undefined ? slots * v.minDeposit : null,
  };

  const complete =
    v.total !== undefined &&
    v.sale !== undefined &&
    v.creator !== undefined &&
    v.lp !== undefined &&
    v.floor !== undefined &&
    v.ceiling !== undefined &&
    v.minRaise !== undefined &&
    v.minDeposit !== undefined &&
    v.maxDeposit !== undefined &&
    v.startAt !== undefined &&
    v.durationMs !== undefined;

  const ready: Ready | null =
    complete && Object.keys(errors).length === 0
      ? {
          total: v.total!,
          sale: v.sale!,
          creator: v.creator!,
          lp: v.lp!,
          floor: v.floor!,
          ceiling: v.ceiling!,
          minRaise: v.minRaise!,
          minDeposit: v.minDeposit!,
          maxDeposit: v.maxDeposit!,
          startAt: v.startAt!,
          durationMs: v.durationMs!,
          pool: pool && pool.shareBps !== null ? { shareBps: pool.shareBps, feeBps: pool.feeBps, tokens: v.lp! } : null,
        }
      : null;

  return { values: v, errors, notices, insights, shares, ready, poolAvailable, pool, restToCreator };
}

/**
 * The exact config sent to create_sale. `now` is used when the sale opens at
 * creation. `quoteToken` is the client's USDC contract (`getClient().usdcContract`):
 * the only deposit token the sale takes. `dex` is the client's launch pool
 * exchange (`getLiquidityDex()`); without it the sale has no pool.
 */
export function buildConfig(d: Draft, r: Ready, now: number, quoteToken: string, dex: string | null = null): SaleConfig {
  const bidStart = r.startAt ?? now;
  return {
    tokenName: d.name.trim(),
    tokenSymbol: d.symbol,
    decimals: DECIMALS,
    totalSupply: r.total,
    saleSupply: r.sale,
    creatorAllocation: r.creator,
    lpReserve: r.total - r.sale - r.creator,
    floorPrice: r.floor,
    maxPrice: r.ceiling,
    minRaise: r.minRaise,
    bidStart,
    bidEnd: bidStart + r.durationMs,
    minDeposit: r.minDeposit,
    maxDepositPerAccount: r.maxDeposit,
    revealMode: d.revealMode,
    unsoldRule: "burn",
    settleTimeoutMs: SETTLE_TIMEOUT_MS,
    quoteToken,
    maxBids: BID_SLOTS,
    // The contract refuses a reveal window on a TEE sale.
    ...(d.revealMode === "commit_reveal" ? { revealWindowMs: Number(d.revealWindow) * MINUTE } : {}),
    ...(r.pool && dex
      ? { liquidity: { dex, raiseShareBps: r.pool.shareBps, poolTokens: r.pool.tokens, feeBps: r.pool.feeBps } }
      : {}),
  };
}

/**
 * The icon the sale will carry, as create_sale gets it: a generated mark (the
 * typed text, else the ticker's first two characters, on the chosen colour),
 * the uploaded image, or null.
 */
export function draftIcon(d: Draft): string | null {
  if (d.iconMode === "upload") return d.iconUpload?.dataUrl ?? null;
  if (d.iconMode === "mark") return markIcon(d.mark.trim() || tickerMark(d.symbol), d.hue);
  return null;
}

export function buildMeta(d: Draft): SaleMeta {
  const icon = draftIcon(d);
  return { description: d.description.trim(), hue: d.hue, ...(icon ? { icon } : {}) };
}

// ---------- display helpers ----------

/** "60%", "12.5%", "<0.1%" from basis points. */
export function pctStr(bps: bigint): string {
  const n = Number(bps) / 100;
  if (n > 0 && n < 0.1) return "<0.1%";
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

/** "30 minutes", "2 hours", "1h 30m", "3 days". */
export function windowLabel(ms: number): string {
  const m = Math.round(ms / MINUTE);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  if (m % 1440 === 0 && m > 1440) return `${m / 1440} days`;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Re-group a whole number with commas on blur. Leaves anything else alone. */
export function groupDigits(raw: string): string {
  const s = clean(raw);
  if (!/^\d+$/.test(s)) return raw;
  return BigInt(s).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** ms -> datetime-local value in local time. */
export function toLocalInput(ms: number): string {
  const t = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}`;
}

/** Next round 5 minutes, one hour from `now`. */
export function suggestedStart(now: number): string {
  const step = 5 * MINUTE;
  return toLocalInput(Math.ceil((now + 60 * MINUTE) / step) * step);
}

/**
 * The token account the contract deploys to: `<sale_id>.<contract>`. A sale
 * made with this form takes its id from the symbol, in lower case.
 * `contractId` is the client's (`getClient().contractId`).
 */
export const tokenAccountFor = (symbol: string, contractId: string) =>
  tokenAccountOf((symbol || "symbol").toLowerCase(), contractId);

export const REVEAL_LABEL: Record<RevealMode, string> = {
  tee: "Sealed in TEE",
  commit_reveal: "Commit-reveal",
};
