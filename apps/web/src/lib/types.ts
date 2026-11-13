/**
 * App-side domain types. These mirror the contract views (get_sale, get_bid,
 * get_result, get_bids_summary) so the mock client can later be swapped for a
 * NEAR RPC client without touching the pages.
 *
 * Units: USDC base units (6 dp), prices in USDC base units per WHOLE token,
 * token amounts in token base units (`decimals`, default 18). All bigint.
 * Times are unix milliseconds.
 */

import type { Fill, ClearingResult } from "@fairground/clearing";

export type SaleStatus =
  /** Created, bid window not started. */
  | "upcoming"
  /** Bid window open. */
  | "open"
  /** Window ended, nobody has called close_sale yet. */
  | "awaiting_close"
  /** close_sale called, waiting on the enclave result. */
  | "clearing"
  /** Commit-reveal fallback only: reveal window open. */
  | "revealing"
  | "settled"
  | "failed";

export type RevealMode = "tee" | "commit_reveal";
export type UnsoldRule = "burn";

/**
 * The contract's own status names (get_sale.status). SaleStatus folds two of
 * them: "setup" shows as "upcoming" and "closed" (a clearing attempt failed,
 * close_sale retries) shows as "clearing". Sale.chainStatus keeps the raw one.
 */
export type ChainSaleStatus =
  | "setup"
  | "upcoming"
  | "open"
  | "awaiting_close"
  | "clearing"
  | "closed"
  | "revealing"
  | "settled"
  | "failed";

/** The contract's fail reasons (get_result.fail_reason). */
export type ChainFailReason =
  | "no_bids"
  | "no_valid_bids"
  | "below_min_raise"
  | "nothing_sold"
  | "checks_failed"
  | "refund_mode";

/** A setup step of a sale (token deploy, sealer key). */
export type StepState = "pending" | "done" | "failed";

/** Every reason the contract returns a bid deposit (`bid_rejected.reason`). */
export type BidRejectReason =
  | "bad_msg"
  | "unknown_sale"
  | "wrong_token"
  | "not_open"
  | "wrong_payload"
  | "bad_base64"
  | "ciphertext_too_long"
  | "wrong_ciphertext_length"
  | "bad_hex"
  | "below_min_deposit"
  | "above_max_deposit"
  | "already_bid"
  | "sale_full"
  | "overflow";

export type SaleConfig = {
  tokenName: string;
  tokenSymbol: string;
  decimals: number;
  totalSupply: bigint;
  saleSupply: bigint;
  /** Tokens sent to the creator at settlement. Disclosed up front. */
  creatorAllocation: bigint;
  /**
   * totalSupply - saleSupply - creatorAllocation. With `liquidity` set, these
   * are the sale tokens set aside for the launch pool (its `poolTokens`);
   * without it the mock holds them for an LP and NEAR mode has none.
   */
  lpReserve: bigint;
  floorPrice: bigint;
  /** Optional ceiling; bounds the total raise to saleSupply * maxPrice. */
  maxPrice: bigint | null;
  minRaise: bigint;
  bidStart: number;
  bidEnd: number;
  minDeposit: bigint;
  maxDepositPerAccount: bigint;
  revealMode: RevealMode;
  unsoldRule: UnsoldRule;
  settleTimeoutMs: number;
  /** NEP-141 account of the only accepted deposit token. */
  quoteToken: string;
  /**
   * Most bids the sale takes (contract `max_bids`, 1..=500). The creator
   * prepays storage per slot. Defaults: 500 in the mock, 100 when creating on NEAR.
   */
  maxBids?: number;
  /** Commit-reveal only: reveal window after the close, ms (contract default 10 minutes, 1 minute to 7 days). */
  revealWindowMs?: number;
  /** Launch liquidity: a pool seeded at the clearing price at settlement. Absent or null: none. */
  liquidity?: LiquidityTerms | null;
};

/** Launch liquidity terms, fixed at creation (contract `create_sale` `liquidity`). */
export type LiquidityTerms = {
  /** The exchange account the pool is seeded on (Rhea, formerly Ref Finance). */
  dex: string;
  /** Share of the raise that goes into the pool, basis points (1 to 5000). */
  raiseShareBps: number;
  /** Sale tokens set aside for the pool, base units. Equal to the config's lpReserve. */
  poolTokens: bigint;
  /** The pool's swap fee, basis points (1 to 1000). */
  feeBps: number;
};

