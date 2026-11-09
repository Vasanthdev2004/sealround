"use client";

/**
 * Wallet context. Today: a simulated testnet account so judges need no wallet
 * and no funds. Next: @hot-labs/near-connect (HOT, Meteor, Intear,
 * MyNearWallet, NEAR Mobile, OKX) behind this same interface.
 */

import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";
import { getClient } from "./client";
import { randomHex } from "./crypto";

type WalletState = {
  account: string | null;
  /** "demo" = simulated testnet account. */
  kind: "demo" | "near" | null;
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
};

const WalletContext = createContext<WalletState | null>(null);
const KEY = "fairground:wallet:v1";
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

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const account = useSyncExternalStore(subscribe, () => read(KEY), () => null);
  const [connecting, setConnecting] = useState(false);

  const connect = useCallback(async () => {
    setConnecting(true);
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
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    write(KEY, null);
    window.dispatchEvent(new Event(EVT));
  }, []);

  return (
    <WalletContext.Provider
      value={{ account, kind: account ? "demo" : null, connecting, connect, disconnect }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
