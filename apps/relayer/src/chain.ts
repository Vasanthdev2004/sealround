/**
 * Everything the relayer reads from or sends to NEAR, behind one interface so
 * the HTTP layer does not depend on the RPC client.
 */
import { setTimeout as delay } from "node:timers/promises";
import {
  Account,
  KeyPairSigner,
  actions,
  baseEncode,
  teraToGas,
  type AccessKeyView,
  type Action,
  type KeyPair,
  type Provider,
  type PublicKey,
  type SignedDelegate,
  type Transaction,
} from "near-api-js";
import {
  AccessKeyDoesNotExistError,
  AccountDoesNotExistError,
  InvalidTransactionError,
  TransactionExecutionError,
} from "near-api-js/rpc-errors";

/** near-api-js 7.4.0 does not export RpcTransactionResponse, so take it from the method. */
export type TxOutcome = Awaited<ReturnType<Provider["viewTransactionStatus"]>>;

export interface Submission {
  txHash: string;
  /** The outcome if every receipt finished within the wait, else null. */
  outcome: TxOutcome | null;
  /** Settles with the final outcome, or null if it could not be learned. Never rejects; for late bookkeeping. */
  done: Promise<TxOutcome | null>;
}

/** The RPC refused the transaction before it was included, so nothing was spent. */
export class TransactionRefused extends Error {
  override name = "TransactionRefused";
}

export interface Head {
  height: bigint;
  gasPrice: bigint;
  timestampNs: bigint;
}

export interface Chain {
  head(): Promise<Head>;
  /** Undefined when the account or the key does not exist. */
  accessKey(accountId: string, publicKey: PublicKey): Promise<AccessKeyView | undefined>;
  accountExists(accountId: string): Promise<boolean>;
  relayerBalance(): Promise<bigint>;
  /** A contract view at the optimistic head. */
  view<T>(contractId: string, method: string, args: Record<string, unknown>): Promise<T>;
  isRegistered(tokenId: string, accountId: string): Promise<boolean>;
  /** NEP-145 `storage_balance_bounds().min`. */
  storageMinimum(tokenId: string): Promise<bigint>;
  /**
   * Sends `[SignedDelegate]` to the delegate's sender, signed by the relayer.
   * Throws only when nothing was sent: TransactionRefused if the RPC refused it,
   * any other error if it failed before the transaction was signed.
   */
  relay(delegate: SignedDelegate, waitMs: number): Promise<Submission>;
  /** The relayer's own `storage_deposit({account_id, registration_only: true})`, so any refund returns to the relayer. Throws like `relay`. */
  registerStorage(tokenId: string, accountId: string, deposit: bigint, waitMs: number): Promise<Submission>;
}

export const STORAGE_DEPOSIT_GAS = teraToGas(30);

const OPTIMISTIC = { finality: "optimistic" } as const;