/**
 * waiting: the sale is not final. seeding: settled with a pool to seed, sale
 * tokens locked. seeded: the pool holds its amounts. skipped: the amounts
 * came to zero, no pool. cancelled: the sale failed. abandoned: not seeded by
 * the deadline, so the pool's USDC goes to the creator and its tokens burn.
 */
export type LiquidityStage = "waiting" | "seeding" | "seeded" | "skipped" | "cancelled" | "abandoned";
/**
 * One step of seed_liquidity (or abandon_liquidity's withdraw). `reconcile`
 * reads the exchange again after a step whose answer never came (the contract
 * gives such a step up after 600 blocks).
 */
export type LiquidityStep = "register" | "create_pool" | "deposit" | "add_liquidity" | "withdraw" | "reconcile";

/** Launch liquidity progress (contract get_result `liquidity`). */
export type LiquidityState = {
  stage: LiquidityStage;
  /** What seed_liquidity (seeding) or abandon_liquidity (abandoned) would run now. */
  nextStep: LiquidityStep | null;
  /** The step waiting for its result. With `nextStep` "reconcile" it waited too long and will be given up. */
  inFlight: LiquidityStep | null;
  dex: string;
  poolId: number | null;
  /** USDC and sale tokens the pool gets, base units (zero when skipped or cancelled). */
  usdc: bigint;
  tokens: bigint;
  /** LP shares the sale contract holds. They never leave it. */
  shares: bigint;
  /** Deposited on the exchange, not yet in the pool or withdrawn. */
  usdcOnDex: bigint;
  tokensOnDex: bigint;
  /** Steps that failed so far. Each can be run again. */
  failures: number;
  /** Seeding is possible until, and abandon_liquidity from, this time (ms). Null before settlement. */
  deadline: number | null;
  /** True in the mock: no exchange was called. */
  simulated?: boolean;
};

/** A launch pool as the exchange reports it (Ref `get_pool` and `get_pool_shares`). */
export type DexPool = {
  dex: string;
  poolId: number;
  /** Token accounts in the pool, in the exchange's order. */
  tokenIds: string[];
  /** Reserves, matching `tokenIds`. */
  amounts: bigint[];
  feeBps: number;
  sharesTotal: bigint;
  /** LP shares the sale contract holds. */
  contractShares: bigint;
  /** When the exchange was read (ms). */
  readAt: number;
  /** True in the mock: no exchange was read. */
  simulated?: boolean;
};

export type SaleMeta = {
  description: string;
  /** Hex colour used for the token avatar. */
  hue: number;
  website?: string;
  /**
   * The token's icon (contract `icon`, the token's NEP-148 metadata icon): a
   * data URL of at most 2,048 bytes (lib/token-icon.ts). Absent or null: none,
   * and the monogram stands in.
   */
  icon?: string | null;
};

export type Sale = {
  id: string;
  creator: string;
  /** The sale's token contract: `<sale_id>.<contract>`. */
  tokenAccount: string;
  config: SaleConfig;
  meta: SaleMeta;
  status: SaleStatus;
  createdAt: number;
  createTx: string;
  /** X25519 public key of this sale, hex. Set by the attested key call. */
  sealerPubkey: string;
  /** Hash of the enclave build that holds the key. */
  sealerCodeHash: string;
  /** sha256 over the frozen bid set, hex. Set at close. */
  bidSetHash: string | null;
  closedAt: number | null;
  settledAt: number | null;
  /** Set when anyone triggered refund mode after settle_timeout. */
  refundModeAt: number | null;
  /** Public aggregates, always visible. */
  bidCount: number;
  totalDeposits: bigint;
  /** True for sales created by judge mode. */
  isJudgeSale: boolean;

  // ---- Added for the real contract. Optional so older code keeps compiling;
  // ---- both clients set them.
  /** The contract's status name, before folding into `status`. */
  chainStatus?: ChainSaleStatus;
  /** Most bids the sale takes. */
  maxBids?: number;
  /** Commit-reveal: when the reveal window ends (ms), once closed. */
  revealEnd?: number | null;
  /**
   * When anyone may call trigger_refund_mode (ms); null once final. Counted
   * from the close (the reveal end in commit-reveal), else from bid_end.
   * Unlike `refundModeAt`, which says refund mode was triggered.
   */
  refundModeFrom?: number | null;
  /** The contract's fail reason once failed. */
  chainFailReason?: ChainFailReason | null;
  /** Token deploy and sealer key setup steps. */
  tokenSetup?: StepState;
  sealerKeySetup?: StepState;
  /** The running bid-set hash h_n over the bids so far (bidSetHash is set only at close). */
  runningBidSetHash?: string;
};

