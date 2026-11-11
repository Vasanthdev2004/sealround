/**
 * The Fairground client for a real NEAR network (testnet, mainnet or a local
 * sandbox). Used only when NEXT_PUBLIC_FAIRGROUND_CONTRACT is set, and loaded
 * with import() (lazy-near.ts), so mock-mode pages never download it.
 *
 * Reads: the contract's views over JSON-RPC (near/rpc.ts, plain fetch),
 * translated by near/views.ts. Results are cached for a few seconds so the
 * pages' one-second polling does not become one RPC call per second per hook.
 *
 * Writes: through @fairground/relayer-client.
 * - Gasless when possible (bids, claims, reveals, clear_onchain, refund
 *   mode): the wallet signs a NEP-366 delegate and the relayer submits it. If
 *   the wallet cannot sign delegates, the relayer cannot be reached or does
 *   not pay for the call (asked with GET /policy before anything is signed),
 *   or it refuses for a reason of its own (rate limit, budget), the same call
 *   goes out as a normal transaction the user pays for, after `onPaidFallback`.
 * - Always a wallet transaction (never relayed, they attach NEAR):
 *   create_sale, close_sale, retry_setup, storage_deposit and the test-USDC mint.
 *
 * A call that may have reached the chain is never sent twice: when the
 * relayer's answer is lost or the outcome is unknown, the client polls the
 * views (get_bid, get_sale, ...) and either confirms it or throws a
 * FairgroundError with `maybeSubmitted` set. It never resends by itself.
 */

import {
  bidAction,
  bidOutcome,
  claimAction,
  claimProceedsAction,
  clearOnchainAction,
  createRelayerClient,
  RelayerError,
  revealAction,
  submitAction,
  summarizeOutcome,
  triggerRefundModeAction,
  type ActionSigner,
  type FairgroundAction,
  type FairgroundEvent,
  type RelayerClient,
  type TransactionSummary,
} from "@fairground/relayer-client";
import { getBidSecret, saveBidSecret } from "../bid-secrets";
import type { NearConfig } from "../config";
import { bidCommitment, randomHex, sealBid } from "../crypto";
import { browserSigners, type SignerSource } from "../near/signers";
import { createRpc, type NearRpc } from "../near/rpc";
import { TxLog } from "../near/tx-log";
import {
  bidFromView,
  commitmentHexOf,
  createSaleParams,
  eventsFromViews,
  proceedsLeft,
  resultFromViews,
  retrySetupDeposit,
  saleFromView,
  type BidView,
  type FillView,
  type ResultView,
  type SaleView,
} from "../near/views";
import type {
  Attestation,
  Balances,
  BidRecord,
  BidResult,
  BidTerms,
  ClaimResult,
  ClientCapabilities,
  ClientNotice,
  CreateOptions,
  PaidReason,
  RelayerPolicyInfo,
  RelayInfo,
  RevealTerms,
  Sale,
  SaleConfig,
  SaleEvent,
  SaleMeta,
  SaleResult,
  SaleWithRelay,
  StorageResult,
  WriteOptions,
  WriteResult,
} from "../types";
import {
  bidRejected,
  BID_REJECT_MESSAGES,
  contractMessage,
  FairgroundError,
  failureText,
  PAID_REASON_MESSAGES,
  relayerRefusalMessage,
} from "./errors";
import type { BidPayload, FairgroundClient, JudgeProgress } from "./index";
import {
  bidTermsProblem,
  ciphertextProblem,
  commitmentProblem,
  saleIdError,
  TOKEN_STORAGE_DEPOSIT,
} from "./rules";

const TGAS = 1_000_000_000_000n;
/**
 * Gas for the calls only a wallet sends. create_sale, close_sale and
 * retry_setup check their own gas and create promises (token deploy, the
 * OutLayer request with up to 500 bids asks 245 TGas: contracts/GAS.md), so
 * they get the most a transaction can attach. Unused gas is refunded.
 */
const WALLET_GAS = {
  create_sale: 300n * TGAS,
  close_sale: 300n * TGAS,
  retry_setup: 300n * TGAS,
  storage_deposit: 30n * TGAS,
  mint: 30n * TGAS,
} as const;
/** The largest page the contract's list views return. */
const PAGE = 200;
/** How long a relayer policy answer is trusted before asking again. */
const POLICY_TTL_MS = 15_000;

export type NearClientOptions = {
  /** Where signers come from. Default: the wallet connected in this browser (near/signers.ts `browserSigners`). */
  signers?: SignerSource;
  /** The relayer client; null = no relayer (every call is paid). Default: built from `config.relayerUrl`. */
  relayer?: RelayerClient | null;
  /** The RPC client. Default: JSON-RPC over fetch at `config.rpcUrl`. */
  rpc?: NearRpc;
  /** fetch for the default RPC and relayer clients (tests). */
  fetch?: typeof fetch;
  /** How long a view result is reused, ms. Default 3000; 0 turns the cache off (scripts, tests). */
  cacheMs?: number;
  /** How long to poll the views for a transaction whose outcome is unknown, ms. Default 30000. */
  waitMs?: number;
  /** Gap between two polls, ms. Default 1000. */
  pollMs?: number;
};

