/**
 * A FairgroundClient that loads the NEAR implementation (near.ts, with
 * @fairground/relayer-client and near-api-js behind it) with import() on first
 * use. getClient() returns this in NEAR mode, so the mock-mode bundle never
 * contains any of it. Everything synchronous (mode, contract, capabilities,
 * expected code hash, subscriptions) is answered here from the config.
 */

import type { NearConfig } from "../config";
import type { ClientNotice } from "../types";
import type { FairgroundClient } from "./index";
import type { NearClient } from "./near";

export function createLazyNearClient(config: NearConfig): FairgroundClient {
  let loading: Promise<NearClient> | null = null;
  const listeners = new Set<() => void>();
  const noticeListeners = new Set<(n: ClientNotice) => void>();

  const load = (): Promise<NearClient> => {
    loading ??= import("./near").then(
      (m) => {
        const near = new m.NearClient(config);
        near.subscribe(() => listeners.forEach((l) => l()));
        near.subscribeNotices((n) => noticeListeners.forEach((l) => l(n)));
        return near;
      },
      (e: unknown) => {
        // The chunk did not load (offline, a deploy in between): try again on the next call.
        loading = null;
        throw e;
      },
    );
    return loading;
  };

  return {
    mode: "near",
    contractId: config.contractId,
    usdcContract: config.usdcContract,
    secretsScope: config.contractId,
    capabilities: {
      judgeMode: false,
      faucet: config.network !== "mainnet",
      reset: false,
      relayer: config.relayerUrl !== null,
      simulated: false,
    },
    expectedCodeHash: () => config.expectedCodeHash ?? "",
    subscribe(listener) {
      listeners.add(listener);
      // Start loading now; a failure surfaces on the first real call.
      load().catch(() => {});
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeNotices(listener) {
      noticeListeners.add(listener);
      return () => {
        noticeListeners.delete(listener);
      };
    },

    ready: async () => (await load()).ready(),
    listSales: async () => (await load()).listSales(),
    getSale: async (id) => (await load()).getSale(id),
    getBids: async (id) => (await load()).getBids(id),
    getBid: async (saleId, bidder) => (await load()).getBid(saleId, bidder),
    getEvents: async (id) => (await load()).getEvents(id),
    getResult: async (id) => (await load()).getResult(id),
    getBalances: async (account, saleIds) => (await load()).getBalances(account, saleIds),
    getCreateCost: async (creator, c, meta, opts) => (await load()).getCreateCost(creator, c, meta, opts),
    getCloseDeposit: async (saleId) => (await load()).getCloseDeposit(saleId),
    createSale: async (creator, c, meta, opts) => (await load()).createSale(creator, c, meta, opts),
    placeBid: async (saleId, bidder, deposit, ct, opts) => (await load()).placeBid(saleId, bidder, deposit, ct, opts),
    placeBidPayload: async (saleId, bidder, deposit, payload, opts) =>
      (await load()).placeBidPayload(saleId, bidder, deposit, payload, opts),
    bid: async (saleId, bidder, deposit, terms, opts) => (await load()).bid(saleId, bidder, deposit, terms, opts),
    closeSale: async (saleId, caller) => (await load()).closeSale(saleId, caller),
    revealBid: async (saleId, bidder, reveal, opts) => (await load()).revealBid(saleId, bidder, reveal, opts),
    clearOnchain: async (saleId, caller, opts) => (await load()).clearOnchain(saleId, caller, opts),
    claim: async (saleId, bidder, opts) => (await load()).claim(saleId, bidder, opts),
    claimProceeds: async (saleId, caller, opts) => (await load()).claimProceeds(saleId, caller, opts),
    triggerRefundMode: async (saleId, caller, opts) => (await load()).triggerRefundMode(saleId, caller, opts),
    retrySetup: async (saleId, caller, opts) => (await load()).retrySetup(saleId, caller, opts),
    getAttestation: async (saleId, nonce) => (await load()).getAttestation(saleId, nonce),
    faucet: async (account, amount, opts) => (await load()).faucet(account, amount, opts),
    ensureUsdcStorage: async (account, opts) => (await load()).ensureUsdcStorage(account, opts),
    getRelayerPolicy: async () => (await load()).getRelayerPolicy(),
    runJudgeMode: async (opts) => (await load()).runJudgeMode(opts),
    reset: async () => (await load()).reset(),
  };
}
