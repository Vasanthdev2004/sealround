import { sameReceiptAddress, type verifyReceipt } from "./receipt";
import { ONECLICK_STATUSES } from "./shared";

function explorerUrl(list: unknown): string | undefined {
  const value = Array.isArray(list) ? (list[0] as { explorerUrl?: unknown } | undefined)?.explorerUrl : undefined;
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

type Receipt = NonNullable<ReturnType<typeof verifyReceipt>>;

type ProviderStatus = {
  status?: unknown;
  updatedAt?: unknown;
  quoteResponse?: { quote?: { depositAddress?: unknown }; quoteRequest?: { recipient?: unknown } };
  swapDetails?: {
    originChainTxHashes?: unknown;
    destinationChainTxHashes?: unknown;
    amountOut?: unknown;
    refundReason?: unknown;
    refundedAmountFormatted?: unknown;
  };
};

function providerStatus(data: unknown): ProviderStatus | null {
  return data && typeof data === "object" ? data as ProviderStatus : null;
}

/** Submit acknowledgements may omit the quote. Reject conflicting data when it is present. */
export function trackingMismatch(data: unknown, receipt: Receipt): boolean {
  const d = providerStatus(data);
  const address = d?.quoteResponse?.quote?.depositAddress;
  const recipient = d?.quoteResponse?.quoteRequest?.recipient;
  return (address !== undefined && !sameReceiptAddress(receipt, address)) ||
    (recipient !== undefined && recipient !== receipt.recipient);
}

/** Verify the upstream response belongs to the receipt and drop the private quote and extra transaction data. */
export function trackStatus(data: unknown, receipt: Receipt) {
  const d = providerStatus(data);
  if (!d) return null;
  const status = ONECLICK_STATUSES.find((value) => value === d.status);
  if (!status || !sameReceiptAddress(receipt, d.quoteResponse?.quote?.depositAddress) ||
    d.quoteResponse?.quoteRequest?.recipient !== receipt.recipient) return null;
  const updatedAt = typeof d.updatedAt === "string" ? Date.parse(d.updatedAt) : NaN;
  if (!Number.isFinite(updatedAt)) return null;

  const details = d.swapDetails ?? {};
  const { amountOut, refundReason, refundedAmountFormatted } = details;
  return {
    status,
    updatedAt,
    originTxUrl: explorerUrl(details.originChainTxHashes),
    deliveryTxUrl: explorerUrl(details.destinationChainTxHashes),
    amountOut: typeof amountOut === "string" && /^[1-9]\d{0,39}$/.test(amountOut) ? amountOut : undefined,
    refundReason: typeof refundReason === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(refundReason) ? refundReason : undefined,
    refundedAmount: typeof refundedAmountFormatted === "string" && /^\d{1,40}(\.\d{1,24})?$/.test(refundedAmountFormatted)
      ? refundedAmountFormatted
      : undefined,
  };
}

export function trackingError(status: number) {
  return Response.json({ message: "1Click could not confirm this deposit status." }, {
    status: status >= 400 && status < 500 ? status : 502,
    headers: { "cache-control": "no-store" },
  });
}