export function nearChain(provider: Provider, relayerAccountId: string, relayerKey: KeyPair): Chain {
  // The signer is passed per transaction (see submit); the Account keeps the nonce cache for the key.
  const relayer = new Account(relayerAccountId, provider);

  /** The final outcome of a transaction the RPC has accepted, or null if it cannot be learned. */
  const outcomeOf = (txHash: string): Promise<TxOutcome | null> =>
    provider.viewTransactionStatus({ txHash, accountId: relayerAccountId, waitUntil: "EXECUTED_OPTIMISTIC" }).catch(() => null);

  /**
   * Signs and sends one transaction. The RPC answers once a block includes it,
   * so a transaction it refuses (NotEnoughBalance, a stale nonce, ShardCongested)
   * is reported before any hash is handed out; only then does the wait of
   * `waitMs` for the outcome start. Throws TransactionRefused if the RPC refused
   * it, rethrows errors raised before it was signed, and otherwise returns its
   * hash with the outcome or null.
   */
  async function submit(receiverId: string, txActions: Action[], waitMs: number): Promise<Submission> {
    let txHash: string | undefined;
    const signer = new HashRecordingSigner(relayerKey, (hash) => (txHash = hash));
    try {
      await relayer.signAndSendTransaction({
        receiverId,
        actions: txActions,
        signer,
        waitUntil: "INCLUDED",
        // A Delegate action returns no value, so a relayed transaction reports
        // SuccessValue("") even when the inner call fails. Callers read every receipt (outcome.ts).
        throwOnFailure: false,
        // One signature per submission, so the hash we hand out is the only one. On a
        // nonce clash near-api-js still resets its nonce cache before rethrowing.
        retries: 0,
      });
    } catch (error) {
      if (error instanceof InvalidTransactionError || error instanceof TransactionExecutionError) {
        throw new TransactionRefused(error.message);
      }
      if (txHash === undefined) throw error; // failed before signing: nothing was sent
      // Signed, but the RPC never confirmed it (a timeout, a lost answer): it may still land.
      return { txHash, outcome: null, done: outcomeOf(txHash) };
    }
    const hash = txHash as string; // signing ran before the send resolved
    const done = outcomeOf(hash);
    const outcome = await Promise.race([done, delay(waitMs, null, { ref: false })]);
    return { txHash: hash, outcome, done };
  }

  return {
    async head() {
      const { header } = await provider.viewBlock(OPTIMISTIC);
      return { height: BigInt(header.height), gasPrice: BigInt(header.gas_price), timestampNs: BigInt(header.timestamp_nanosec) };
    },

    async accessKey(accountId, publicKey) {
      try {
        return await provider.viewAccessKey({ accountId, publicKey, finalityQuery: OPTIMISTIC });
      } catch (error) {
        if (error instanceof AccessKeyDoesNotExistError || error instanceof AccountDoesNotExistError) return undefined;
        throw error;
      }
    },

    async accountExists(accountId) {
      try {
        await provider.viewAccount({ accountId, blockQuery: OPTIMISTIC });
        return true;
      } catch (error) {
        if (error instanceof AccountDoesNotExistError) return false;
        throw error;
      }
    },

    async relayerBalance() {
      return (await provider.viewAccount({ accountId: relayerAccountId, blockQuery: OPTIMISTIC })).amount;
    },

    async view<T>(contractId: string, method: string, args: Record<string, unknown>) {
      return (await provider.callFunction({ contractId, method, args, blockQuery: OPTIMISTIC })) as T;
    },

    async isRegistered(tokenId, accountId) {
      const balance = await provider.callFunction({
        contractId: tokenId,
        method: "storage_balance_of",
        args: { account_id: accountId },
        blockQuery: OPTIMISTIC,
      });
      return balance != null;
    },

    async storageMinimum(tokenId) {
      const bounds = await provider.callFunction<{ min?: unknown }>({
        contractId: tokenId,
        method: "storage_balance_bounds",
        args: {},
        blockQuery: OPTIMISTIC,
      });
      if (typeof bounds?.min !== "string") throw new Error(`${tokenId} returned no storage_balance_bounds.min`);
      return BigInt(bounds.min);
    },

    relay(delegate, waitMs) {
      return submit(delegate.delegateAction.senderId, [actions.signedDelegate(delegate)], waitMs);
    },

    registerStorage(tokenId, accountId, deposit, waitMs) {
      const args = { account_id: accountId, registration_only: true };
      return submit(tokenId, [actions.functionCall("storage_deposit", args, STORAGE_DEPOSIT_GAS, deposit)], waitMs);
    },
  };
}

/** The relayer's key, reporting each transaction's hash the moment it is signed, before the RPC answers. */
class HashRecordingSigner extends KeyPairSigner {
  private readonly onSigned: (txHash: string) => void;

  constructor(key: KeyPair, onSigned: (txHash: string) => void) {
    super(key);
    this.onSigned = onSigned;
  }

  override async signTransaction(transaction: Transaction) {
    const result = await super.signTransaction(transaction);
    this.onSigned(baseEncode(result.txHash));
    return result;
  }
}