/** A bid as anyone can see it on-chain. The price is not here. */
export type BidRecord = {
  saleId: string;
  index: number;
  bidder: string;
  deposit: bigint;
  /** Sealed box ciphertext, base64. */
  ciphertext: string;
  placedAt: number;
  txHash: string;
  claimed: boolean;
  claimTx: string | null;
  /** Demo-only label so the UI can mark the sniper bots. Not on-chain. */
  tag?: "bot" | "sim" | "you";
  /** "ciphertext" (TEE sale; `ciphertext` holds it) or "commitment" (commit-reveal; `ciphertext` holds the 32-byte commitment, base64). */
  payloadKind?: "ciphertext" | "commitment";
  /** Commit-reveal: the bidder revealed in time. */
  revealed?: boolean;
};

export type ContractCheck = {
  id: string;
  label: string;
  passed: boolean;
};

/**
 * What the contract's views hold about the enclave run (NearClient
 * `getAttestation`, used by the sandbox end-to-end run): the pinned code hash,
 * the stored sale key and the sha256 of the clearing input and output. No
 * quote is fetched (`nonce` and `quote` are ""). The UI uses `verifySale`.
 */
export type Attestation = {
  nonce: string;
  codeHash: string;
  /** Public key the contract stored for this sale, hex. */
  reportedPubkey: string;
  inputHash: string;
  outputHash: string;
  quote: string;
  fetchedAt: number;
  url: string;
  simulated: boolean;
  source?: "simulated" | "chain";
};

// ---------- verification of the enclave runs (near/attestation.ts) ----------

/** The five TDX registers OutLayer's register contract approves, hex. */
export type TeeMeasurements = { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; rtmr3: string };

/**
 * One run of the sealer job on OutLayer: the sale key run (create_sale, or
 * retry_setup after a failed one; op "pubkey") or the clearing run
 * (close_sale; op "clear").
 */
export type RunKind = "key" | "clear";

/**
 * The checks of one run (Verify-Attestation.ps1):
 * - build: the attested wasm_hash is the build the contract pins;
 * - executed: the worker's measured executed_wasm_sha256 is that build;
 * - input / output: sha256 of the request's input and of the returned bytes,
 *   recomputed from the transaction, equal the attested hashes (and, for a
 *   clear, the contract's input_sha256 and result_sha256);
 * - task: the TDX quote's report_data commits to this attestation record;
 * - measurements: the quote's MRTD and RTMR0-3 are approved on chain;
 * - request: the request came from the sale contract, for this sale, with the
 *   pinned source, in the attested block;
 * - key: the job's answer names the sale's key.
 */
export type RunCheckId = "build" | "executed" | "input" | "output" | "task" | "measurements" | "request" | "key";

/** One piece of evidence: values that must all be equal, or one fact checked on its own. */
export type AttestationFact =
  | { kind: "equal"; values: { label: string; value: string }[]; ok: boolean }
  | { kind: "fact"; label: string; value: string; ok: boolean };

/** One check of one run. `ok` null: it could not be run here; its items say why. */
export type RunCheck = { id: RunCheckId; ok: boolean | null; items: AttestationFact[] };

/**
 * How the transaction behind a run was found: by scanning the block the
 * contract recorded for the request, from this browser's own log of what it
 * sent, from OutLayer's public job list, or simulated (the mock).
 */
export type RunTxSource = "block_scan" | "tx_log" | "outlayer_jobs" | "simulated";

