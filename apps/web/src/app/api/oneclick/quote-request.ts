import {
  ONECLICK_BASE,
  UPSTREAM_TIMEOUT_MS,
  badRequest,
  passThrough,
  realSwapsOff,
  realSwapsOn,
  unreachable,
  upstreamHeaders,
} from "./upstream";
import {
  NEAR_USDC_ASSET,
  REAL_DEADLINE_MAX_MS,
  REAL_DEADLINE_MIN_MS,
  REAL_MAX_SLIPPAGE_BPS,
  REAL_ORIGIN_ASSETS,
  checkRealQuote,
  isAddressOf,
  isRealRecipient,
} from "./shared";

/**
 * Shared validation and proxying for 1Click dry and deposit quotes. The route
 * selects the quote type. Deposit quotes also require the server switch and
 * have stricter checks on amounts, assets and addresses.
 */

const SWAP_TYPES = ["EXACT_INPUT", "EXACT_OUTPUT", "FLEX_INPUT"] as const;
const DEPOSIT_TYPES = ["ORIGIN_CHAIN", "INTENTS"] as const;
const REFUND_TYPES = ["ORIGIN_CHAIN", "INTENTS"] as const;
const RECIPIENT_TYPES = ["DESTINATION_CHAIN", "INTENTS"] as const;

type QuoteBody = {
  dry: boolean;
  swapType: (typeof SWAP_TYPES)[number];
  slippageTolerance: number;
  originAsset: string;
  depositType: (typeof DEPOSIT_TYPES)[number];
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: (typeof REFUND_TYPES)[number];
  recipient: string;
  recipientType: (typeof RECIPIENT_TYPES)[number];
  deadline: string;
  quoteWaitingTimeMs?: number;
};

const ASSET = /^nep(141|245):[A-Za-z0-9._:-]{1,160}$/;
const ADDRESS = /^[A-Za-z0-9._:-]{2,128}$/;

function pick<T extends readonly string[]>(v: unknown, allowed: T, fallback: T[number]): T[number] | null {
  if (v === undefined) return fallback;
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T[number]) : null;
}

/** The checks every quote passes, dry or real. */
function sanitize(b: Record<string, unknown>, dry: boolean): QuoteBody | string {
  const swapType = pick(b.swapType, SWAP_TYPES, "EXACT_INPUT");
  if (!swapType) return "swapType is not supported.";
  const depositType = pick(b.depositType, DEPOSIT_TYPES, "ORIGIN_CHAIN");
  if (!depositType) return "depositType is not supported.";
  const refundType = pick(b.refundType, REFUND_TYPES, "ORIGIN_CHAIN");
  if (!refundType) return "refundType is not supported.";
  const recipientType = pick(b.recipientType, RECIPIENT_TYPES, "DESTINATION_CHAIN");
  if (!recipientType) return "recipientType is not supported.";

  const slippage = b.slippageTolerance ?? 100;
  if (typeof slippage !== "number" || !Number.isInteger(slippage) || slippage < 0 || slippage > 5000) {
    return "slippageTolerance must be whole basis points between 0 and 5000.";
  }
  if (typeof b.originAsset !== "string" || !ASSET.test(b.originAsset)) return "originAsset is not a valid asset id.";
  if (typeof b.destinationAsset !== "string" || !ASSET.test(b.destinationAsset)) {
    return "destinationAsset is not a valid asset id.";
  }
  if (typeof b.amount !== "string" || !/^[1-9]\d{0,39}$/.test(b.amount)) {
    return "amount must be a positive integer string in base units.";
  }
  if (typeof b.refundTo !== "string" || !ADDRESS.test(b.refundTo)) return "refundTo is not valid.";
  if (typeof b.recipient !== "string" || !ADDRESS.test(b.recipient)) return "recipient is not valid.";

  const deadline = typeof b.deadline === "string" ? Date.parse(b.deadline) : NaN;
  if (!Number.isFinite(deadline)) return "deadline must be an ISO date.";

  const body: QuoteBody = {
    dry,
    swapType,
    slippageTolerance: slippage,
    originAsset: b.originAsset,
    depositType,
    destinationAsset: b.destinationAsset,
    amount: b.amount,
    refundTo: b.refundTo,
    refundType,
    recipient: b.recipient,
    recipientType,
    deadline: new Date(deadline).toISOString(),
  };
  if (typeof b.quoteWaitingTimeMs === "number" && b.quoteWaitingTimeMs >= 0 && b.quoteWaitingTimeMs <= 5000) {
    body.quoteWaitingTimeMs = Math.round(b.quoteWaitingTimeMs);
  }
  return body;
}

/** The extra checks a real quote passes: every field that decides where money goes. */
function checkReal(b: Record<string, unknown>, body: QuoteBody, now: number): string | null {
  // Explicit, never defaulted: these decide where the money goes.
  if (b.recipientType !== "DESTINATION_CHAIN") return "A real quote must deliver to a NEAR account (recipientType DESTINATION_CHAIN).";
  if (b.refundType !== "ORIGIN_CHAIN") return "A real quote must refund on the origin chain (refundType ORIGIN_CHAIN).";
  if (body.swapType !== "EXACT_INPUT") return "A real quote must be EXACT_INPUT.";
  if (body.depositType !== "ORIGIN_CHAIN") return "A real quote must take its deposit on the origin chain.";
  if (body.destinationAsset !== NEAR_USDC_ASSET) return "A real quote must deliver USDC on NEAR.";
  const kind = REAL_ORIGIN_ASSETS[body.originAsset];
  if (!kind) return "originAsset is not one this app supports for real swaps.";
  if (!isRealRecipient(body.recipient)) return "recipient must be a NEAR mainnet account id.";
  if (!body.refundTo || !isAddressOf(kind, body.refundTo)) return "refundTo must be an address on the origin chain.";
  if (body.slippageTolerance > REAL_MAX_SLIPPAGE_BPS) {
    return `slippageTolerance must be at most ${REAL_MAX_SLIPPAGE_BPS} basis points for a real quote.`;
  }
  const ahead = Date.parse(body.deadline) - now;
  if (ahead < REAL_DEADLINE_MIN_MS || ahead > REAL_DEADLINE_MAX_MS) {
    return "deadline must be between 5 minutes and 3 hours from now for a real quote.";
  }
  return null;
}

export async function requestQuote(request: Request, real: boolean) {
  if (real && !realSwapsOn()) return realSwapsOff();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest("Body must be JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return badRequest("Body must be a JSON object.");
  const b = raw as Record<string, unknown>;

  const body = sanitize(b, !real);
  if (typeof body === "string") return badRequest(body);
  if (real) {
    const problem = checkReal(b, body, Date.now());
    if (problem) return badRequest(problem);
  }

  try {
    const res = await fetch(`${ONECLICK_BASE}/v0/quote`, {
      method: "POST",
      headers: upstreamHeaders(true),
      body: JSON.stringify(real ? { ...body, depositMode: "SIMPLE" } : body),
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!real || !res.ok) return await passThrough(res);

    const data: unknown = await res.clone().json().catch(() => null);
    const problem = checkRealQuote(body, data);
    if (problem) {
      return Response.json({ message: problem, code: "quote_mismatch" }, { status: 502, headers: { "cache-control": "no-store" } });
    }
    return await passThrough(res);
  } catch {
    return unreachable();
  }
}
