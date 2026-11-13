/**
 * The relayer's HTTP surface as a Hono app. `app.fetch` is a plain Fetch API
 * handler, so the same app runs under @hono/node-server, as a Vercel Function or
 * inside a Next.js route handler.
 *
 * Privacy: request bodies carry sealed bids. They are parsed in memory, never
 * logged and never stored; the only state is the limits in `limiters`, the
 * day's spend in the budgets, and the senders and accounts with a transaction
 * in flight.
 *
 * Order of the checks: everything that costs nothing comes before any RPC call,
 * and a counter that can lock someone out is only touched once the request is
 * proven to come from that someone and the relayer is about to pay.
 */
import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { nearToYocto, teraToGas } from "near-api-js";
import type {
  ErrorResponse,
  HealthResponse,
  PolicyResponse,
  RejectionReason,
  RelayResponse,
  StorageResponse,
} from "./api.ts";
import { STORAGE_DEPOSIT_GAS, TransactionRefused, type Chain, type Head, type Submission } from "./chain.ts";
import { isAccountId, type RelayerConfig } from "./config.ts";
import { decodeSignedDelegate, hasValidSignature } from "./delegate.ts";
import { allow, type DailyNearBudget, type Limiters, type Reservation } from "./limits.ts";
import { describeError, type LogLine, type Logger } from "./log.ts";
import { relayerCost, summarizeOutcome } from "./outcome.ts";
import {
  BID_DEPOSIT,
  FAIRGROUND_METHODS,
  checkAccessKey,
  checkDelegate,
  checkValidity,
  needsSaleReservation,
  totalDeposit,
  totalGas,
} from "./policy.ts";
import { checkOnChain } from "./preflight.ts";

export interface AppDeps {
  config: Pick<RelayerConfig, "network" | "policy" | "limits" | "relayWaitMs" | "corsOrigins">;
  chain: Chain;
  limiters: Limiters;
  /** What relays may spend per UTC day. */
  budget: DailyNearBudget;
  /** What storage registrations may spend per UTC day: a budget of their own, so they cannot use up the one bids need. */
  storageBudget: DailyNearBudget;
  /** The caller's IP, or undefined when the host does not expose it (then all such callers share one bucket). */
  clientIp: (c: Context) => string | undefined;
  /** Turns an IP into an opaque counter key, so raw IPs are never stored. */
  hashIp: (ip: string) => string;
  log: Logger;
}

type Env = { Variables: { requestId: string; startedAt: number; account?: string } };
type Ctx = Context<Env>;

/** "Once" per account: a registration the user removes (storage_unregister refunds them) is not paid for again soon. */
const STORAGE_PER_ACCOUNT = 1;
/** A SignedDelegate carrying the largest bid (320-byte ciphertext, 64-character account ids) is about 1.3 KB of base64. */
const MAX_BODY_BYTES = 8 * 1024;
/**
 * Gas the relayer pays beyond what the inner calls attach: converting the outer
 * transaction and the delegate and function-call action fees (about 1 TGas in
 * sandbox runs). Reserved generously because the budget must never be overrun.
 */
const OVERHEAD_GAS = teraToGas(5);
/** Below this the relayer cannot buy 300 TGas at protocol 88's 1e9 yocto/gas floor. */
const EMPTY_BELOW = nearToYocto(0.5);
const LOW_BELOW = nearToYocto(5);
/** Under a block time, so the validity window is judged against a head at most a block old. */
const HEAD_CACHE_MS = 500;
/** /health is unauthenticated: one balance read per this period, however often it is asked. */
const BALANCE_CACHE_MS = 15_000;