/** A run whose attestation was fetched and checked. */
export type AttestedRun = {
  kind: RunKind;
  found: true;
  simulated: boolean;
  /** OutLayer's attestation record id, its task (job) id and request id. */
  attestationId: number;
  taskId: number;
  requestId: number | null;
  /** The transaction that led to the run, and its signer. */
  txHash: string;
  signer: string;
  /** The Fairground method it called (create_sale, retry_setup, close_sale). */
  method: string | null;
  txSource: RunTxSource;
  /** The block scanned when `txSource` is "block_scan". */
  scannedBlock?: number;
  /** Block height and time (ms) of the attested run. OutLayer takes no nonce: this is how old the evidence is. */
  blockHeight: number | null;
  at: number;
  /** The TDX quote, base64. */
  quote: string;
  /** OutLayer's verifier page for this run (it checks the quote's signature chain up to Intel). */
  verifierUrl: string | null;
  checks: RunCheck[];
};

/** A run that could not be checked, and why. */
export type MissingRun = {
  kind: RunKind;
  found: false;
  /**
   * no_service: no OutLayer attestation service on this network (a local sandbox);
   * not_found: the transaction behind the run could not be found;
   * no_attestation: OutLayer has no attestation for it;
   * failed: reading it failed (network, RPC).
   */
  reason: "no_service" | "not_found" | "no_attestation" | "failed";
  message: string;
};

/** Every check this browser ran on a sale's enclave runs. */
export type SaleVerification = {
  /** The mock: an unsigned, simulated attestation. */
  simulated: boolean;
  /** When the checks ran, this browser's clock. */
  checkedAt: number;
  /** The build the contract pins (get_sale.sealer_code_hash). */
  pinnedWasm: string;
  /** The sale key run; null when the sale has none (commit-reveal). */
  key: AttestedRun | MissingRun | null;
  /** The clearing run; null when no clearing result reached the contract. */
  clear: AttestedRun | MissingRun | null;
};

/** One bid's outcome. `refund` is net of `penalty`. */
export type ResultFill = Fill & {
  claimed: boolean;
  claimTx: string | null;
  tag?: BidRecord["tag"];
  /**
   * The invalid-bid penalty kept from the deposit: 1 % rounded up for a bid
   * the enclave (or clear_onchain) found invalid, including an unrevealed
   * commit-reveal bid; 0 otherwise. Already taken out of `refund`.
   */
  penalty?: bigint;
  /** Commit-reveal: whether the bidder revealed in time (an unrevealed bid is invalid). */
  revealed?: boolean;
  /**
   * The USDC part is paid but the tokens are not: the launch pool is being
   * seeded and sale tokens stay locked. `claimed` stays false until they are paid.
   */
  refundClaimed?: boolean;
};

/**
 * Which creator payouts are settled. claim_proceeds pays each part once.
 *
 * A part is settled when it was paid or when there was never any of it to pay
 * (no raise on a failed sale, nothing to burn on a sold-out one, no reserve
 * when every bid slot went to a winner). So all four true means claim_proceeds
 * has nothing left to do, and any false means it will pay something. In NEAR
 * mode this is worked out from the views (near/views.ts `proceedsLeft`): the
 * contract's own get_result.proceeds flags stay false for a part that was
 * never owed.
 */
export type ProceedsState = {
  /** The raise in USDC (settled sales). */
  raisePaid: boolean;
  /** The creator allocation in tokens. */
  allocationPaid: boolean;
  unsoldBurned: boolean;
  /** The unused NEAR reserve. */
  reserveReturned: boolean;
  /**
   * The launch pool is being seeded, so the allocation cannot be paid yet.
   * `allocationPaid` is then true, so all four flags true still means
   * "nothing claim_proceeds can pay now".
   */
  allocationLocked?: boolean;
};

