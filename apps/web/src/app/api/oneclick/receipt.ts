import { createHmac, timingSafeEqual } from "node:crypto";
import { isAddressOf, isRealRecipient, type AddressKind } from "./shared";

const TRACKING_TTL_MS = 30 * 24 * 60 * 60_000;
const TOKEN = /^([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})$/;

type Deposit = { address: string; recipient: string; kind: AddressKind };
type Receipt = Deposit & { expiresAt: number };

function secret(): Buffer | null {
  const value = process.env.ONECLICK_RECEIPT_SECRET?.trim();
  return value && /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : null;
}

export const receiptSigningConfigured = () => secret() !== null;

function sign(key: Buffer, payload: string): Buffer {
  return createHmac("sha256", key).update(`sealround:oneclick:receipt:v1:${payload}`).digest();
}

/** The browser keeps the bearer token with the private funding receipt. */
export function issueReceipt(deposit: Deposit, now = Date.now()) {
  const key = secret();
  if (!key) throw new Error("1Click receipt signing is unavailable.");
  const expiresAt = now + TRACKING_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ ...deposit, expiresAt })).toString("base64url");
  return { token: `${payload}.${sign(key, payload).toString("base64url")}`, expiresAt };
}

export function sameReceiptAddress(receipt: Deposit, address: unknown): boolean {
  if (typeof address !== "string") return false;
  return receipt.kind === "evm" ? address.toLowerCase() === receipt.address.toLowerCase() : address === receipt.address;
}

export function verifyReceipt(request: Request, address: unknown, now = Date.now()): Receipt | null {
  const key = secret();
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const parts = token.length <= 556 ? TOKEN.exec(token) : null;
  if (!key || !parts) return null;
  const [, payload, signature] = parts;
  const given = Buffer.from(signature, "base64url");
  if (given.length !== 32 || given.toString("base64url") !== signature || !timingSafeEqual(given, sign(key, payload))) return null;
  try {
    const r = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Receipt;
    if (!r || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= now || typeof r.address !== "string" ||
      typeof r.recipient !== "string" || !isRealRecipient(r.recipient) ||
      (r.kind !== "evm" && r.kind !== "sol" && r.kind !== "btc") ||
      !isAddressOf(r.kind, r.address) || !sameReceiptAddress(r, address)) return null;
    return r;
  } catch {
    return null;
  }
}

export function receiptRequired(): Response {
  return Response.json({ code: "receipt_required", message: "A valid 1Click receipt is required to track this deposit." }, {
    status: 403,
    headers: { "cache-control": "no-store" },
  });
}
