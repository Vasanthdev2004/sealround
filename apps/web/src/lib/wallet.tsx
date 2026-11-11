"use client";

/**
 * Wallet context, one interface for three kinds of account:
 *
 * - "demo" (mock mode, the default): a simulated testnet account, so judges
 *   need no wallet and no funds.
 * - "near" (NEAR mode): a wallet picked through NEAR Connect
 *   (@hot-labs/near-connect: HOT, Meteor, Intear, MyNearWallet, ...). The
 *   connector is created without `features.signDelegateActions`, so wallets
 *   that cannot sign NEP-366 delegates still show up: they work through the
 *   paid fallback, and `canSignDelegates` tells the UI which kind is connected.
 * - "dev" (NEAR mode on a local sandbox only): an account from
 *   NEXT_PUBLIC_DEV_ACCOUNTS signing with its key. Refused on any other
 *   network (config.ts `devSignerAllowed`, near/dev-signer.ts).
 *
 * Client only: nothing here touches `window` while rendering or at import, so
 * the provider prerenders as "not connected" and the stores fill in after
 * hydration. NEAR Connect, the relayer client and near-api-js are loaded with
 * import() on first use, never in mock mode.
 */

import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { ActionSigner } from "@fairground/relayer-client";
import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";
import { getClient } from "./client";
import { appConfig, isNearMode, type NearConfig, type NearNetwork } from "./config";
import { randomHex } from "./crypto";
import { browserSigners } from "./near/signers";

export type WalletKind = "demo" | "near" | "dev";

export type WalletState = {
  account: string | null;
  /** "demo" = simulated testnet account. "near" = a NEAR Connect wallet. "dev" = a sandbox dev key. */
  kind: WalletKind | null;
  connecting: boolean;
  /** Mock: creates or restores the demo account. NEAR: opens NEAR Connect (on a sandbox, connects a dev account). Never rejects; see `error`. */
  connect: () => Promise<void>;
  /** Signs out. */
  disconnect: () => void;

  // ---- Added with NEAR mode. Mock mode fills them with what the simulated wallet does.
  /** Which chain the app talks to: the same as getClient().mode. */
  mode: "mock" | "near";
  /** The NEAR network; null in mock mode. */
  network: NearNetwork | null;
  /** Signs for `account` (NEP-366 delegates and normal transactions). Null in mock mode and while signed out. */
  signer: ActionSigner | null;
  /**
   * Whether this wallet can sign NEP-366 delegates, which a gasless call
   * needs. False (MyNearWallet, OKX, Nightly, ...): every call is a normal
   * transaction and costs a small NEAR fee: say so before the user signs.
   * True in mock mode (the simulated relayer pays) and for dev accounts.
   */
  canSignDelegates: boolean;
  /** The wallet's name ("Meteor Wallet", "Dev account"); null in mock mode and while signed out. */
  walletName: string | null;
  /** Why the last connect or sign-out did not work, in words; null otherwise. */
  error: string | null;
  /** Sandbox only: the dev accounts that can be connected. Empty everywhere else. */
  devAccounts: string[];
  /** Sandbox only: connect this dev account. */
  connectDev: (accountId: string) => Promise<void>;
};

const WalletContext = createContext<WalletState | null>(null);
const KEY = "fairground:wallet:v1";
const DEV_KEY = "fairground:wallet:dev:v1";
const EVT = "fairground:wallet";
/** Every new demo account starts with this much test USDC. */
export const DEMO_FAUCET_USDC = 100n * 1_000_000n;

function read(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function write(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {}
}
function subscribe(cb: () => void) {
  const onStorage = (e: StorageEvent) => e.key === KEY && cb();
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVT, cb);
    window.removeEventListener("storage", onStorage);
  };
}

// ---------- NEAR mode: one store per tab ----------

type NearWallet = {
  account: string | null;
  kind: "near" | "dev" | null;
  signer: ActionSigner | null;
  canSignDelegates: boolean;
  walletName: string | null;
  connecting: boolean;
  error: string | null;
};

