"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Droplets, LogOut, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getClient } from "@/lib/client";
import { shortAccount, usdcStr } from "@/lib/format";
import { useBalances } from "@/lib/hooks";
import { DEMO_FAUCET_USDC, useWallet } from "@/lib/wallet";

export function ConnectButton() {
  const { account, connect, disconnect, connecting } = useWallet();
  const bal = useBalances(account);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!account) {
    return (
      <Button size="sm" onClick={connect} loading={connecting} icon={<Wallet className="size-3.5" />}>
        Connect
      </Button>
    );
  }

  return (
    <div className="relative min-w-0" ref={ref}>
      {/* At phone width only the account shows; the balance is in the menu. */}
      <Button
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="max-w-full min-w-0"
      >
        <span className="num hidden text-[12.5px] text-muted sm:inline">
          {bal.data ? usdcStr(bal.data.usdc) : "…"} USDC
        </span>
        <span className="hidden h-3.5 w-px bg-line-strong sm:inline" aria-hidden />
        <span className="min-w-0 max-w-[120px] truncate sm:max-w-[140px]">{shortAccount(account, 18)}</span>
        <ChevronDown className="size-3.5 shrink-0 text-subtle" aria-hidden />
      </Button>
      {open && (
        <div className="panel absolute right-0 z-40 mt-2 w-64 max-w-[calc(100vw-2rem)] p-1.5 shadow-2xl shadow-black/60">
          <div className="px-2.5 py-2">
            <div className="text-[11.5px] text-subtle">Demo account (simulated testnet)</div>
            <div className="num mt-0.5 truncate text-[13px] text-fg">{account}</div>
            <div className="num mt-1 text-[12.5px] text-muted">
              {bal.data ? usdcStr(bal.data.usdc) : "…"} <span className="font-sans">USDC</span>
            </div>
          </div>
          <button
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-muted hover:bg-hover hover:text-fg"
            onClick={async () => {
              await getClient().faucet(account, DEMO_FAUCET_USDC);
              setOpen(false);
            }}
          >
            <Droplets className="size-4" /> Get 100 test USDC
          </button>
          <button
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-muted hover:bg-hover hover:text-fg"
            onClick={() => {
              disconnect();
              setOpen(false);
            }}
          >
            <LogOut className="size-4" /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
