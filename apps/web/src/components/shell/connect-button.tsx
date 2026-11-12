"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useGasMode } from "@/components/sale-common/relay";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { errorInfo, getClient } from "@/lib/client";
import { shortAccount, usdcStr } from "@/lib/format";
import { useBalances } from "@/lib/hooks";
import { DEMO_FAUCET_USDC, useWallet } from "@/lib/wallet";

/** The enabled menu items inside the account menu, in order. */
function menuItems(root: HTMLElement | null): HTMLElement[] {
  return root ? Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')) : [];
}

/**
 * NEAR mode, signed out: the button opens NEAR Connect's wallet picker (on a
 * local sandbox it connects a dev account). If that fails, the reason sits
 * under the button until the next try.
 */
function ConnectError({ text }: { text: string }) {
  return (
    <p
      role="alert"
      className="layer-float fixed inset-x-4 top-[60px] z-40 animate-popup p-3 text-label text-bad sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-2 sm:w-72"
    >
      Could not connect. {text}
    </p>
  );
}

/**
 * Whether this wallet's bids, reveals and claims are gasless, in one line of
 * the account menu. Gasless needs both a relayer that answers and a wallet
 * that can sign delegate actions; otherwise the reason is given.
 */
function GaslessLine() {
  const gas = useGasMode();
  if (gas.paidBy === "unknown") return null;
  return gas.paidBy === "relayer" ? (
    <p className="mt-1.5 text-label text-ok">
      Gasless: the relayer pays network fees
    </p>
  ) : (
    <p className="mt-1.5 text-label text-warn">
      {gas.reason === "delegates_unsupported"
        ? "This wallet cannot sign gasless calls. Bids and claims cost a small NEAR fee."
        : gas.reason === "no_relayer"
          ? "No gas relayer is set up. Bids and claims cost a small NEAR fee."
          : "The gas relayer is not answering. Bids and claims cost a small NEAR fee for now."}
    </p>
  );
}

export function ConnectButton() {
  const wallet = useWallet();
  const { account, connect, disconnect, connecting, mode } = wallet;
  const near = mode === "near";
  const bal = useBalances(account);
  const [open, setOpen] = useState(false);
  const [faucet, setFaucet] = useState<"idle" | "busy" | "done">("idle");
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // A real menu: focus moves to the first item when it opens.
    const raf = requestAnimationFrame(() => menuItems(ref.current)[0]?.focus());
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      } else if (e.key === "Tab") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /** Arrow keys, Home and End move between the menu items (wrapping). */
  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = menuItems(ref.current);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (i + 1) % items.length;
    else if (e.key === "ArrowUp") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next === null) return;
    e.preventDefault();
    items[next].focus();
  };

  if (!account) {
    return (
      <div className="relative min-w-0">
        <Button
          variant="primary"
          size="sm"
          onClick={connect}
          loading={connecting}
          className="max-w-full max-lg:min-h-11 max-sm:px-2"
        >
          <span className="truncate">
            Connect{near && <span className="max-sm:sr-only"> wallet</span>}
          </span>
        </Button>
        {near && wallet.error && !connecting && <ConnectError text={wallet.error} />}
      </div>
    );
  }

  async function addFunds() {
    if (!account) return;
    setFaucet("busy");
    setFaucetError(null);
    try {
      await getClient().faucet(account, DEMO_FAUCET_USDC);
      setFaucet("done");
      setTimeout(() => {
        setFaucet("idle");
        setOpen(false);
        triggerRef.current?.focus();
      }, 700);
    } catch (e) {
      setFaucet("idle");
      // On a real chain the faucet is a wallet transaction: it can be declined or fail, and the menu says so.
      if (near) setFaucetError(errorInfo(e).message);
    }
  }

  // The faucet mints test USDC: on the simulated chain at once, on testnet or a sandbox with a wallet transaction, never on mainnet.
  const canFaucet = getClient().capabilities.faucet;
  const otherDevAccounts = near ? wallet.devAccounts.filter((a) => a !== account) : [];

  const item =
    "flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-small text-muted transition-colors hover:bg-wash hover:text-fg focus-visible:bg-wash focus-visible:text-fg disabled:opacity-60";

  return (
    <div className="relative min-w-0" ref={ref}>
      {/* At phone width only the account shows; the balance is in the menu. */}
      <Button
        ref={triggerRef}
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="max-w-full min-w-0 max-lg:min-h-11 max-sm:px-2"
      >
        <span className="num hidden text-[12.5px] text-muted sm:inline">
          {bal.data ? usdcStr(bal.data.usdc) : "…"} USDC
        </span>
        <span className="hidden h-3.5 w-px bg-line-strong sm:inline" aria-hidden />
        <span className="hidden min-w-0 max-w-[140px] truncate sm:inline">
          {shortAccount(account, 18)}
        </span>
        <span className="sm:hidden">Wallet</span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 text-subtle transition-transform duration-200 max-[359px]:hidden", open && "rotate-180")}
          aria-hidden
        />
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label="Account"
            onKeyDown={onMenuKey}
            initial={{ opacity: 0, y: -8, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.96, transition: { duration: 0.12 } }}
            transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            style={{ transformOrigin: "top right" }}
            className="layer-float fixed inset-x-4 top-[60px] z-40 p-1.5 sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-2 sm:w-72"
          >
            <div className="px-2.5 pt-2.5 pb-3">
              <div className="text-label text-subtle">
                {near ? `${wallet.walletName ?? "Wallet"}, NEAR ${wallet.network ?? "testnet"}` : "Simulated account"}
              </div>
              <div className="num mt-0.5 truncate text-[13.5px] text-fg">{account}</div>
              <div className="num mt-1.5 text-[13px] text-muted">
                {bal.data ? usdcStr(bal.data.usdc) : "…"} <span className="font-sans">USDC</span>
              </div>
              {near && <GaslessLine />}
            </div>
            <div className="mx-1.5 mb-1 border-t border-line" />
            {canFaucet && (
              <button role="menuitem" tabIndex={-1} className={item} onClick={addFunds} disabled={faucet !== "idle"}>
                {faucet === "busy" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : faucet === "done" && (
                  <Check className="size-4 text-ok" aria-hidden />
                )}
                {faucet === "done"
                  ? "Added 100 test USDC"
                  : faucet === "busy" && near
                    ? "Confirm in your wallet"
                    : "Get 100 test USDC"}
              </button>
            )}
            {faucetError && (
              <p role="alert" className="px-2.5 pb-1.5 text-label text-bad">
                {faucetError}
              </p>
            )}
            {otherDevAccounts.map((a) => (
              <button
                key={a}
                role="menuitem"
                tabIndex={-1}
                className={item}
                onClick={() => {
                  void wallet.connectDev(a);
                  setOpen(false);
                }}
              >
                <span className="min-w-0 truncate">
                  Switch to <span className="num">{a}</span>
                </span>
              </button>
            ))}
            <button
              role="menuitem"
              tabIndex={-1}
              className={item}
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
            >
              {near ? "Sign out" : "Disconnect"}
            </button>
            {near && wallet.error && (
              <p role="alert" className="px-2.5 pt-1 pb-1.5 text-label text-bad">
                {wallet.error}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
