import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { bidAction, claimAction } from "../src/actions";
import { keyPairSigner, walletSigner, type ConnectWallet } from "../src/signers";
import { ALICE, CIPHERTEXT, FAIRGROUND, HEAD, USDC, expectSignedDelegate, memoryProvider, specSignedDelegate, stubWallet } from "./helpers";

const bid = bidAction(USDC, FAIRGROUND, "fairt", 2_000_000n, { ciphertext: CIPHERTEXT, bidder: ALICE });

describe("keyPairSigner", () => {
  it("signs a delegate nearcore accepts: next nonce, final head + validity, NEP-461 signature", async () => {
    const key = KeyPair.fromRandom("ed25519");
    const signer = keyPairSigner({ accountId: ALICE, keyPair: key, provider: memoryProvider({ nonce: 41n, height: HEAD }) });
    expect(signer.signsDelegates).toBe(true);
    const signed = await signer.signDelegate(bid);
    expectSignedDelegate(signed, key, { senderId: ALICE, action: bid, nonce: 42n, maxBlockHeight: HEAD + 200n });
  });

  it("produces byte for byte what NEP-366 and NEP-461 specify (borsh and ed25519 written without near-api-js)", async () => {
    const key = KeyPair.fromRandom("ed25519");
    for (const action of [bid, claimAction(FAIRGROUND, "fairt", "bob.test.near")]) {
      const signer = keyPairSigner({ accountId: ALICE, keyPair: key, provider: memoryProvider({ nonce: 41n, height: HEAD }) });
      // ed25519 signatures are deterministic, so the whole SignedDelegate must match.
      expect(await signer.signDelegate(action)).toBe(specSignedDelegate(key, { senderId: ALICE, action, nonce: 42n, maxBlockHeight: HEAD + 200n }));
    }
  });

  it("never reuses a nonce while earlier delegates have not landed", async () => {
    const key = KeyPair.fromRandom("ed25519");
    const chain = { nonce: 7n, height: HEAD };
    const signer = keyPairSigner({ accountId: ALICE, keyPair: key, provider: memoryProvider(chain), validityBlocks: 50 });
    const claim = claimAction(FAIRGROUND, "fairt");
    const [first, second] = await Promise.all([signer.signDelegate(claim), signer.signDelegate(claim)]);
    expectSignedDelegate(first!, key, { senderId: ALICE, action: claim, nonce: 8n, maxBlockHeight: HEAD + 50n });
    expectSignedDelegate(second!, key, { senderId: ALICE, action: claim, nonce: 9n, maxBlockHeight: HEAD + 50n });
    // Once the chain is ahead of what was signed here, its nonce wins.
    chain.nonce = 100n;
    expectSignedDelegate(await signer.signDelegate(claim), key, { senderId: ALICE, action: claim, nonce: 101n, maxBlockHeight: HEAD + 50n });
  });
});

describe("walletSigner", () => {
  it("asks NEAR Connect for one delegate with the call as a ConnectorAction and returns its string", async () => {
    const key = KeyPair.fromRandom("ed25519");
    const provider = memoryProvider({ nonce: 0n, height: HEAD });
    const { wallet, requests } = stubWallet({ accountId: ALICE, keyPair: key, provider });
    const signer = walletSigner(wallet, { signerId: ALICE });
    expect(signer.signsDelegates).toBe(true);

    const signed = await signer.signDelegate(bid);
    expect(requests).toEqual([
      {
        signerId: ALICE,
        delegateActions: [
          {
            receiverId: USDC,
            actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer_call", args: bid.args, gas: "100000000000000", deposit: "1" } }],
          },
        ],
      },
    ]);
    // The wallet's own encoding of the ConnectorAction it was handed holds exactly the call that was built.
    expectSignedDelegate(signed, key, { senderId: ALICE, action: bid, nonce: 1n, maxBlockHeight: HEAD + 200n });
  });

  it("sends a normal transaction through signAndSendTransaction", async () => {
    const sent: unknown[] = [];
    const wallet: ConnectWallet = {
      manifest: { features: {} },
      signDelegateActions: async () => ({ signedDelegateActions: [] }),
      signAndSendTransaction: async (params) => (sent.push(params), { transaction: { hash: "h" } }),
    };
    const signer = walletSigner(wallet);
    expect(signer.signsDelegates).toBe(false);
    await expect(signer.sendTransaction(bid)).resolves.toEqual({ transaction: { hash: "h" } });
    expect(sent).toEqual([
      {
        receiverId: USDC,
        actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer_call", args: bid.args, gas: "100000000000000", deposit: "1" } }],
      },
    ]);
    await expect(signer.signDelegate(bid)).rejects.toThrow("no signed delegate");
  });

  it("takes a NEAR Connect 0.12 wallet as it is", () => {
    // NearWalletBase and ConnectorAction as @hot-labs/near-connect 0.12.0 declares
    // them (build/types/index.d.ts, build/actions/types.d.ts), trimmed to what matters.
    type NearConnectAction =
      | { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }
      | { type: "Transfer"; params: { deposit: string } };
    interface NearWalletBase {
      manifest: { id: string; features: { signDelegateActions: boolean; signAndSendTransaction: boolean; testnet: boolean } };
      signAndSendTransaction(params: {
        network?: "mainnet" | "testnet";
        signerId?: string;
        receiverId: string;
        actions: NearConnectAction[];
      }): Promise<{ status: unknown; transaction: { hash: string } }>;
      signDelegateActions(params: {
        network?: "mainnet" | "testnet";
        signerId?: string;
        delegateActions: Array<{ actions: NearConnectAction[]; receiverId: string }>;
      }): Promise<{ signedDelegateActions: string[] }>;
    }
    const accepts = (wallet: NearWalletBase): ConnectWallet => wallet;
    expect(accepts).toBeTypeOf("function");
  });
});
