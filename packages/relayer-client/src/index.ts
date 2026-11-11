/**
 * @fairground/relayer-client: build Fairground calls, sign them as NEP-366
 * delegates (NEAR Connect wallet or an in-memory key), and submit them through
 * the Fairground gas relayer, falling back to a normal paid transaction.
 * Browser-safe: no Node-only imports.
 */
export {
  bidAction,
  claimAction,
  claimProceedsAction,
  clearOnchainAction,
  revealAction,
  sealedBidLength,
  triggerRefundModeAction,
  type BidPayload,
  type FairgroundAction,
  type Reveal,
} from "./actions";
export { bidOutcome, summarizeOutcome, type BidOutcome, type TransactionSummary } from "./outcome";
export {
  RelayerError,
  createRelayerClient,
  type RelayerClient,
  type RelayerClientOptions,
  type TransportFailure,
} from "./relayer";
export {
  keyPairSigner,
  walletSigner,
  type ActionSigner,
  type ConnectWallet,
  type ConnectorFunctionCall,
  type KeyPairSignerOptions,
} from "./signers";
export { submitAction, type FallbackReason, type SubmitOptions, type SubmitResult } from "./submit";
export type {
  FairgroundEvent,
  PolicyResponse,
  ReceiptFailure,
  RejectionReason,
  RelayResponse,
  RelayStatus,
  StorageResponse,
} from "@fairground/relayer/api";
