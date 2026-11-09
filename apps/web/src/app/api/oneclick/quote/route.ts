import { ONECLICK_BASE, UPSTREAM_TIMEOUT_MS, passThrough, unreachable, upstreamHeaders } from "../upstream";

/**
 * POST /api/oneclick/quote -> 1Click POST /v0/quote, always with dry: true.
 * A dry quote never creates a deposit address, so this proxy cannot start a
 * real swap. Only known fields are forwarded.
 */

const SWAP_TYPES = ["EXACT_INPUT", "EXACT_OUTPUT", "FLEX_INPUT"] as const;
const DEPOSIT_TYPES = ["ORIGIN_CHAIN", "INTENTS"] as const;
const REFUND_TYPES = ["ORIGIN_CHAIN", "INTENTS"] as const;
const RECIPIENT_TYPES = ["DESTINATION_CHAIN", "INTENTS"] as const;

type DryQuoteBody = {
  dry: true;
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

function sanitize(raw: unknown): DryQuoteBody | string {
  if (!raw || typeof raw !== "object") return "Body must be a JSON object.";
  const b = raw as Record<string, unknown>;

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

  const body: DryQuoteBody = {
    dry: true,
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

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ message: "Body must be JSON." }, { status: 400 });
  }
  const body = sanitize(raw);
  if (typeof body === "string") return Response.json({ message: body }, { status: 400 });

  try {
    const res = await fetch(`${ONECLICK_BASE}/v0/quote`, {
      method: "POST",
      headers: upstreamHeaders(true),
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return passThrough(res);
  } catch {
    return unreachable();
  }
}
