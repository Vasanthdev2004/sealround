import type { AttestedRun, MissingRun, Sale, SaleResult } from "@/lib/types";
import { CHAIN_ROWS, RUN_LABELS } from "@/lib/verify/labels";
import type { FullVerification } from "@/lib/verify/types";

export type EvidenceState = "passed" | "failed" | "unavailable" | "not_applicable";

export function evidenceState(ok: boolean | null, applies = true): EvidenceState {
  if (!applies) return "not_applicable";
  return ok === true ? "passed" : ok === false ? "failed" : "unavailable";
}

/** Same grammar as the contract. Never send a path, URL or oversized key to RPC. */
export function validVerifyId(id: string): boolean {
  return /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/.test(id);
}

export function verifyHref(id: string): string {
  return `/verify/${encodeURIComponent(id)}`;
}

function publicRun(run: AttestedRun | MissingRun | null, applies: boolean) {
  if (!applies) return { state: "not_applicable" as const };
  if (!run) return { state: "unavailable" as const, reason: "no_run" };
  if (!run.found) return { state: "unavailable" as const, reason: run.reason };
  return {
    state: "available" as const,
    simulated: run.simulated,
    attestationId: run.attestationId,
    taskId: run.taskId,
    requestId: run.requestId,
    transaction: run.txHash,
    blockHeight: run.blockHeight,
    runAt: run.at,
    quote: run.quote,
    checks: Object.keys(RUN_LABELS).map((id) => ({
      id,
      state: evidenceState(run.checks.find((check) => check.id === id)?.ok ?? null),
    })),
  };
}

/**
 * A public snapshot, not a serialization of client state. Keep this allowlist
 * explicit: verification facts can contain the connected bidder's own terms.
 * No wallet, bid-secret, receipt, arbitrary evidence items or your_bid check.
 */
export function buildPublicEvidence({
  sale,
  result,
  verification,
  environment,
  readAt,
}: {
  sale: Sale;
  result: SaleResult | null;
  verification: FullVerification | null;
  environment: { mode: "mock" | "near"; network: string; contract: string };
  readAt: number;
}) {
  return {
    schema: "sealround.public-evidence.v1",
    environment: { mode: environment.mode, network: environment.network, contract: environment.contract },
    simulated: environment.mode === "mock" || verification?.simulated === true || verification?.chain?.simulated === true,
    snapshotReadAt: readAt,
    units: { amounts: "integer base units", quoteDecimals: 6, tokenDecimals: sale.config.decimals, timestamps: "unix milliseconds" },
    sale: {
      id: sale.id,
      tokenAccount: sale.tokenAccount,
      status: sale.status,
      revealMode: sale.config.revealMode,
      quoteToken: sale.config.quoteToken,
      bidCount: sale.bidCount,
      totalDeposits: sale.totalDeposits.toString(),
      saleSupply: sale.config.saleSupply.toString(),
      floorPrice: sale.config.floorPrice.toString(),
      bidEnd: sale.config.bidEnd,
      closedAt: sale.closedAt,
      settledAt: sale.settledAt,
      bidSetHash: sale.bidSetHash,
      sealerPublicKey: sale.sealerPubkey,
      sealerCodeHash: sale.sealerCodeHash,
    },
    result: result ? {
      status: result.status,
      failReason: result.failReason ?? null,
      clearedBy: result.clearedBy ?? null,
      clearingPrice: result.clearingPrice.toString(),
      totalSold: result.totalSold.toString(),
      totalRaised: result.totalRaised.toString(),
      unsold: result.unsold.toString(),
      validBids: result.nValid,
      invalidBids: result.nInvalid,
      bidSetHash: result.bidSetHash,
      inputSha256: result.inputSha256 ?? null,
      resultSha256: result.resultSha256 ?? null,
      settlementTransaction: result.settleTx,
    } : null,
    verification: verification ? {
      state: "available" as const,
      checkedAt: verification.checkedAt,
      simulated: verification.simulated,
      pinnedWasm: verification.pinnedWasm,
      keyRun: publicRun(verification.key, sale.config.revealMode === "tee"),
      clearingRun: publicRun(verification.clear, sale.config.revealMode === "tee"),
      chainSimulated: verification.chain?.simulated ?? null,
      publicChainChecks: CHAIN_ROWS.filter(({ id }) => id !== "your_bid").map(({ id }) => {
        const check = verification.chain?.checks.find((item) => item.id === id);
        return { id, state: check ? evidenceState(check.ok, check.applies) : "unavailable" as const };
      }),
    } : { state: "unavailable" as const, checkedAt: null },
    limits: [
      "This is a public snapshot, not a proof of all private bid terms or a security audit.",
      "The browser checks quote bindings and approved measurements; it does not validate the Intel quote signature chain.",
      "Access-key checks describe current reads, not historical keylessness throughout the sale.",
      "Run timestamps are historical evidence. OutLayer does not accept a fresh challenge nonce.",
      "Snapshot reads and verification reads are separate requests and are not an atomic block snapshot.",
      "Wallet-specific bid checks, private terms and recovery receipts are excluded.",
    ],
  };
}