const SIGNED_OUT: NearWallet = {
  account: null,
  kind: null,
  signer: null,
  canSignDelegates: false,
  walletName: null,
  connecting: false,
  error: null,
};

let near: NearWallet = SIGNED_OUT;
const nearListeners = new Set<() => void>();

function setNear(patch: Partial<NearWallet>) {
  near = { ...near, ...patch };
  // The NEAR client signs with whatever is registered here.
  if (near.account && near.signer) browserSigners.set(near.account, near.signer);
  else browserSigners.clear();
  nearListeners.forEach((l) => l());
}
function subscribeNear(cb: () => void) {
  nearListeners.add(cb);
  return () => {
    nearListeners.delete(cb);
  };
}
const nearSnapshot = () => near;
const signedOutSnapshot = () => SIGNED_OUT;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The NEAR config, or null with the reason when a NEXT_PUBLIC_* value is unusable. */
function readNearConfig(): { config: NearConfig | null; error: string | null } {
  try {
    const c = appConfig();
    return { config: c.mode === "near" ? c.near : null, error: null };
  } catch (e) {
    return { config: null, error: message(e) };
  }
}

async function adoptWallet(wallet: NearWalletBase, accountId: string) {
  const { walletSigner } = await import("@fairground/relayer-client");
  const signer = walletSigner(wallet, { signerId: accountId });
  setNear({
    account: accountId,
    kind: "near",
    signer,
    canSignDelegates: signer.signsDelegates,
    walletName: wallet.manifest.name,
    error: null,
  });
}

let connector: Promise<NearConnector> | null = null;

/** The NEAR Connect connector for this tab, created on first use (browser only). */
function getConnector(config: NearConfig): Promise<NearConnector> {
  connector ??= import("@hot-labs/near-connect").then(({ NearConnector }) => {
    // No `features` filter: a wallet that cannot sign delegates still works through the paid fallback.
    const c = new NearConnector({ network: config.network === "mainnet" ? "mainnet" : "testnet" });
    c.on("wallet:signIn", ({ wallet, accounts }) => {
      const first = accounts[0]?.accountId;
      if (first) void adoptWallet(wallet, first);
    });
    c.on("wallet:signOut", () => setNear({ ...SIGNED_OUT }));
    return c;
  });
  return connector;
}

/** After a reload: pick up the wallet that was connected, if its session is still there. */
async function restoreWallet(config: NearConfig) {
  const c = await getConnector(config);
  const tryRestore = async () => {
    if (near.account) return true;
    try {
      // Not `c.wallet()`: on failure that also forgets which wallet was selected.
      const { wallet, accounts } = await c.getConnectedWallet();
      const first = accounts[0]?.accountId;
      if (!first) return false;
      await adoptWallet(wallet, first);
      return true;
    } catch {
      return false;
    }
  };
  if (await tryRestore()) return;
  // Wallets register one by one after the manifest loads; look again as they arrive.
  const onChange = () => {
    void tryRestore().then((ok) => {
      if (ok) c.off("selector:walletsChanged", onChange);
    });
  };
  c.on("selector:walletsChanged", onChange);
}

async function connectDevAccount(config: NearConfig, accountId: string) {
  const account = config.devAccounts.find((a) => a.accountId === accountId);
  if (!account) throw new Error(`${accountId} is not one of the dev accounts in NEXT_PUBLIC_DEV_ACCOUNTS.`);
  // createDevSigner refuses anything but a sandbox on a local RPC URL.
  const { createDevSigner } = await import("./near/dev-signer");
  const signer = createDevSigner(config, account);
  write(DEV_KEY, accountId);
  setNear({
    account: accountId,
    kind: "dev",
    signer,
    canSignDelegates: signer.signsDelegates,
    walletName: "Dev account",
    error: null,
  });
}

