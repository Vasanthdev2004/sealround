/**
 * The live testnet evidence the web app points at: the sale contract, whether
 * its account is locked, and the sales that ran on NEAR testnet. Plain data,
 * kept in step with `evidence/sales.json` at the repo root: when a sale lands
 * or the contract is locked, change it here too.
 *
 * Used by the landing page's "Live on NEAR testnet" strip, the judge-mode
 * summary and the app's simulated-chain note.
 */

export type LiveSale = {
  /** The sale contract the sale ran on. */
  contract: string;
  /** The sale id. Its token is the account `<sale>.<contract>`. */
  sale: string;
  /** "tee" (bids opened in the enclave) or "commit-reveal" (cleared on chain). */
  mode: string;
  /** True when the sale ran after the contract account's last key was deleted. */
  afterLock: boolean;
  /** One plain sentence on what the sale shows. */
  note: string;
};

export const LIVE_NETWORK = "testnet";

/** The block explorer the links open. */
export const LIVE_EXPLORER = "https://testnet.nearblocks.io";

/** The current sale contract (the one `/deploy` set up). */
export const LIVE_CONTRACT = "sealround.itzbeast.testnet";

/**
 * True once `view_access_key_list` on LIVE_CONTRACT returns no keys. The last
 * key was deleted at 12:39:05 UTC on 14 Nov 2026; FastNear and drpc both
 * returned `"keys":[]` at block 277,658,078.
 */
export const LIVE_CONTRACT_LOCKED = true;

/** The transaction that deleted the contract account's last key, once there is one. */
export const LIVE_LOCK_TX: string | null = "6kCHNqDZYeLbkL41uPwMuRKddMbKqn4FmFLn8ZY76MpK";

/** Every live sale, oldest first. */
export const LIVE_SALES: readonly LiveSale[] = [
  {
    contract: "fairground.itzbeast.testnet",
    sale: "smoke-11120830",
    mode: "tee",
    afterLock: false,
    note: "First smoke sale, on an older contract build. That contract was never locked.",
  },
  {
    contract: "sealround.itzbeast.testnet",
    sale: "nosnipe-11140429",
    mode: "tee",
    afterLock: false,
    note: "Two bidders, settled at the 0.001 USDC floor, launch pool 2970 on Rhea. Ran while the contract still had its deploy key.",
  },
  {
    contract: "sealround.itzbeast.testnet",
    sale: "nosnipe-11140458",
    mode: "tee",
    afterLock: false,
    note: "Six bids: a sniper 3.6 s after open, a copycat voided, settled at 0.002 USDC, launch pool 2971 on Rhea. Ran while the contract still had its deploy key.",
  },
];

/**
 * The live sniper bot's run in nosnipe-11140458, from `get_bids` and
 * `get_fills` (read 14 Nov 2026): sniper.itzbeast.testnet bid 3.6 s after the
 * window opened, late.itzbeast.testnet 559.4 s after (of 600 s). Each got 2,500
 * tokens for 5 USDC, so both paid 0.002 USDC per token, the clearing price.
 */
export const LIVE_SNIPER = {
  contract: "sealround.itzbeast.testnet",
  sale: "nosnipe-11140458",
  sniperAfterOpen: "3.6 s",
  lateAfterOpen: "559.4 s",
  windowSeconds: 600,
  price: "0.002",
} as const;

/** The most recent live sale. */
export function newestLiveSale(): LiveSale {
  return LIVE_SALES[LIVE_SALES.length - 1];
}

/** An account's page on the explorer. */
export function explorerAddress(account: string): string {
  return `${LIVE_EXPLORER}/address/${account}`;
}

/** A transaction's page on the explorer. */
export function explorerTx(hash: string): string {
  return `${LIVE_EXPLORER}/txns/${hash}`;
}

/** The sale's token account: `<sale>.<contract>`. */
export function tokenAccount(s: Pick<LiveSale, "contract" | "sale">): string {
  return `${s.sale}.${s.contract}`;
}

/** The read-only command that re-checks a sale from a clone (apps/web/scripts/verify-sale.ts). */
export function verifyCommand(s: Pick<LiveSale, "contract" | "sale">): string {
  return `pnpm --filter web verify-sale --contract ${s.contract} --sale ${s.sale}`;
}

/** How the sale's bids were opened, for a label. */
export function modeLabel(mode: string): string {
  if (mode === "tee") return "Opened in the enclave";
  if (mode.includes("commit")) return "Cleared on chain";
  return mode;
}