export type SaleResult = Omit<ClearingResult, "fills" | "failReason"> & {
  /**
   * settle_timeout: the enclave never answered and anyone switched the sale to
   * refunds. undefined on a failed sale: a contract check failed
   * (`chainFailReason` "checks_failed").
   */
  failReason?: ClearingResult["failReason"] | "settle_timeout";
  fills: ResultFill[];
  /** Hash the enclave reports for the bid set it cleared, hex. */
  bidSetHash: string;
  checks: ContractCheck[];
  settleTx: string;
  clearingMs: number;

  // ---- Added for the real contract (optional; both clients set them).
  /** Sum of every fill's penalty (get_result.total_penalties). */
  totalPenalties?: bigint;
  /** The contract's own fail reason. */
  chainFailReason?: ChainFailReason;
  /** Failed contract check names, the first 8 (get_result.failed_checks), and how many failed in all. */
  failedChecks?: string[];
  failedChecksTotal?: number;
  /** sha256 of the sealer output as received (attestation output_hash) and of the clearing input. */
  resultSha256?: string | null;
  inputSha256?: string | null;
  /** How the sale was cleared: by the enclave (TEE) or by the contract from revealed bids. */
  clearedBy?: "enclave" | "onchain" | "none";
  /** Which creator payouts claim_proceeds has made. */
  proceeds?: ProceedsState;
  /** Launch liquidity progress; absent or null for a sale without it. */
  liquidity?: LiquidityState | null;
};

export type SaleEventKind =
  | "created"
  | "bid"
  | "bid_rejected"
  | "closed"
  | "clearing_requested"
  | "settled"
  | "failed"
  | "claimed"
  | "refund_mode";

export type SaleEvent = {
  saleId: string;
  kind: SaleEventKind;
  at: number;
  account?: string;
  /** USDC base units, for bids/claims. */
  amount?: bigint;
  /** "" when not known (an event derived from a view, not from a transaction this browser sent). */
  txHash: string;
  note: string;
  /** bid_rejected: the contract's reason code. */
  reason?: BidRejectReason;
  /**
   * The contract event behind this row when `kind` is too coarse to say:
   * "bid_revealed" (kind "bid"), "proceeds_claimed" (kind "claimed", the
   * account is the creator, the amount the raise paid), "clearing_failed"
   * (kind "clearing_requested": an attempt ended without a result and
   * close_sale can retry), "sale_ready" (kind "created"), "liquidity_seeded"
   * and "liquidity_abandoned" (kind "settled": the launch pool's outcome),
   * "refund_claimed" (kind "claimed": the USDC part of a claim while the sale
   * tokens are locked).
   */
  detail?:
    | "bid_revealed"
    | "proceeds_claimed"
    | "clearing_failed"
    | "sale_ready"
    | "liquidity_seeded"
    | "liquidity_abandoned"
    | "refund_claimed";
  /**
   * True when `at` is not the block time. In NEAR mode some events are
   * derived from views that do not record when they happened: `at` is then
   * the earliest the event could have happened, or this browser's clock when
   * this browser sent the transaction.
   */
  approximate?: boolean;
  /** "simulated": the mock. "view": derived from contract views. "tx": from a transaction this browser sent. */
  source?: "simulated" | "view" | "tx";
};

export type Balances = {
  account: string;
  /** Test USDC on NEAR, base units. */
  usdc: bigint;
  /** saleId -> token base units claimed. */
  tokens: Record<string, bigint>;
};

export type ClaimReceipt = {
  saleId: string;
  bidder: string;
  tokens: bigint;
  refund: bigint;
  txHash: string;
};

/**
 * Plaintext inside the sealed box. Canonical JSON, keys in this order. Here
 * the amounts are plain decimal strings; canonicalBid pads them to 39 digits.
 */
export type BidPlaintext = {
  sale_id: string;
  bidder: string;
  /** Decimal string, USDC base units per whole token. */
  max_price: string;
  /** Decimal string, USDC base units. */
  max_spend: string;
  /** 16 random bytes, hex. */
  salt: string;
};

// ---------- writes: results, relay metadata, errors ----------

/** What a bidder decides. Prices in USDC base units per whole token, spend in USDC base units. */
export type BidTerms = { maxPrice: bigint; maxSpend: bigint };

/** A commit-reveal reveal: the committed terms and the 32-hex-character salt. */
export type RevealTerms = BidTerms & { salt: string };

/**
 * Why the user paid for a call that is normally gasless:
 * - delegates_unsupported: the wallet cannot sign NEP-366 delegates (MyNearWallet, OKX, Nightly, ...);
 * - rate_limited / budget_exhausted: the relayer refused before sending anything;
 * - relay_failed: the relayer could not be reached (asked before anything was signed), or it could not get its transaction accepted;
 * - no_relayer: NEXT_PUBLIC_RELAYER_URL is not set;
 * - method_not_relayed: the relayer's policy does not cover this call (its method, or the sale's USDC contract).
 */