export function createApp(deps: AppDeps): Hono<Env> {
  const { config, chain, limiters, budget, storageBudget, log } = deps;
  const { policy, limits } = config;
  /** Senders with a relay in flight: one at a time, so a replayed or reordered delegate cannot make the relayer pay twice. */
  const inFlight = new Set<string>();
  /** Creator payouts and pool steps can change the same sale across senders. */
  const salesInFlight = new Set<string>();
  const head = cached(() => chain.head(), HEAD_CACHE_MS);
  const relayerBalance = cached(() => chain.relayerBalance(), BALANCE_CACHE_MS);
  const app = new Hono<Env>();

  const logLine = (c: Ctx, line: Omit<LogLine, "request_id" | "endpoint" | "ms">) =>
    log({
      request_id: c.get("requestId"),
      endpoint: `${c.req.method} ${c.req.path}`,
      account: c.get("account"),
      ...line,
      ms: Date.now() - c.get("startedAt"),
    });

  const refuse = (c: Ctx, reason: RejectionReason): Response => {
    logLine(c, { decision: "rejected", reason });
    return c.json<ErrorResponse>({ error: reason, request_id: c.get("requestId") }, httpStatus(reason));
  };

  const ipKey = (c: Ctx) => deps.hashIp(deps.clientIp(c) ?? "unknown");
  const withinIpLimit = (c: Ctx) => allow(limiters.ip, ipKey(c), limits.requestsPerIpPerHour);

  /** Settles a budget with the actual cost once the outcome is known; an unknown outcome keeps the worst case. */
  const settleWhenDone = (submission: Submission, from: DailyNearBudget, reservation: Reservation, deposits: bigint) =>
    submission.done.then((outcome) => {
      if (outcome) from.settle(reservation, relayerCost(outcome, deposits));
    });

  app.use(async (c, next) => {
    const requestId = randomUUID();
    c.set("requestId", requestId);
    c.set("startedAt", Date.now());
    c.header("x-request-id", requestId);
    await next();
  });
  if (config.corsOrigins.length > 0) {
    app.use(
      cors({
        origin: config.corsOrigins,
        allowMethods: ["GET", "POST"],
        allowHeaders: ["content-type"],
        exposeHeaders: ["x-request-id"],
        maxAge: 600,
      }),
    );
  }
  app.use(bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => refuse(c, "body_too_large") }));

  app.onError((error, c) => {
    logLine(c, { decision: "error", reason: "internal_error", error: describeError(error) });
    return c.json<ErrorResponse>({ error: "internal_error", request_id: c.get("requestId") }, 500);
  });

  const policyView: PolicyResponse = {
    network: config.network,
    relayer_account_id: policy.relayerAccountId,
    fairground_contract: policy.fairgroundContract,
    fairground_methods: [...FAIRGROUND_METHODS],
    usdc_contracts: [...policy.usdcContracts],
    bid_deposit: BID_DEPOSIT.toString(),
    max_actions: policy.maxActions,
    max_gas: policy.maxGas.toString(),
    min_blocks_left: Number(policy.minBlocksLeft),
    max_delegate_blocks: Number(policy.maxDelegateBlocks),
    rate_limits: {
      relays_per_sender_per_hour: limits.relaysPerSenderPerHour,
      requests_per_ip_per_hour: limits.requestsPerIpPerHour,
      storage_per_ip_per_day: limits.storagePerIpPerDay,
      storage_per_account: STORAGE_PER_ACCOUNT,
    },
  };
  app.get("/policy", (c) => c.json(policyView));

  app.get("/health", async (c) => {
    const balance = await relayerBalance().then(balanceBucket, () => "unknown" as const);
    const exhausted = budget.exhausted;
    const ok = (balance === "ok" || balance === "low") && !exhausted;
    return c.json<HealthResponse>({ ok, network: config.network, balance, budget_exhausted: exhausted }, ok ? 200 : 503);
  });

  app.post("/relay", async (c) => {
    const encoded = (await readJsonObject(c))?.["signed_delegate"];
    if (typeof encoded !== "string") return refuse(c, "bad_request");
    if (!(await withinIpLimit(c))) return refuse(c, "rate_limited");

    // Free checks first: decoding, the signature, the static policy.
    const decoded = decodeSignedDelegate(encoded);
    if (!decoded.ok) return refuse(c, decoded.reason);
    const { delegate } = decoded;
    if (!hasValidSignature(delegate)) return refuse(c, "bad_signature");
    const allowed = checkDelegate(delegate, policy);
    if (!allowed.ok) return refuse(c, allowed.reason);

    const { senderId, publicKey } = delegate.delegateAction;
    const [current, accessKey] = await Promise.all([head(), chain.accessKey(senderId, publicKey)]);
    const keyProblem = checkValidity(delegate, policy, current.height) ?? checkAccessKey(delegate, accessKey);
    if (keyProblem) return refuse(c, keyProblem);
    // Only the sender's key holder gets here: anyone else's delegate (a forgery, a
    // replay) was refused above, so nothing they send can use up the sender's quota.
    c.set("account", senderId);
    if (inFlight.has(senderId)) return refuse(c, "sender_busy");
    const reservedSales = allowed.calls.flatMap((call) =>
      call.kind === "fairground" && needsSaleReservation(call.method) ? [call.saleId] : [],
    );
    if (reservedSales.some((saleId) => salesInFlight.has(saleId))) return refuse(c, "wrong_phase");

    inFlight.add(senderId);
    for (const saleId of reservedSales) salesInFlight.add(saleId);
    const release = () => {
      inFlight.delete(senderId);
      for (const saleId of reservedSales) salesInFlight.delete(saleId);
    };
    let sent = false;
    try {
      const callProblem = await checkOnChain(allowed.calls, {
        senderId,
        fairgroundContract: policy.fairgroundContract,
        nowNs: current.timestampNs,
        view: (contractId, method, args) => chain.view(contractId, method, args),
      });
      if (callProblem) return refuse(c, callProblem);
      if (!(await allow(limiters.sender, senderId, limits.relaysPerSenderPerHour))) return refuse(c, "rate_limited");

      const deposits = totalDeposit(delegate);
      const reservation = budget.reserve(worstCase(totalGas(delegate), current, deposits));
      if (!reservation) return refuse(c, "budget_exhausted");
      let submission: Submission;
      try {
        submission = await chain.relay(delegate, config.relayWaitMs);
      } catch (error) {
        // Chain.relay throws only when nothing was sent.
        budget.settle(reservation, 0n);
        if (error instanceof TransactionRefused) return refuse(c, "relay_failed");
        throw error;
      }
      sent = true;
      void settleWhenDone(submission, budget, reservation, deposits).finally(release);

      const { txHash, outcome } = submission;
      if (!outcome) {
        logLine(c, { decision: "relayed", tx_hash: txHash, status: "pending" });
        return c.json<RelayResponse>({ tx_hash: txHash, status: "pending", outcome: null }, 202);
      }
      const summary = summarizeOutcome(outcome, policy.fairgroundContract, deposits);
      const status = summary.failures.length === 0 ? "succeeded" : "failed";
      logLine(c, { decision: "relayed", tx_hash: txHash, status, cost: summary.relayer_cost });
      return c.json<RelayResponse>({ tx_hash: txHash, status, outcome: summary });
    } finally {
      if (!sent) release();
    }
  });

  app.post("/storage", async (c) => {
    const body = await readJsonObject(c);
    const accountId = body?.["account_id"];
    const tokenId = body?.["token_id"] ?? policy.usdcContracts[0];
    if (typeof accountId !== "string" || !isAccountId(accountId) || typeof tokenId !== "string") {
      return refuse(c, "bad_request");
    }
    c.set("account", accountId);
    if (!policy.usdcContracts.includes(tokenId)) return refuse(c, "unknown_token");
    if (!(await withinIpLimit(c))) return refuse(c, "rate_limited");
    if (!(await chain.accountExists(accountId))) return refuse(c, "unknown_account");
    if (await chain.isRegistered(tokenId, accountId)) {
      logLine(c, { decision: "already_registered" });
      return c.json<StorageResponse>({ status: "already_registered", token_id: tokenId });
    }

    // Each limit below is taken only once the ones before it passed, and given
    // back if nothing is sent, so a refusal never costs the account its
    // sponsorship. The per-IP quota cannot be given back, so it is taken last.
    const [minimum, current] = await Promise.all([chain.storageMinimum(tokenId), head()]);
    const reservation = storageBudget.reserve(worstCase(STORAGE_DEPOSIT_GAS, current, minimum));
    if (!reservation) return refuse(c, "budget_exhausted");
    // Claimed before sending, so a double click or a race cannot pay twice.
    const accountKey = `${tokenId}:${accountId}`;
    if (!(await limiters.sponsored.claim(accountKey))) {
      storageBudget.settle(reservation, 0n);
      return refuse(c, "rate_limited");
    }
    const unsent = async () => {
      storageBudget.settle(reservation, 0n);
      await limiters.sponsored.release(accountKey);
    };
    if (!(await allow(limiters.storageIp, ipKey(c), limits.storagePerIpPerDay))) {
      await unsent();
      return refuse(c, "rate_limited");
    }
    let submission: Submission;
    try {
      submission = await chain.registerStorage(tokenId, accountId, minimum, config.relayWaitMs);
    } catch (error) {
      await unsent(); // Chain.registerStorage throws only when nothing was sent
      if (error instanceof TransactionRefused) return refuse(c, "relay_failed");
      throw error;
    }
    void settleWhenDone(submission, storageBudget, reservation, minimum);

    const { txHash, outcome } = submission;
    if (!outcome) {
      logLine(c, { decision: "registered", tx_hash: txHash, status: "pending" });
      return c.json<StorageResponse>({ status: "pending", token_id: tokenId, tx_hash: txHash }, 202);
    }
    const summary = summarizeOutcome(outcome, policy.fairgroundContract, minimum);
    if (summary.failures.length > 0) {
      logLine(c, { decision: "error", reason: "relay_failed", tx_hash: txHash, status: "failed", cost: summary.relayer_cost });
      return c.json<ErrorResponse>({ error: "relay_failed", request_id: c.get("requestId") }, 502);
    }
    logLine(c, { decision: "registered", tx_hash: txHash, status: "succeeded", cost: summary.relayer_cost });
    return c.json<StorageResponse>({ status: "registered", token_id: tokenId, tx_hash: txHash });
  });

  return app;
}