/** A write that reached the chain, however it was paid for. */
type Sent = { relay: RelayInfo; events: FairgroundEvent[] };
type Submitted = TransactionSummary & { paidBy: "relayer" | "user"; fallbackReason: PaidReason | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const invalid = (message: string, reason?: string) => new FairgroundError("invalid", message, { reason });
const say = (status: string) => status.replace(/_/g, " ");

/** A wallet that declined, as far as its error text tells: nothing was sent then. */
const looksLikeRejection = (message: string) => /reject|cancel|denied|declin|closed|abort/i.test(message);

export class NearClient implements FairgroundClient {
  readonly mode = "near" as const;
  readonly contractId: string;
  readonly usdcContract: string;
  readonly secretsScope: string;
  readonly capabilities: ClientCapabilities;

  private readonly rpc: NearRpc;
  private readonly relayer: RelayerClient | null;
  private readonly signers: SignerSource;
  private readonly log: TxLog;
  private readonly cacheMs: number;
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();
  private readonly listeners = new Set<() => void>();
  private readonly noticeListeners = new Set<(n: ClientNotice) => void>();
  private policy: { at: number; value: Promise<RelayerPolicyInfo | null> } | null = null;

  constructor(
    private readonly config: NearConfig,
    opts: NearClientOptions = {},
  ) {
    this.contractId = config.contractId;
    this.usdcContract = config.usdcContract;
    this.secretsScope = config.contractId;
    this.rpc = opts.rpc ?? createRpc(config.rpcUrl, { fetch: opts.fetch });
    this.relayer =
      opts.relayer !== undefined
        ? opts.relayer
        : config.relayerUrl
          ? createRelayerClient({ url: config.relayerUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) })
          : null;
    this.signers = opts.signers ?? browserSigners;
    this.log = new TxLog(config.contractId);
    this.cacheMs = opts.cacheMs ?? 3000;
    this.waitMs = opts.waitMs ?? 30_000;
    this.pollMs = opts.pollMs ?? 1000;
    this.capabilities = {
      judgeMode: false,
      faucet: config.network !== "mainnet",
      reset: false,
      relayer: this.relayer !== null,
      simulated: false,
    };
  }

  async ready(): Promise<void> {}

  // ---------- subscriptions ----------

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeNotices(listener: (n: ClientNotice) => void) {
    this.noticeListeners.add(listener);
    return () => {
      this.noticeListeners.delete(listener);
    };
  }

  private notify(n: Omit<ClientNotice, "at">) {
    const notice = { ...n, at: Date.now() };
    this.noticeListeners.forEach((l) => l(notice));
  }

  /** After a write: forget cached views and tell every query to run again. */
  private changed() {
    this.cache.clear();
    this.listeners.forEach((l) => l());
  }

  // ---------- views ----------

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.cacheMs <= 0) return load();
    const hit = this.cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < this.cacheMs) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: now, value });
    // A failed read is not worth keeping.
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    return value;
  }

  private view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    return this.rpc.view<T>(this.contractId, method, args);
  }

  private saleView(saleId: string): Promise<SaleView | null> {
    return this.cached(`sale:${saleId}`, () => this.view<SaleView | null>("get_sale", { sale_id: saleId }));
  }

  private resultView(saleId: string): Promise<ResultView | null> {
    return this.cached(`result:${saleId}`, () => this.view<ResultView | null>("get_result", { sale_id: saleId }));
  }

  /** Every item of a paged list view (the contract returns at most 200 per call). */
  private async pages<T>(method: string, args: Record<string, unknown>): Promise<T[]> {
    const all: T[] = [];
    for (;;) {
      const page = await this.view<T[]>(method, { ...args, from_index: all.length, limit: PAGE });
      all.push(...page);
      if (page.length < PAGE) return all;
    }
  }

  private bidViews(saleId: string): Promise<BidView[]> {
    return this.cached(`bids:${saleId}`, () => this.pages<BidView>("get_bids", { sale_id: saleId }));
  }

  private fillViews(saleId: string): Promise<FillView[]> {
    return this.cached(`fills:${saleId}`, () => this.pages<FillView>("get_fills", { sale_id: saleId }));
  }

  private async toSale(v: SaleView): Promise<Sale> {
    // Only a failed sale needs a second view, for its reason.
    const failReason = v.status === "failed" ? ((await this.resultView(v.sale_id))?.fail_reason ?? null) : null;
    return saleFromView(v, { failReason, createTx: this.log.find(v.sale_id, "created")?.txHash });
  }

  private async requireSaleView(saleId: string): Promise<SaleView> {
    const v = await this.saleView(saleId);
    if (!v) throw invalid("There is no sale with this id.", "unknown_sale");
    return v;
  }

  /** The sale straight from the chain, past the cache. */
  private freshSaleView(saleId: string): Promise<SaleView | null> {
    return this.view<SaleView | null>("get_sale", { sale_id: saleId });
  }

  private freshBidView(saleId: string, bidder: string): Promise<BidView | null> {
    return this.view<BidView | null>("get_bid", { sale_id: saleId, bidder });
  }

  async listSales(): Promise<Sale[]> {
    const views = await this.cached("sales", () => this.pages<SaleView>("get_sales", {}));
    const sales = await Promise.all(views.map((v) => this.toSale(v)));
    return sales.sort((a, b) => b.createdAt - a.createdAt);
  }

  async getSale(id: string): Promise<Sale | null> {
    const v = await this.saleView(id);
    return v ? this.toSale(v) : null;
  }

  async getBids(id: string): Promise<BidRecord[]> {
    const sale = await this.saleView(id);
    if (!sale) return [];
    const log = this.log.list(id);
    return (await this.bidViews(id)).map((b) => bidFromView(id, b, sale.reveal_mode === "CommitReveal", log));
  }

  async getBid(saleId: string, bidder: string): Promise<BidRecord | null> {
    const sale = await this.saleView(saleId);
    if (!sale) return null;
    const bid = await this.cached(`bid:${saleId}:${bidder}`, () => this.freshBidView(saleId, bidder));
    return bid ? bidFromView(saleId, bid, sale.reveal_mode === "CommitReveal", this.log.list(saleId)) : null;
  }

  /** See near/views.ts `eventsFromViews` for how the timeline is derived and what each row's `source` means. */
  async getEvents(id: string): Promise<SaleEvent[]> {
    const sale = await this.saleView(id);
    if (!sale) return [];
    const final = sale.status === "settled" || sale.status === "failed";
    const [bids, result, fills] = await Promise.all([
      this.bidViews(id),
      this.resultView(id),
      final ? this.fillViews(id) : Promise.resolve([]),
    ]);
    return eventsFromViews(sale, bids, result, fills, this.log.list(id));
  }

  /**
   * NEAR claim_proceeds would return to the creator now (get_reserve_refund):
   * 0 once returned or when there is none. Undefined when the view could not
   * be read; the result then shows the contract's own flag for the reserve.
   */
  private reserveRefund(saleId: string): Promise<bigint | undefined> {
    return this.cached(`reserve:${saleId}`, () =>
      this.view<string>("get_reserve_refund", { sale_id: saleId }).then(
        (v) => BigInt(v),
        () => undefined,
      ),
    );
  }

  async getResult(id: string): Promise<SaleResult | null> {
    const sale = await this.saleView(id);
    if (!sale || (sale.status !== "settled" && sale.status !== "failed")) return null;
    const [bids, result, fills, reserve] = await Promise.all([
      this.bidViews(id),
      this.resultView(id),
      this.fillViews(id),
      this.reserveRefund(id),
    ]);
    return result ? resultFromViews(sale, bids, result, fills, this.log.list(id), reserve) : null;
  }

  /**
   * USDC balance of `account`. `tokens` holds the balance of each sale token
   * named in `saleIds` (none by default: one view call per sale).
   */
  async getBalances(account: string, saleIds: string[] = []): Promise<Balances> {
    const balance = (token: string) =>
      this.cached(`ft:${token}:${account}`, () =>
        this.rpc.view<string>(token, "ft_balance_of", { account_id: account }).then(
          (v) => BigInt(v ?? "0"),
          // The token account does not exist yet (sale in setup) or the node refused: no balance to show.
          () => 0n,
        ),
      );
    const [usdc, ...tokens] = await Promise.all([
      this.cached(`ft:${this.usdcContract}:${account}`, async () =>
        BigInt((await this.rpc.view<string>(this.usdcContract, "ft_balance_of", { account_id: account })) ?? "0"),
      ),
      ...saleIds.map((id) => balance(`${id}.${this.contractId}`)),
    ]);
    return { account, usdc, tokens: Object.fromEntries(saleIds.map((id, i) => [id, tokens[i]])) };
  }

  expectedCodeHash(): string {
    return this.config.expectedCodeHash ?? "";
  }

  /**
   * What the contract's views hold about the enclave run. No TDX quote is
   * fetched and the nonce is not used (`nonce` and `quote` come back ""): the
   * code hash is the one pinned in the contract at deploy, the public key the
   * one the contract stored from the attested key call, and the two hashes
   * are the sha256 of the clearing input and of the sealer's output as the
   * contract received them, which equal OutLayer's attestation `input_hash`
   * and `output_hash` for the run.
   */
  async getAttestation(saleId: string, nonce: string): Promise<Attestation> {
    void nonce;
    const [sale, result] = await Promise.all([this.requireSaleView(saleId), this.resultView(saleId)]);
    return {
      nonce: "",
      codeHash: sale.sealer_code_hash,
      reportedPubkey: sale.sealer_pubkey ?? "",
      inputHash: result?.input_sha256 ?? "",
      outputHash: result?.result_sha256 ?? "",
      quote: "",
      fetchedAt: Date.now(),
      url: "https://outlayer.fastnear.com/",
      simulated: false,
      source: "chain",
    };
  }

  /**
   * GET /policy, reused for 15 seconds. Null when there is no relayer or it
   * did not answer (the relayer client already tried three times); a failure
   * is not kept, so the next call asks again.
   */
  getRelayerPolicy(): Promise<RelayerPolicyInfo | null> {
    if (!this.relayer) return Promise.resolve(null);
    const now = Date.now();
    if (this.policy && now - this.policy.at < POLICY_TTL_MS) return this.policy.value;
    const value: Promise<RelayerPolicyInfo | null> = this.relayer.getPolicy().then(
      (p) => ({
        relayerAccountId: p.relayer_account_id,
        methods: p.fairground_methods,
        usdcContracts: p.usdc_contracts,
        simulated: false,
      }),
      () => {
        if (this.policy?.value === value) this.policy = null;
        return null;
      },
    );
    this.policy = { at: now, value };
    return value;
  }

  // ---------- signing and sending ----------

  private signer(accountId: string): ActionSigner {
    const signer = this.signers.signerFor(accountId);
    if (!signer) {
      throw new FairgroundError("not_connected", `Connect the wallet of ${accountId} to sign this.`);
    }
    return signer;
  }

  /** The account that signs a call anyone may push: the named caller, else `preferred` if its wallet is connected, else the connected account. */
  private pusher(preferred: string, opts?: WriteOptions): string {
    if (opts?.caller) return opts.caller;
    if (this.signers.signerFor(preferred)) return preferred;
    const active = this.signers.activeAccount();
    if (!active) throw new FairgroundError("not_connected", "Connect a wallet to sign this.");
    return active;
  }

  /**
   * Signs and sends one call. `relay`: try the relayer first and fall back to
   * a paid transaction only when that cannot double a relayed one (see the
   * file comment). Throws a FairgroundError; one with `maybeSubmitted` set
   * carries `relay` so the caller can poll the chain and still report how the
   * call was sent.
   */
  private async submit(
    action: FairgroundAction,
    signerId: string,
    opts: WriteOptions | undefined,
    relay: boolean,
  ): Promise<Submitted> {
    const raw = this.signer(signerId);
    let paidReason: PaidReason | null = null;
    let userPays = !relay;
    let requestId: string | null = null;
    const pending = (): RelayInfo => ({
      paidBy: userPays ? "user" : "relayer",
      fallbackReason: paidReason,
      txHash: null,
      status: "pending",
      requestId,
      simulated: false,
    });
    const signer: ActionSigner = {
      signsDelegates: raw.signsDelegates,
      signDelegate: async (a) => {
        try {
          return await raw.signDelegate(a);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          throw new FairgroundError("wallet_error", `The wallet did not sign: ${message}. Nothing was sent.`, { cause: e });
        }
      },
      sendTransaction: async (a) => {
        try {
          return await raw.sendTransaction(a);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (looksLikeRejection(message)) {
            throw new FairgroundError("wallet_error", `The wallet did not sign: ${message}. Nothing was sent.`, { cause: e });
          }
          // The wallet may have broadcast before it failed.
          throw new FairgroundError(
            "maybe_submitted",
            `The wallet did not confirm the transaction (${message}). It may still land: check before sending it again.`,
            { maybeSubmitted: true, relay: pending(), cause: e },
          );
        }
      },
    };
    const onPaidFallback = async (reason: PaidReason) => {
      paidReason = reason;
      userPays = true;
      this.notify({ kind: "paid_fallback", reason, message: PAID_REASON_MESSAGES[reason] });
      try {
        await opts?.onPaidFallback?.(reason);
      } catch (e) {
        throw new FairgroundError("cancelled", "Stopped before the paid transaction. Nothing was sent.", {
          reason,
          cause: e,
        });
      }
    };
    const pay = async (reason: PaidReason | null): Promise<Submitted> => {
      if (reason) await onPaidFallback(reason);
      const outcome = await signer.sendTransaction(action);
      return { paidBy: "user", fallbackReason: reason, ...summarizeOutcome(outcome, this.contractId) };
    };
    const refused = (e: RelayerError): FairgroundError => {
      requestId = e.requestId;
      return e.maybeSubmitted
        ? new FairgroundError("maybe_submitted", relayerRefusalMessage(e.reason), {
            reason: e.reason,
            maybeSubmitted: true,
            requestId,
            relay: pending(),
            cause: e,
          })
        : new FairgroundError("relayer_refused", relayerRefusalMessage(e.reason), {
            reason: e.reason,
            requestId,
            cause: e,
          });
    };

    try {
      if (!relay) return await pay(null);
      if (!this.relayer) return await pay("no_relayer");
      if (raw.signsDelegates) {
        // Asked before anything is signed, so paying instead cannot double a
        // relayed call: a relayer that cannot be reached, or that does not pay
        // for this call, would only cost a signature and then leave the call
        // in doubt (a failed POST /relay may or may not have landed).
        const policy = await this.getRelayerPolicy();
        if (!policy) return await pay("relay_failed");
        const relayed =
          action.receiverId === this.contractId
            ? policy.methods.includes(action.methodName)
            : policy.usdcContracts.includes(action.receiverId);
        if (!relayed) return await pay("method_not_relayed");
      }
      try {
        return await submitAction(action, {
          signer,
          relayer: this.relayer,
          fairgroundContract: this.contractId,
          onPaidFallback,
        });
      } catch (e) {
        // A relayer that does not pay for this method says so before sending anything.
        if (e instanceof RelayerError && e.reason === "method_not_allowed" && !e.maybeSubmitted) {
          return await pay("method_not_relayed");
        }
        throw e;
      }
    } catch (e) {
      if (e instanceof FairgroundError) throw e;
      if (e instanceof RelayerError) throw refused(e);
      const message = e instanceof Error ? e.message : String(e);
      throw new FairgroundError("wallet_error", message, { cause: e });
    }
  }

  private async pollUntil(check: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      try {
        if (await check()) return true;
      } catch {
        // An RPC hiccup while polling: try again until the deadline.
      }
      if (Date.now() >= deadline) return false;
      await sleep(this.pollMs);
    }
  }

  /**
   * Sends a call and settles what happened to it. `confirm` reads the chain
   * for the call's effect; it decides when the outcome is unknown (a pending
   * answer, a lost one). Returns only for a call that took effect; a failed
   * receipt throws "tx_failed" with the contract's message.
   */
  private async send(
    action: FairgroundAction,
    signerId: string,
    opts: WriteOptions | undefined,
    relay: boolean,
    confirm: () => Promise<boolean>,
  ): Promise<Sent> {
    let result: Submitted;
    try {
      result = await this.submit(action, signerId, opts, relay);
    } catch (e) {
      if (e instanceof FairgroundError && e.maybeSubmitted && e.relay) {
        // No answer: the chain decides. Never send again from here.
        if (await this.pollUntil(confirm)) {
          this.changed();
          return { relay: { ...e.relay, status: "succeeded" }, events: [] };
        }
      }
      throw e;
    }
    const relayInfo: RelayInfo = {
      paidBy: result.paidBy,
      fallbackReason: result.fallbackReason,
      txHash: result.txHash,
      status: result.status,
      requestId: null,
      simulated: false,
    };
    if (result.status === "failed") {
      this.changed();
      const text = contractMessage(failureText(result.failures[0]?.error));
      throw new FairgroundError("tx_failed", `The transaction failed: ${text}`, { relay: relayInfo });
    }
    if (result.status === "pending") {
      if (!(await this.pollUntil(confirm))) {
        throw new FairgroundError(
          "maybe_submitted",
          "The transaction was sent but its result is not known yet. It may still land: do not send it again. This page shows it once it does.",
          { maybeSubmitted: true, relay: relayInfo },
        );
      }
      relayInfo.status = "succeeded";
    }
    this.changed();
    return { relay: relayInfo, events: result.events };
  }

  /** A wallet transaction with a deposit or to another contract: never relayed. */
  private walletCall(
    receiverId: string,
    methodName: string,
    args: Record<string, unknown>,
    gas: bigint,
    deposit: bigint,
  ): FairgroundAction {
    return { receiverId, methodName, args, gas, deposit };
  }

  /** Builds an action with the relayer client's builders; their RangeErrors are input errors. */
  private build(make: () => FairgroundAction): FairgroundAction {
    try {
      return make();
    } catch (e) {
      throw invalid(e instanceof Error ? e.message : String(e));
    }
  }

  // ---------- create ----------

  /** The config with its window moved so bid_start is at least `leadMs` after the chain's clock, and the sale id. */
  private async prepareCreate(config: SaleConfig, opts: CreateOptions) {
    const saleId = opts.saleId ?? config.tokenSymbol.toLowerCase();
    const idError = saleIdError(saleId, this.contractId);
    if (idError) throw invalid(idError);
    const lead = opts.minStartLeadMs ?? 120_000;
    const now = Math.max(await this.rpc.headTimeMs(), Date.now());
    const shift = Math.max(0, now + lead - config.bidStart);
    const timed = shift > 0 ? { ...config, bidStart: config.bidStart + shift, bidEnd: config.bidEnd + shift } : config;
    return { saleId, config: timed };
  }

  private async createCost(params: Record<string, unknown>): Promise<bigint> {
    try {
      return BigInt(await this.view<string>("get_create_cost", { params }));
    } catch (e) {
      // The view validates like create_sale: its refusal is an input error.
      if (e instanceof FairgroundError && e.reason === "view_failed") throw invalid(contractMessage(e.message));
      throw e;
    }
  }

  async getCreateCost(creator: string, config: SaleConfig, meta: SaleMeta, opts: CreateOptions = {}): Promise<bigint> {
    void creator;
    const prepared = await this.prepareCreate(config, opts);
    return this.createCost(createSaleParams(prepared.saleId, prepared.config, meta));
  }

  async createSale(creator: string, config: SaleConfig, meta: SaleMeta, opts: CreateOptions = {}): Promise<Sale> {
    const prepared = await this.prepareCreate(config, opts);
    const { saleId } = prepared;
    if (await this.freshSaleView(saleId)) throw invalid("a sale with this id already exists");
    const params = createSaleParams(saleId, prepared.config, meta);
    const cost = await this.createCost(params);
    const exists = async () => (await this.freshSaleView(saleId)) !== null;
    const sent = await this.send(
      this.walletCall(this.contractId, "create_sale", { params }, WALLET_GAS.create_sale, cost),
      creator,
      undefined,
      false,
      exists,
    );
    this.log.add({ saleId, kind: "created", at: Date.now(), account: creator, txHash: sent.relay.txHash ?? "" });
    // The sale record is written by create_sale itself; a lagging node may need a moment.
    await this.pollUntil(exists);
    const sale = await this.getSale(saleId);
    if (!sale) {
      throw new FairgroundError("rpc_error", "The sale was created but the RPC node does not show it yet. Reload in a moment.", {
        txHash: sent.relay.txHash,
      });
    }
    return sale;
  }

  async retrySetup(saleId: string, caller: string, opts: { deposit?: bigint } = {}): Promise<Sale> {
    const sale = await this.freshSaleView(saleId);
    if (!sale) throw invalid("There is no sale with this id.", "unknown_sale");
    const deposit = retrySetupDeposit(sale, opts.deposit);
    const steps = (v: SaleView | null) => `${v?.status}/${v?.token_setup}/${v?.sealer_key_setup}`;
    await this.send(
      this.walletCall(this.contractId, "retry_setup", { sale_id: saleId }, WALLET_GAS.retry_setup, deposit),
      caller,
      undefined,
      false,
      async () => steps(await this.freshSaleView(saleId)) !== steps(sale),
    );
    return (await this.getSale(saleId))!;
  }

  // ---------- bid ----------

  placeBid(saleId: string, bidder: string, deposit: bigint, ciphertext: string, opts?: WriteOptions): Promise<BidResult> {
    return this.placeBidPayload(saleId, bidder, deposit, { ciphertext }, opts);
  }

  async placeBidPayload(
    saleId: string,
    bidder: string,
    deposit: bigint,
    payload: BidPayload,
    opts?: WriteOptions,
  ): Promise<BidResult> {
    const sale = await this.requireSaleView(saleId);
    const commitReveal = sale.reveal_mode === "CommitReveal";
    // What the contract would return the deposit for, checked before anyone signs.
    const refuse = (reason: keyof typeof BID_REJECT_MESSAGES, detail?: string): never => {
      throw invalid(detail ?? BID_REJECT_MESSAGES[reason], reason);
    };
    if (sale.status !== "open") {
      refuse(
        "not_open",
        sale.status === "upcoming" || sale.status === "setup" ? "The bid window has not opened yet." : "The bid window is closed.",
      );
    }
    const isCiphertext = "ciphertext" in payload;
    if (isCiphertext === commitReveal) refuse("wrong_payload");
    const problem = isCiphertext
      ? ciphertextProblem(payload.ciphertext, saleId, bidder)
      : commitmentProblem(payload.commitment);
    if (problem) refuse(problem);
    if (deposit < BigInt(sale.min_deposit)) refuse("below_min_deposit");
    if (deposit > BigInt(sale.max_deposit_per_account)) refuse("above_max_deposit");
    if (await this.freshBidView(saleId, bidder)) refuse("already_bid");
    if (sale.bid_count >= sale.max_bids) refuse("sale_full");

    const action = this.build(() =>
      bidAction(
        sale.quote_token,
        this.contractId,
        saleId,
        deposit,
        isCiphertext ? { ciphertext: payload.ciphertext, bidder } : { commitment: payload.commitment },
      ),
    );
    const placed = async () => (await this.freshBidView(saleId, bidder)) !== null;
    const sent = await this.send(action, bidder, opts, true, placed);
    let outcome = bidOutcome(sent.events);
    if (outcome.kind === "unknown") {
      // No Fairground event in hand (a pending answer, or a wallet that returned no outcome): the bid book decides.
      outcome = (await this.pollUntil(placed)) ? { kind: "placed" } : outcome;
    }
    if (outcome.kind === "rejected") {
      const error = bidRejected(outcome.reason, undefined, sent.relay);
      this.log.add({
        saleId,
        kind: "bid_rejected",
        at: Date.now(),
        account: bidder,
        amount: deposit.toString(),
        txHash: sent.relay.txHash ?? "",
        note: `Deposit returned: ${error.message.replace(/ Your deposit was returned\.$/, "")}`,
        ...(Object.hasOwn(BID_REJECT_MESSAGES, outcome.reason)
          ? { reason: outcome.reason as keyof typeof BID_REJECT_MESSAGES }
          : {}),
      });
      this.changed();
      throw error;
    }
    if (outcome.kind === "unknown") {
      throw new FairgroundError(
        "maybe_submitted",
        "The transaction went through but the bid is not in the sale yet. It may still land: do not send it again.",
        { maybeSubmitted: true, relay: sent.relay },
      );
    }
    this.log.add({
      saleId,
      kind: "bid",
      at: Date.now(),
      account: bidder,
      amount: deposit.toString(),
      txHash: sent.relay.txHash ?? "",
    });
    this.changed();
    const record = await this.freshBidView(saleId, bidder);
    if (!record) {
      throw new FairgroundError("rpc_error", "The bid was placed but the RPC node does not show it yet. Reload in a moment.", {
        relay: sent.relay,
      });
    }
    return { ...bidFromView(saleId, record, commitReveal, this.log.list(saleId)), relay: sent.relay };
  }

  async bid(saleId: string, bidder: string, deposit: bigint, terms: BidTerms, opts?: WriteOptions): Promise<BidResult> {
    const sale = await this.requireSaleView(saleId);
    const problem = bidTermsProblem(terms, deposit, BigInt(sale.floor_price));
    if (problem) throw invalid(`${problem} Such a bid would be void and lose 1 % of its deposit.`);
    const salt = randomHex(16);
    if (sale.reveal_mode === "Tee") {
      if (!sale.sealer_pubkey) throw invalid("This sale has no sale key yet: its setup is not finished.", "not_open");
      const ciphertext = await sealBid(sale.sealer_pubkey, {
        sale_id: saleId,
        bidder,
        max_price: terms.maxPrice.toString(),
        max_spend: terms.maxSpend.toString(),
        salt,
      });
      return this.placeBidPayload(saleId, bidder, deposit, { ciphertext }, opts);
    }
    const commitment = bidCommitment({ saleId, bidder, maxPrice: terms.maxPrice, maxSpend: terms.maxSpend, salt });
    // One bid per account: never replace the secret of a bid that is already on chain.
    if (await this.freshBidView(saleId, bidder)) throw invalid(BID_REJECT_MESSAGES.already_bid, "already_bid");
    // Saved before the bid is sent, so a bid that lands can always be revealed.
    saveBidSecret({
      contract: this.secretsScope,
      saleId,
      bidder,
      maxPrice: terms.maxPrice.toString(),
      maxSpend: terms.maxSpend.toString(),
      salt,
      commitment,
      deposit: deposit.toString(),
      savedAt: Date.now(),
    });
    const placed = await this.placeBidPayload(saleId, bidder, deposit, { commitment }, opts);
    return { ...placed, secret: { salt, commitment } };
  }

  // ---------- close, reveal, clear ----------

  async getCloseDeposit(saleId: string): Promise<bigint> {
    try {
      return BigInt(await this.view<string>("get_close_deposit", { sale_id: saleId }));
    } catch (e) {
      if (e instanceof FairgroundError && e.reason === "view_failed") throw invalid(contractMessage(e.message));
      throw e;
    }
  }

  async closeSale(saleId: string, caller: string): Promise<Sale> {
    const before = await this.freshSaleView(saleId);
    if (!before) throw invalid("There is no sale with this id.", "unknown_sale");
    if (before.status !== "awaiting_close" && before.status !== "closed") {
      throw invalid(
        before.status === "open" || before.status === "upcoming" || before.status === "setup"
          ? "The bid window has not ended yet."
          : `Cannot close the sale: the sale is ${say(before.status)}.`,
        "wrong_phase",
      );
    }
    const deposit = await this.getCloseDeposit(saleId);
    const sent = await this.send(
      this.walletCall(this.contractId, "close_sale", { sale_id: saleId }, WALLET_GAS.close_sale, deposit),
      caller,
      undefined,
      false,
      async () => {
        const now = await this.freshSaleView(saleId);
        return !!now && now.status !== before.status;
      },
    );
    this.log.add({ saleId, kind: "closed", at: Date.now(), account: caller, txHash: sent.relay.txHash ?? "" });
    return (await this.getSale(saleId))!;
  }

  async revealBid(saleId: string, bidder: string, reveal?: RevealTerms, opts?: WriteOptions): Promise<WriteResult> {
    const [sale, bid] = await Promise.all([this.requireSaleView(saleId), this.freshBidView(saleId, bidder)]);
    if (sale.status !== "revealing") throw invalid(`Cannot reveal a bid: the sale is ${say(sale.status)}.`, "wrong_phase");
    if (!bid) throw invalid("No bid from this account in this sale.", "no_bid");
    if (bid.revealed) throw invalid("This bid has been revealed already.", "already_revealed");
    const secret = getBidSecret(this.secretsScope, saleId, bidder);
    const terms: RevealTerms | null =
      reveal ??
      (secret ? { maxPrice: BigInt(secret.maxPrice), maxSpend: BigInt(secret.maxSpend), salt: secret.salt } : null);
    if (!terms) {
      throw invalid(
        "The salt for this bid is not saved in this browser. Import your bid secrets file, or enter the price, spend and salt you committed to.",
        "missing_secret",
      );
    }
    if (!/^[0-9a-fA-F]{32}$/.test(terms.salt)) throw invalid("salt must be 32 hex characters");
    // Checked here so a wrong salt costs no signature (the contract would refuse it).
    if (bidCommitment({ saleId, bidder, ...terms }) !== commitmentHexOf(bid.payload)) {
      throw invalid("The reveal does not match your commitment. Use the salt saved when you bid.", "commitment_mismatch");
    }
    const action = this.build(() => revealAction(this.contractId, saleId, terms));
    const sent = await this.send(action, bidder, opts, true, async () => !!(await this.freshBidView(saleId, bidder))?.revealed);
    this.log.add({
      saleId,
      kind: "bid",
      detail: "bid_revealed",
      at: Date.now(),
      account: bidder,
      txHash: sent.relay.txHash ?? "",
    });
    return { txHash: sent.relay.txHash ?? "", relay: sent.relay };
  }

  private isFinal = async (saleId: string) => {
    const now = await this.freshSaleView(saleId);
    return !!now && (now.status === "settled" || now.status === "failed");
  };

  async clearOnchain(saleId: string, caller: string, opts?: WriteOptions): Promise<SaleWithRelay> {
    const sale = await this.requireSaleView(saleId);
    if (sale.status !== "revealing") throw invalid(`Cannot clear on chain: the sale is ${say(sale.status)}.`, "wrong_phase");
    const action = this.build(() => clearOnchainAction(this.contractId, saleId));
    const sent = await this.send(action, caller, opts, true, () => this.isFinal(saleId));
    const after = (await this.getSale(saleId))!;
    this.log.add({
      saleId,
      kind: after.status === "settled" ? "settled" : "failed",
      at: Date.now(),
      account: caller,
      txHash: sent.relay.txHash ?? "",
    });
    return { ...after, relay: sent.relay };
  }

  async triggerRefundMode(saleId: string, caller: string, opts?: WriteOptions): Promise<SaleWithRelay> {
    const sale = await this.requireSaleView(saleId);
    if (sale.refund_mode_at === null) {
      throw invalid(`Cannot trigger refund mode: the sale is ${say(sale.status)}.`, "wrong_phase");
    }
    const action = this.build(() => triggerRefundModeAction(this.contractId, saleId));
    const sent = await this.send(action, caller, opts, true, () => this.isFinal(saleId));
    this.log.add({ saleId, kind: "refund_mode", at: Date.now(), account: caller, txHash: sent.relay.txHash ?? "" });
    return { ...(await this.getSale(saleId))!, relay: sent.relay };
  }

  // ---------- claims ----------

  async claim(saleId: string, bidder: string, opts?: WriteOptions): Promise<ClaimResult> {
    const [sale, bid] = await Promise.all([this.requireSaleView(saleId), this.freshBidView(saleId, bidder)]);
    if (sale.status !== "settled" && sale.status !== "failed") {
      throw invalid(`Cannot claim: the sale is ${say(sale.status)}.`, "wrong_phase");
    }
    if (!bid) throw invalid("No bid from this account in this sale.", "no_bid");
    if (bid.claimed) throw invalid("Already claimed.", "already_claimed");
    const action = this.build(() => claimAction(this.contractId, saleId, bidder));
    const sent = await this.send(action, this.pusher(bidder, opts), opts, true, async () => {
      return !!(await this.freshBidView(saleId, bidder))?.claimed;
    });
    // What was paid: the contract's `claimed` event when in hand, else the bid's fill.
    const event = sent.events.find((e) => e.event === "claimed")?.data as { tokens?: string; refund?: string } | undefined;
    let tokens = event?.tokens !== undefined ? BigInt(event.tokens) : null;
    let refund = event?.refund !== undefined ? BigInt(event.refund) : null;
    if (tokens === null || refund === null) {
      const [fill] = await this.view<FillView[]>("get_fills", { sale_id: saleId, from_index: bid.index, limit: 1 });
      tokens = BigInt(fill?.tokens ?? "0");
      refund = BigInt(fill?.refund ?? "0");
    }
    const txHash = sent.relay.txHash ?? "";
    this.log.add({ saleId, kind: "claimed", at: Date.now(), account: bidder, amount: refund.toString(), txHash });
    return { saleId, bidder, tokens, refund, txHash, relay: sent.relay };
  }

  async claimProceeds(saleId: string, caller: string, opts?: WriteOptions): Promise<WriteResult> {
    const sale = await this.requireSaleView(saleId);
    if (sale.status !== "settled" && sale.status !== "failed") {
      throw invalid(`Cannot claim proceeds: the sale is ${say(sale.status)}.`, "wrong_phase");
    }
    const freshResult = () => this.view<ResultView | null>("get_result", { sale_id: saleId });
    const [before, reserve] = await Promise.all([
      freshResult(),
      this.view<string>("get_reserve_refund", { sale_id: saleId }).then((v) => BigInt(v)),
    ]);
    // The contract's flags alone cannot say this: a part that was never owed (nothing
    // to burn on a sold-out sale, no raise on a failed one) keeps its flag false for good.
    const left = before ? proceedsLeft(sale, before, reserve) : null;
    if (left && !left.raise && !left.allocation && !left.burn && !left.reserve) {
      throw invalid("The creator's proceeds were already paid.", "already_claimed");
    }
    const flags = (r: ResultView | null) => JSON.stringify(r?.proceeds ?? null);
    const action = this.build(() => claimProceedsAction(this.contractId, saleId));
    const sent = await this.send(action, caller, opts, true, async () => flags(await freshResult()) !== flags(before));
    const txHash = sent.relay.txHash ?? "";
    this.log.add({
      saleId,
      kind: "claimed",
      detail: "proceeds_claimed",
      at: Date.now(),
      account: sale.creator,
      txHash,
    });
    return { txHash, relay: sent.relay };
  }

  // ---------- USDC: storage and the test faucet ----------

  private usdcRegistered = async (account: string): Promise<boolean> =>
    (await this.rpc.view<unknown>(this.usdcContract, "storage_balance_of", { account_id: account })) !== null;

  /**
   * Registers `account` on USDC (NEP-145) if it is not, so USDC can be
   * delivered to it. The relayer pays when it can; when its storage budget is
   * used up for the day (or there is no relayer) the connected wallet pays the
   * one-time 0.00125 NEAR itself, after `onPaidFallback`.
   */
  async ensureUsdcStorage(account: string, opts?: WriteOptions): Promise<StorageResult> {
    const registered = () => this.usdcRegistered(account);
    if (await registered()) return { status: "already_registered", txHash: null };

    let reason: PaidReason = "no_relayer";
    if (this.relayer) {
      try {
        const r = await this.relayer.sponsorStorage(account, this.usdcContract);
        if (r.status === "already_registered") return { status: "already_registered", txHash: null };
        // "registered", or "pending" while the registration lands.
        await this.pollUntil(registered);
        this.notify({ kind: "storage_sponsored", message: "The relayer registered your account for USDC. This cost you nothing." });
        this.changed();
        return { status: "sponsored", txHash: r.tx_hash ?? null };
      } catch (e) {
        if (!(e instanceof RelayerError)) {
          throw new FairgroundError("rpc_error", e instanceof Error ? e.message : String(e), { cause: e });
        }
        if (e.maybeSubmitted) {
          // No answer: the registration may be on its way.
          if (await this.pollUntil(registered)) return { status: "sponsored", txHash: null };
          throw new FairgroundError("maybe_submitted", relayerRefusalMessage(e.reason), {
            reason: e.reason,
            maybeSubmitted: true,
            requestId: e.requestId,
          });
        }
        if (e.reason === "rate_limited") {
          // The relayer answers this while an earlier registration of the account is still landing.
          if (await this.pollUntil(registered)) return { status: "already_registered", txHash: null };
          reason = "rate_limited";
        } else if (e.reason === "budget_exhausted" || e.reason === "relay_failed") {
          reason = e.reason;
        } else if (e.reason === "unknown_token") {
          reason = "method_not_relayed";
        } else {
          throw new FairgroundError("relayer_refused", relayerRefusalMessage(e.reason), {
            reason: e.reason,
            requestId: e.requestId,
          });
        }
      }
    }

    const message =
      reason === "budget_exhausted"
        ? "The relayer's storage budget for today is used up, so your wallet will ask you to pay the one-time 0.00125 NEAR that lets your account hold USDC."
        : "Your wallet will ask you to pay the one-time 0.00125 NEAR that lets your account hold USDC.";
    this.notify({ kind: "storage_paid", reason, message });
    try {
      await opts?.onPaidFallback?.(reason);
    } catch (e) {
      throw new FairgroundError("cancelled", "Stopped before the storage payment. Nothing was sent.", { reason, cause: e });
    }
    const sent = await this.send(
      this.walletCall(
        this.usdcContract,
        "storage_deposit",
        { account_id: account, registration_only: true },
        WALLET_GAS.storage_deposit,
        TOKEN_STORAGE_DEPOSIT,
      ),
      this.pusher(account, opts),
      undefined,
      false,
      registered,
    );
    return { status: "paid", txHash: sent.relay.txHash };
  }

  /**
   * Test USDC from the token's open `mint` (usdc.fakes.testnet, or mock-ft on
   * a sandbox): a wallet transaction signed by the connected account. Not on
   * mainnet. With `key`, a second call with the same key mints nothing
   * (remembered in this browser).
   */
  async faucet(account: string, amount: bigint, opts: { key?: string } = {}): Promise<Balances> {
    if (!this.capabilities.faucet) {
      throw new FairgroundError("not_supported", "There is no test USDC faucet on mainnet.");
    }
    const usedKey = opts.key ? `fairground:faucet:${this.usdcContract}:${opts.key}` : null;
    const used = () => {
      try {
        return usedKey !== null && localStorage.getItem(usedKey) !== null;
      } catch {
        return false;
      }
    };
    if (!used()) {
      await this.ensureUsdcStorage(account);
      const before = (await this.getBalances(account)).usdc;
      await this.send(
        this.walletCall(this.usdcContract, "mint", { account_id: account, amount: amount.toString() }, WALLET_GAS.mint, 0n),
        this.pusher(account),
        undefined,
        false,
        async () =>
          BigInt((await this.rpc.view<string>(this.usdcContract, "ft_balance_of", { account_id: account })) ?? "0") > before,
      );
      try {
        if (usedKey) localStorage.setItem(usedKey, "1");
      } catch {
        // no storage: the key is not remembered
      }
    }
    this.cache.clear();
    return this.getBalances(account);
  }

  // ---------- not on a real chain ----------

  async runJudgeMode(opts: { onProgress: (p: JudgeProgress) => void; windowSeconds?: number }): Promise<string> {
    void opts;
    throw new FairgroundError("not_supported", "Judge mode runs on the simulated chain only.");
  }

  async reset(): Promise<void> {
    throw new FairgroundError("not_supported", "A real chain cannot be reset.");
  }
}