export type PaidReason =
  | "delegates_unsupported"
  | "rate_limited"
  | "budget_exhausted"
  | "relay_failed"
  | "no_relayer"
  | "method_not_relayed";

/** How a write reached the chain. */
export type RelayInfo = {
  /** "relayer": gasless. "user": a normal transaction the user's wallet signed and paid for. */
  paidBy: "relayer" | "user";
  /** Why the user paid; null when the relayer did. */
  fallbackReason: PaidReason | null;
  /** Null only when a wallet returned no recognisable outcome. */
  txHash: string | null;
  /** "pending": the transaction is in a block but its outcome was not known in time. */
  status: "succeeded" | "failed" | "pending";
  /** The relayer's request id, when the relayer answered with one (errors carry it too). */
  requestId: string | null;
  /** True on the simulated chain. */
  simulated: boolean;
};

/** Every write result carries how it was paid for. Optional so the old return types still fit. */
export type WithRelay = { relay?: RelayInfo };

export type BidResult = BidRecord & WithRelay & {
  /** Commit-reveal: the stored secret needed to reveal (also kept in this browser, see lib/bid-secrets). */
  secret?: { salt: string; commitment: string };
};
export type ClaimResult = ClaimReceipt & WithRelay;
export type SaleWithRelay = Sale & WithRelay;
export type WriteResult = WithRelay & { txHash: string };
/** seed_liquidity or abandon_liquidity: the transaction and the progress it left. */
export type LiquidityWriteResult = WriteResult & { liquidity: LiquidityState };

/** USDC storage registration (NEP-145) of an account, before USDC can be delivered to it. */
export type StorageResult = {
  /**
   * already_registered: nothing to do. sponsored: the relayer paid.
   * paid: the user's wallet paid a storage_deposit (the relayer's storage budget was used up, or there is no relayer).
   */
  status: "already_registered" | "sponsored" | "paid";
  txHash: string | null;
};

/** Per-call options for writes. */
export type WriteOptions = {
  /**
   * Awaited before a paid transaction replaces a gasless one, e.g. to tell the
   * user their wallet will ask again and they pay the gas. Throw to stop.
   */
  onPaidFallback?: (reason: PaidReason) => void | Promise<void>;
  /**
   * The account that signs. Default: the account the call is for (the bidder
   * of a bid or reveal, the `caller` argument), or for a claim the connected
   * account, since anyone may push a claim for a bidder.
   */
  caller?: string;
};

/** Options of createSale. */
export type CreateOptions = {
  /** The sale id (and token account `<sale_id>.<contract>`). Default: the token symbol in lower case. */
  saleId?: string;
  /**
   * NEAR mode: create_sale refuses a bid_start in the past, and the wallet
   * approval plus inclusion take time, so a bid_start sooner than this many
   * ms from now is moved to now + this (bid_end moves with it, keeping the
   * window length). Default 120000. The returned Sale has the real times.
   */
  minStartLeadMs?: number;
};

/** What the relayer pays for (GET /policy), for a "gasless" indicator. */
export type RelayerPolicyInfo = {
  relayerAccountId: string;
  /** Fairground methods the relayer relays (claim, claim_proceeds, reveal_bid, clear_onchain, trigger_refund_mode). Bids go through ft_transfer_call on `usdcContracts`. */
  methods: string[];
  usdcContracts: string[];
  /** True on the simulated chain. */
  simulated: boolean;
};

/** What a client can do, so the UI can hide what does not apply. */
export type ClientCapabilities = {
  /** Judge mode runs (the simulated chain only). */
  judgeMode: boolean;
  /** faucet() mints test USDC (mock; NEAR testnet or sandbox through the token's open mint). */
  faucet: boolean;
  /** reset() wipes demo data (mock only). */
  reset: boolean;
  /** Calls can be gasless through the relayer (NEAR mode with NEXT_PUBLIC_RELAYER_URL set; always in the mock). */
  relayer: boolean;
  /** The chain is simulated in this browser. */
  simulated: boolean;
};

/** A message for the user that is not an error: a paid fallback, a storage registration. */
export type ClientNotice = {
  kind: "paid_fallback" | "storage_sponsored" | "storage_paid" | "pending";
  message: string;
  reason?: PaidReason;
  at: number;
};
