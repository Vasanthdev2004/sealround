import { appConfig } from "@/lib/config";
import { getClient } from "@/lib/client";

export function publicEnvironment() {
  const config = appConfig();
  return {
    mode: config.mode,
    network: config.mode === "near" ? config.near.network : "browser simulation",
    contract: getClient().contractId,
  };
}

export function VerifyEnvironment() {
  const environment = publicEnvironment();
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-l border-line pl-3 text-label">
      <span className="font-medium text-fg">{environment.mode === "mock" ? "Simulated evidence" : `NEAR ${environment.network}`}</span>
      <span className="min-w-0 break-words text-muted">
        {environment.mode === "mock" ? "Local to this browser. No live chain or signed attestation." : environment.contract}
      </span>
    </div>
  );
}
