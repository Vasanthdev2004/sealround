/**
 * Commit-reveal bid secrets kept in this browser: the committed terms and the
 * salt a bidder needs to reveal. Losing them means the bid cannot be revealed
 * and pays the 1 % invalid-bid penalty, so they are saved before the bid is
 * sent (a bid that may have landed can still be revealed) and can be exported.
 *
 * Keyed by scope, sale and bidder. The scope is the client's `secretsScope`:
 * the contract id in NEAR mode and "mock:fairground.testnet" in the mock, so a
 * testnet contract, a sandbox contract and the mock never mix. Stored in
 * localStorage; when that is unavailable (private mode, Node, tests) an
 * in-memory copy is used for the session.
 *
 * In the UI: `useBidSecret(saleId, account)` (lib/hooks) says whether this
 * browser can reveal a bid; exportBidSecrets / importBidSecrets move the
 * secrets to another device.
 */

export type BidSecret = {
  /** The scope the bid belongs to: the client's `secretsScope`. */
  contract: string;
  saleId: string;
  bidder: string;
  /** Decimal strings, USDC base units (per whole token for the price). */
  maxPrice: string;
  maxSpend: string;
  /** 16 bytes as 32 lowercase hex characters. */
  salt: string;
  /** sha256 commitment, 64 lowercase hex characters. */
  commitment: string;
  /** Deposit, USDC base units, decimal string. */
  deposit: string;
  savedAt: number;
};

const KEY = "fairground:bid-secrets:v1";
const EVT = "fairground:bid-secrets";
const memory = new Map<string, BidSecret>();

export const bidSecretKey = (contract: string, saleId: string, bidder: string) => `${contract}/${saleId}/${bidder}`;

function readAll(): Record<string, BidSecret> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Record<string, BidSecret>;
  } catch {
    // no storage: memory only
  }
  return Object.fromEntries(memory);
}

function writeAll(all: Record<string, BidSecret>): void {
  memory.clear();
  for (const [k, v] of Object.entries(all)) memory.set(k, v);
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // memory only
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVT));
}

/** Calls `cb` whenever the stored secrets change, in this tab or another. Returns unsubscribe. Browser only. */
export function subscribeBidSecrets(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => e.key === KEY && cb();
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVT, cb);
    window.removeEventListener("storage", onStorage);
  };
}

/** The stored secrets as one string that changes exactly when they do (a stable snapshot for useSyncExternalStore). */
export function bidSecretsSnapshot(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return JSON.stringify(Object.fromEntries(memory));
  }
}

export function saveBidSecret(s: BidSecret): void {
  const all = readAll();
  all[bidSecretKey(s.contract, s.saleId, s.bidder)] = s;
  writeAll(all);
}

export function getBidSecret(contract: string, saleId: string, bidder: string): BidSecret | null {
  return readAll()[bidSecretKey(contract, saleId, bidder)] ?? null;
}

/** Every stored secret, optionally for one contract, newest first. */
export function listBidSecrets(contract?: string): BidSecret[] {
  return Object.values(readAll())
    .filter((s) => !contract || s.contract === contract)
    .sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * The stored secrets as pretty JSON, for the user to save somewhere safe
 * (the UI offers it as a file download). Optionally for one contract or one bidder.
 */
export function exportBidSecrets(filter: { contract?: string; bidder?: string } = {}): string {
  const list = listBidSecrets(filter.contract).filter((s) => !filter.bidder || s.bidder === filter.bidder);
  return JSON.stringify({ format: "fairground-bid-secrets", version: 1, secrets: list }, null, 2);
}

/** Restores secrets from exportBidSecrets output. Returns how many were added or replaced. Throws on anything else. */
export function importBidSecrets(json: string): number {
  const parsed = JSON.parse(json) as { format?: unknown; secrets?: unknown };
  if (parsed.format !== "fairground-bid-secrets" || !Array.isArray(parsed.secrets)) {
    throw new Error("Not a Sealround bid-secrets file.");
  }
  const all = readAll();
  let n = 0;
  for (const s of parsed.secrets as BidSecret[]) {
    if (
      typeof s?.contract !== "string" ||
      typeof s.saleId !== "string" ||
      typeof s.bidder !== "string" ||
      !/^\d+$/.test(String(s.maxPrice)) ||
      !/^\d+$/.test(String(s.maxSpend)) ||
      !/^[0-9a-f]{32}$/.test(String(s.salt)) ||
      !/^[0-9a-f]{64}$/.test(String(s.commitment))
    ) {
      throw new Error("A secret in the file is malformed.");
    }
    all[bidSecretKey(s.contract, s.saleId, s.bidder)] = s;
    n++;
  }
  writeAll(all);
  return n;
}
