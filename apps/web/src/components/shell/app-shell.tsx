"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { getClient } from "@/lib/client";
import { DEMO_FAUCET_USDC, useWallet } from "@/lib/wallet";
import { ButtonLink } from "@/components/ui/button";
import { ConnectButton } from "./connect-button";
import { NAV } from "./nav";

export function Logo({ className, wordmarkClassName }: { className?: string; wordmarkClassName?: string }) {
  return (
    <Link href="/" className={cn("flex shrink-0 items-center gap-2.5", className)} aria-label="fairground home">
      <span
        aria-hidden
        className="relative inline-flex size-[30px] items-center justify-center rounded-full"
        style={{
          background:
            "radial-gradient(110% 110% at 30% 25%, #9cc6ff 0%, #2b85ff 45%, #0a3a99 100%)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,.55), inset 0 -4px 8px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.1), 0 4px 12px rgba(10,98,240,.35)",
        }}
      >
        {/* A seal: one ring, one line. Bids are sealed, one price for all. */}
        <svg viewBox="0 0 20 20" className="size-4 text-white" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="10" cy="10" r="6.2" />
          <path d="M6.5 10h7" strokeLinecap="round" />
        </svg>
      </span>
      <span
        aria-hidden
        className={cn("font-display text-[17px] font-medium tracking-[-0.02em] text-fg", wordmarkClassName)}
      >
        fairground
      </span>
    </Link>
  );
}

/**
 * The pathname is unknown while prerendering dynamic routes such as
 * /sale/[id] (Cache Components), so only the active-state read sits inside
 * Suspense. The fallback is the same list with nothing highlighted.
 */
function NavList() {
  return (
    <Suspense fallback={<NavLinks path={null} />}>
      <ActiveNavLinks />
    </Suspense>
  );
}

function ActiveNavLinks() {
  const path = usePathname();
  return <NavLinks path={path} />;
}