/** What a transaction can cost at most: its gas at the head's price, the overhead, and the deposits. */
function worstCase(gas: bigint, current: Head, deposits: bigint): bigint {
  return (gas + OVERHEAD_GAS) * current.gasPrice + deposits;
}

/** Remembers `load`'s answer for `ttlMs` (a failure is forgotten at once), so a burst of requests shares one RPC call. */
function cached<T>(load: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let entry: { value: Promise<T>; until: number } | undefined;
  return () => {
    const now = Date.now();
    if (!entry || entry.until <= now) {
      const value = load();
      const current = { value, until: now + ttlMs };
      entry = current;
      value.catch(() => {
        if (entry === current) entry = undefined;
      });
    }
    return entry.value;
  };
}

function httpStatus(reason: RejectionReason) {
  switch (reason) {
    case "rate_limited":
      return 429;
    case "sender_busy":
      return 409;
    case "body_too_large":
      return 413;
    case "budget_exhausted":
      return 503;
    case "relay_failed":
      return 502;
    case "internal_error":
      return 500;
    default:
      return 400;
  }
}

function balanceBucket(balance: bigint): HealthResponse["balance"] {
  if (balance < EMPTY_BELOW) return "empty";
  return balance < LOW_BELOW ? "low" : "ok";
}

async function readJsonObject(c: Ctx): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