// ---------- provider ----------

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const nearMode = isNearMode();
  const demoAccount = useSyncExternalStore(subscribe, () => read(KEY), () => null);
  const nearWallet = useSyncExternalStore(subscribeNear, nearSnapshot, signedOutSnapshot);
  const [demoConnecting, setDemoConnecting] = useState(false);

  // NEAR mode: restore the session after hydration.
  useEffect(() => {
    if (!nearMode) return;
    const { config, error } = readNearConfig();
    if (!config) {
      setNear({ error });
      return;
    }
    if (config.network === "sandbox") {
      const last = read(DEV_KEY);
      if (last && config.devAccounts.some((a) => a.accountId === last)) {
        connectDevAccount(config, last).catch((e: unknown) => setNear({ error: message(e) }));
      }
      return;
    }
    restoreWallet(config).catch((e: unknown) => setNear({ error: message(e) }));
  }, [nearMode]);

  const connectDev = useCallback(async (accountId: string) => {
    const { config, error } = readNearConfig();
    if (!config) {
      setNear({ error: error ?? "Dev accounts exist on a local sandbox only." });
      return;
    }
    setNear({ connecting: true, error: null });
    try {
      await connectDevAccount(config, accountId);
    } catch (e) {
      setNear({ error: message(e) });
    } finally {
      setNear({ connecting: false });
    }
  }, []);

  const connect = useCallback(async () => {
    if (!nearMode) {
      setDemoConnecting(true);
      try {
        let name = read(`${KEY}:last`);
        const isNew = !name;
        name ??= `guest-${randomHex(3)}.testnet`;
        const client = getClient();
        await client.ready();
        if (isNew) await client.faucet(name, DEMO_FAUCET_USDC);
        write(KEY, name);
        write(`${KEY}:last`, name);
        window.dispatchEvent(new Event(EVT));
      } finally {
        setDemoConnecting(false);
      }
      return;
    }
    const { config, error } = readNearConfig();
    if (!config) {
      setNear({ error });
      return;
    }
    if (config.network === "sandbox") {
      const first = read(DEV_KEY) ?? config.devAccounts[0]?.accountId;
      if (!first) {
        setNear({
          error: "A sandbox has no wallets. List dev accounts in NEXT_PUBLIC_DEV_ACCOUNTS (see apps/web/.env.example).",
        });
        return;
      }
      await connectDev(first);
      return;
    }
    setNear({ connecting: true, error: null });
    try {
      const c = await getConnector(config);
      const wallet = await c.connect();
      const accounts = await wallet.getAccounts();
      const first = accounts[0]?.accountId;
      if (!first) throw new Error("The wallet returned no account.");
      await adoptWallet(wallet, first);
    } catch (e) {
      // Closing the wallet picker is not an error worth showing.
      const text = message(e);
      setNear({ error: /user rejected/i.test(text) ? null : text });
    } finally {
      setNear({ connecting: false });
    }
  }, [nearMode, connectDev]);

  const disconnect = useCallback(() => {
    if (!nearMode) {
      write(KEY, null);
      window.dispatchEvent(new Event(EVT));
      return;
    }
    const wasWallet = near.kind === "near";
    write(DEV_KEY, null);
    setNear({ ...SIGNED_OUT });
    if (wasWallet && connector) {
      connector.then((c) => c.disconnect()).catch((e: unknown) => setNear({ error: message(e) }));
    }
  }, [nearMode]);

  const config = nearMode ? readNearConfig().config : null;
  const value: WalletState = nearMode
    ? {
        account: nearWallet.account,
        kind: nearWallet.kind,
        connecting: nearWallet.connecting,
        connect,
        disconnect,
        mode: "near",
        network: config?.network ?? null,
        signer: nearWallet.signer,
        canSignDelegates: nearWallet.canSignDelegates,
        walletName: nearWallet.walletName,
        error: nearWallet.error,
        devAccounts: config?.devAccounts.map((a) => a.accountId) ?? [],
        connectDev,
      }
    : {
        account: demoAccount,
        kind: demoAccount ? "demo" : null,
        connecting: demoConnecting,
        connect,
        disconnect,
        mode: "mock",
        network: null,
        signer: null,
        canSignDelegates: true,
        walletName: null,
        error: null,
        devAccounts: [],
        connectDev,
      };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