function NavLinks({ path }: { path: string | null }) {
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((n) => {
        const active = path !== null && n.match(path);
        const Icon = n.icon;
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-9 items-center gap-3 rounded-tile px-2.5 text-[14px] transition-colors",
              active ? "bg-elev-2 text-fg ring-1 ring-line" : "text-muted hover:bg-hover hover:text-fg",
            )}
          >
            <Icon className={cn("size-[17px]", active ? "text-fg" : "text-subtle")} strokeWidth={1.75} />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * A quiet pointer to judge mode. Not a primary button: each page keeps its
 * own one main action. Hidden on /judge itself, where it would only repeat
 * that page's Run button.
 */
function JudgeCard() {
  return (
    <Suspense fallback={null}>
      <JudgeCardOffJudge />
    </Suspense>
  );
}

function JudgeCardOffJudge() {
  const path = usePathname();
  if (path.startsWith("/judge")) return null;
  return (
    <div className="panel p-4">
      <div className="text-[14px] font-medium text-fg">Judge mode</div>
      <div className="text-[12px] text-subtle">No wallet. No funds. About 2 minutes.</div>
      <p className="mt-2.5 text-[13px] leading-snug text-muted">
        A full sale with 50 people, 3 sniper bots and 1 copycat, start to finish.
      </p>
      <ButtonLink href="/judge" variant="tactile" size="sm" className="mt-3.5 w-full">
        Open judge mode <ArrowUpRight className="size-3.5" strokeWidth={1.75} />
      </ButtonLink>
    </div>
  );
}

/** Wipes this browser's demo state and re-seeds it. Two steps, so it is never a slip. */
function ResetDemo() {
  const router = useRouter();
  const { account } = useWallet();
  const [stage, setStage] = useState<"idle" | "confirm" | "busy">("idle");
  const [error, setError] = useState<string | null>(null);

  async function reset() {
    setStage("busy");
    setError(null);
    try {
      const client = getClient();
      await client.reset();
      // The connected demo account starts again with its test USDC.
      if (account) await client.faucet(account, DEMO_FAUCET_USDC);
      setStage("idle");
      router.push("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("confirm");
    }
  }

  if (stage === "idle") {
    return (
      <button
        type="button"
        onClick={() => setStage("confirm")}
        className="text-subtle underline decoration-line-strong underline-offset-2 hover:text-fg"
      >
        Reset demo data
      </button>
    );
  }
  return (
    <div className="space-y-1.5">
      <p className="text-muted">Delete every sale, bid and balance in this browser and start fresh?</p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={reset}
          disabled={stage === "busy"}
          className="text-bad underline decoration-bad/40 underline-offset-2 hover:decoration-bad"
        >
          {stage === "busy" ? "Resetting…" : "Reset"}
        </button>
        <button type="button" onClick={() => setStage("idle")} disabled={stage === "busy"} className="hover:text-fg">
          Cancel
        </button>
      </div>
      {error && (
        <p role="alert" className="text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

function ShellFooter({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-2 text-[11.5px] leading-snug text-subtle", className)}>
      <p>
        Built on NEAR · OutLayer TEE · NEAR Intents
        <br />
        Unaudited. Testnet. The chain is simulated in this demo.
      </p>
      <ResetDemo />
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Mobile navigation drawer: focus stays inside, Escape or any link closes it. */
function MobileDrawer({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      const panel = panelRef.current;
      if (e.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        // Any link inside (nav, logo, judge mode) navigates, so close on it.
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) onClose();
        }}
        className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col gap-5 overflow-y-auto border-r border-dashed border-line-dashed bg-bg p-4"
      >
        <div className="flex items-center justify-between">
          <Logo />
          <button
            ref={closeRef}
            type="button"
            className="btn-tactile inline-flex size-9 items-center justify-center"
            onClick={onClose}
            aria-label="Close menu"
          >
            <X className="size-4" />
          </button>
        </div>
        <NavList />
        <div className="mt-auto space-y-4">
          <JudgeCard />
          <ShellFooter className="px-1" />
        </div>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    menuRef.current?.focus();
  }, []);

  return (
    <div className="hatch min-h-dvh">
      <div className="mx-auto flex min-h-dvh max-w-[1360px] border-x border-dashed border-line-dashed bg-bg">
        {/* Sidebar (desktop) */}
        <aside className="sticky top-0 hidden h-dvh w-[232px] shrink-0 flex-col border-r border-dashed border-line-dashed lg:flex">
          <div className="flex h-[56px] items-center border-b border-dashed border-line-dashed px-4">
            <Logo />
          </div>
          <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
            <p className="px-1.5 text-[13px] leading-snug text-fg/90">
              Sealed bids, one clearing price. Bots and you pay the same.
            </p>
            <div className="border-t border-dashed border-line-dashed" />
            <div>
              <div className="mb-2 px-2.5 text-[12px] text-subtle">Browse</div>
              <NavList />
            </div>
            <div className="mt-auto">
              <JudgeCard />
            </div>
          </div>
          <ShellFooter className="border-t border-dashed border-line-dashed px-4 py-3" />
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-[56px] items-center gap-3 border-b border-dashed border-line-dashed bg-bg/85 px-4 backdrop-blur-md sm:px-6">
            <button
              ref={menuRef}
              type="button"
              className="btn-tactile inline-flex size-9 shrink-0 items-center justify-center lg:hidden"
              onClick={() => setOpen(true)}
              aria-label="Open menu"
              aria-expanded={open}
            >
              <Menu className="size-4" />
            </button>
            {/* At phone width the orb stands in for the wordmark, so the header fits. */}
            <Logo className="lg:hidden" wordmarkClassName="hidden sm:inline" />
            <div className="ml-auto flex min-w-0 items-center gap-2">
              <span
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-elev-2 px-2.5 text-[12px] text-muted ring-1 ring-line"
                title="NEAR testnet. In this demo the chain itself is simulated in your browser."
              >
                <span className="size-1.5 rounded-full bg-warn" aria-hidden />
                testnet
              </span>
              <ConnectButton />
            </div>
          </header>
          <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">{children}</main>
        </div>
      </div>

      {open && <MobileDrawer onClose={close} />}
    </div>
  );
}
