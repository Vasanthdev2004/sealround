import type { RunCheckId } from "../types";
import type { ChainCheckId } from "./types";

/** The checks of each enclave run, as the Verified panel and verify-sale name them. */
export const RUN_LABELS: Record<RunCheckId, string> = {
  build: "Attested build is the sealer the contract pins",
  executed: "The worker measured the same build",
  input: "Input hash matches the request on chain",
  output: "Output hash matches what the contract received",
  task: "The TDX quote commits to this record",
  measurements: "Enclave measurements are approved on chain",
  request: "The request came from the sale contract, for this sale",
  key: "The job's answer names the sale's key",
};

/** The contract and rule checks, in the order they show, with what a row says while it runs. */
export const CHAIN_ROWS: readonly { id: ChainCheckId; label: string; pending: string }[] = [
  { id: "contract_code", label: "The sale contract runs the pinned build", pending: "Reading the contract's code hash." },
  { id: "contract_keys", label: "Nobody holds a key to the sale contract", pending: "Listing the contract's access keys." },
  { id: "token_keys", label: "Nobody holds a key to the token contract", pending: "Listing the token's access keys." },
  { id: "applied", label: "The contract applied exactly the attested output", pending: "Comparing the output with the views." },
  { id: "rules", label: "The clearing rules hold, recomputed here", pending: "Recomputing every fill." },
  { id: "lengths", label: "Every sealed bid has the fixed length", pending: "Measuring the sealed bids." },
  { id: "pool", label: "The launch pool opened at the clearing price", pending: "Reading the exchange." },
  { id: "your_bid", label: "Your bid got what the rule gives at this price", pending: "Applying the rule to your sealed terms." },
];

export const CHAIN_LABELS = Object.fromEntries(CHAIN_ROWS.map((r) => [r.id, r.label])) as Record<ChainCheckId, string>;
