/**
 * Signers turn a FairgroundAction into something the chain accepts, in one of
 * two ways: a NEP-366 SignedDelegate for the relayer to submit and pay for, or a
 * normal transaction the signer pays for itself (the fallback).
 *
 * - `walletSigner`: a NEAR Connect wallet, in the browser app.
 * - `keyPairSigner`: a key held in memory, for tests, judge-mode bots and scripts.
 *
 * The delegate wire format is base64(borsh(SignedDelegate)): what NEAR Connect's
 * `signDelegateActions` returns and what POST /relay takes.
 */
import {
  Account,
  KeyPairSigner,
  actions,
  base64Encode,
  buildDelegateAction,
  encodeSignedDelegate,
  type Action,
  type KeyPair,
  type Provider,
} from "near-api-js";
import type { FairgroundAction } from "./actions";

export interface ActionSigner {
  /** False when only `sendTransaction` works: a wallet without NEP-366 support. */
  readonly signsDelegates: boolean;
  /** Signs `action` as a NEP-366 delegate and returns it as base64(borsh(SignedDelegate)), ready for POST /relay. */
  signDelegate(action: FairgroundAction): Promise<string>;
  /** Signs and sends `action` as a normal transaction; the signer pays the gas and any deposit. Resolves to the final outcome. */
  sendTransaction(action: FairgroundAction): Promise<unknown>;
}

/** NEAR Connect's FunctionCall action (`FunctionCallAction` in @hot-labs/near-connect 0.12). */
export interface ConnectorFunctionCall {
  type: "FunctionCall";
  params: { methodName: string; args: object; gas: string; deposit: string };
}

/**
 * The part of a NEAR Connect wallet (`NearWalletBase` in @hot-labs/near-connect
 * 0.12) this package uses. It is structural, so the package does not depend on
 * near-connect: pass the object `await connector.wallet()` returns.
 */
export interface ConnectWallet {
  readonly manifest: { readonly features: { readonly signDelegateActions?: boolean } };
  signDelegateActions(params: {
    signerId?: string;
    delegateActions: Array<{ receiverId: string; actions: ConnectorFunctionCall[] }>;
  }): Promise<{ signedDelegateActions: string[] }>;
  signAndSendTransaction(params: { signerId?: string; receiverId: string; actions: ConnectorFunctionCall[] }): Promise<unknown>;
}

/**
 * A NEAR Connect wallet as a signer. The wallet chooses the delegate's nonce and
 * expiry (`maxBlockHeight`), so POST the result to the relayer at once.
 * `signerId` names the connected account for wallets that hold several.
 */
export function walletSigner(wallet: ConnectWallet, { signerId }: { signerId?: string } = {}): ActionSigner {
  const signer = signerId === undefined ? {} : { signerId };
  return {
    signsDelegates: wallet.manifest.features.signDelegateActions === true,

    async signDelegate(action) {
      const { signedDelegateActions } = await wallet.signDelegateActions({
        ...signer,
        delegateActions: [{ receiverId: action.receiverId, actions: [toConnectorAction(action)] }],
      });
      const [signed] = signedDelegateActions;
      if (typeof signed !== "string" || signed === "") throw new Error("the wallet returned no signed delegate");
      return signed;
    },

    sendTransaction: (action) =>
      wallet.signAndSendTransaction({ ...signer, receiverId: action.receiverId, actions: [toConnectorAction(action)] }),
  };
}

export interface KeyPairSignerOptions {
  accountId: string;
  /** A full-access key of `accountId`. A bid attaches 1 yoctoNEAR, which a function-call key cannot sign. */
  keyPair: KeyPair;
  /** e.g. `new JsonRpcProvider({ url })`. */
  provider: Provider;
  /**
   * Blocks the delegate stays valid. The relayer accepts 5 to its
   * MAX_DELEGATE_BLOCKS (1200 by default). Default 200, near-api-js's own default.
   */
  validityBlocks?: number;
}

/** A key held in memory as a signer. It reads the key's nonce and the head from `provider`. */
export function keyPairSigner({ accountId, keyPair, provider, validityBlocks = 200 }: KeyPairSignerOptions): ActionSigner {
  const signer = new KeyPairSigner(keyPair);
  const account = new Account(accountId, provider, signer);
  const publicKey = keyPair.getPublicKey();
  /** Highest nonce signed here, so delegates signed before the previous one lands never share a nonce. */
  let lastNonce = 0n;

  return {
    signsDelegates: true,

    async signDelegate(action) {
      const [key, block] = await Promise.all([
        provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: "optimistic" } }),
        provider.viewBlock({ finality: "final" }),
      ]);
      lastNonce = (key.nonce > lastNonce ? key.nonce : lastNonce) + 1n;
      const delegateAction = buildDelegateAction({
        senderId: accountId,
        receiverId: action.receiverId,
        actions: [toNearAction(action)],
        nonce: lastNonce,
        maxBlockHeight: BigInt(block.header.height) + BigInt(validityBlocks),
        publicKey,
      });
      const { signedDelegate } = await signer.signDelegateAction(delegateAction);
      return base64Encode(encodeSignedDelegate(signedDelegate));
    },

    sendTransaction: (action) =>
      account.signAndSendTransaction({
        receiverId: action.receiverId,
        actions: [toNearAction(action)],
        waitUntil: "EXECUTED_OPTIMISTIC",
        // Failures are read from the receipts (outcome.ts), the same way for both paths.
        throwOnFailure: false,
      }),
  };
}

/** Both conversions serialize `args` with JSON.stringify, so the wallet and the key sign the same bytes. */
function toConnectorAction({ methodName, args, gas, deposit }: FairgroundAction): ConnectorFunctionCall {
  return { type: "FunctionCall", params: { methodName, args, gas: gas.toString(), deposit: deposit.toString() } };
}

function toNearAction({ methodName, args, gas, deposit }: FairgroundAction): Action {
  return actions.functionCall(methodName, args, gas, deposit);
}
