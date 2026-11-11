"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { getClient } from "@/lib/client";
import { isNearMode } from "@/lib/config";
import { networkName } from "@/lib/format";
import { DEMO_FAUCET_USDC, useWallet } from "@/lib/wallet";
import { Button } from "@/components/ui/button";
import { MotionProvider } from "@/components/visual/motion-provider";
import { ConnectButton } from "./connect-button";
import { NAV } from "./nav";
import { ThemeToggle } from "./theme-toggle";

export function Logo({ className, wordmarkClassName }: { className?: string; wordmarkClassName?: string }) {
  return (
    <Link
      href="/"
      className={cn("flex min-h-11 shrink-0 items-center gap-2 rounded-btn text-fg", className)}
      aria-label="Sealround home"
    >
      {/* The negative space between the two solid halves is the clearing line. */}
      <svg aria-hidden="true" className="size-5 shrink-0 text-accent-bright" viewBox="0 0 20 20" fill="currentColor">
        <path d="M3 9a8 7 0 0 1 16 0ZM17 11a8 7 0 0 1-16 0Z" />
      </svg>
      <span aria-hidden className={cn("text-[15px] font-semibold tracking-[-0.03em] max-[359px]:text-[14px] sm:text-[16px]", wordmarkClassName)}>
        Sealround
      </span>
    </Link>
  );
}

/** Judge mode invents a sale and its bidders: only the simulated chain can do that. */
const navItems = () => (isNearMode() ? NAV.filter((n) => n.href !== "/judge") : NAV);

/**
 * The pathname is unknown while prerendering dynamic routes such as
 * /sale/[id] (Cache Components), so only the active-state read sits inside
 * Suspense. The fallback is the same list with nothing highlighted.
 */
function NavList({ layout }: { layout: "bar" | "drawer" }) {
  return (
    <Suspense fallback={<NavLinks path={null} layout={layout} />}>
      <ActiveNavLinks layout={layout} />
    </Suspense>
  );
}

function ActiveNavLinks({ layout }: { layout: "bar" | "drawer" }) {
  const path = usePathname();
  return <NavLinks path={path} layout={layout} />;
}

function NavLinks({ path, layout }: { path: string | null; layout: "bar" | "drawer" }) {
  const items = navItems();
  if (layout === "drawer") {
    return (
      <nav aria-label="Main">
        <ul className="flex flex-col">
          {items.map((n) => {
            const active = path !== null && n.match(path);
            return (
              <li key={n.href} className="border-b border-line">
                <Link
                  href={n.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-[56px] items-center text-[20px] font-[510] tracking-[-0.016em] transition-colors",
                    active ? "text-accent-bright" : "text-muted hover:text-fg",
                  )}
                >
                  {n.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }
  return (
    <nav aria-label="Main" className="hidden min-w-0 lg:block">
      <ul className="flex items-center xl:gap-1">
        {items.map((n) => {
          const active = path !== null && n.match(path);
          return (
            <li key={n.href}>
              <Link
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-btn px-2 text-[14px] whitespace-nowrap transition-colors duration-[120ms] ease-surface xl:px-2.5",
                  active ? "bg-accent-soft text-accent-bright" : "text-muted hover:bg-wash-soft hover:text-fg",
                )}
              >
                {n.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
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
        className="inline-flex min-h-6 items-center rounded-sm text-muted underline decoration-line-strong underline-offset-[3px] transition-colors hover:text-fg"
      >
        Reset demo data
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1" role="group" aria-label="Reset demo data">
      <span className="text-muted">Delete every sale, bid and balance in this browser and start fresh?</span>
      <button
        type="button"
        onClick={reset}
        disabled={stage === "busy"}
        className="inline-flex min-h-6 items-center rounded-sm font-[510] text-bad underline decoration-bad/40 underline-offset-[3px] hover:decoration-bad"
      >
        {stage === "busy" ? "Resetting…" : "Reset"}
      </button>
      <button
        type="button"
        onClick={() => setStage("idle")}
        disabled={stage === "busy"}
        className="inline-flex min-h-6 items-center rounded-sm text-muted hover:text-fg"
      >
        Cancel
      </button>
      {error && (
        <p role="alert" className="w-full text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

function ShellFooter({ className }: { className?: string }) {
  const near = isNearMode();
  const network = networkName();
  return (
    <div
      className={cn(
        "flex flex-col gap-x-8 gap-y-2 text-label text-subtle sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <p>
        {near
          ? `Sealround runs on NEAR ${network}${network === "sandbox" ? ", a local chain" : ""}. Unaudited.`
          : "Sealround is unaudited. In this demo the chain is simulated in your browser."}{" "}
        Built on NEAR, OutLayer TEE and NEAR Intents.
      </p>
      {/* There is demo data to wipe only on the simulated chain. */}
      {!near && <ResetDemo />}
    </div>
  );
}

/**
 * Honest environment label. In the demo the chain itself runs in the browser,
 * so it says "Simulated"; against a real contract it names the network.
 */
function NetworkPill() {
  const near = isNearMode();
  const network = networkName();
  return (
    <span
      className="inline-flex h-8 shrink-0 items-center px-1 text-label text-muted max-[359px]:px-0 sm:px-1.5"
      title={
        near
          ? `NEAR ${network}. Sales live on a deployed contract.`
          : "A simulated chain in your browser. Encryption and the clearing math are real."
      }
    >
      {near ? network : "Simulated"}
    </span>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Phone navigation: a full-height sheet. Focus stays inside; Escape or any link closes it. */
function MobileDrawer({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const wide = window.matchMedia("(min-width: 64rem)");
    const onViewportChange = () => {
      if (wide.matches) onClose();
    };

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
    wide.addEventListener("change", onViewportChange);
    return () => {
      document.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onViewportChange);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
      <motion.div
        ref={panelRef}
        // Any link inside (nav, logo) navigates, so close on it.
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) onClose();
        }}
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
        className="absolute inset-0 flex flex-col overflow-y-auto bg-bg px-4 pb-6 sm:px-6"
      >
        <div className="flex h-14 shrink-0 items-center justify-between">
          <Logo />
          <Button ref={closeRef} type="button" size="square" onClick={onClose} aria-label="Close menu">
            <X aria-hidden />
          </Button>
        </div>
        <div className="mt-4 border-t border-line">
          <NavList layout="drawer" />
        </div>
        <div className="flex min-h-14 items-center justify-between border-b border-line text-small text-muted sm:hidden">
          <span>Appearance</span>
          <ThemeToggle showLabel />
        </div>
        <ShellFooter className="mt-auto pt-10" />
      </motion.div>
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
    <MotionProvider>
      <a
        href="#main"
        className="sr-only z-[60] rounded-btn bg-fg px-3 py-2 text-[14px] font-[510] text-bg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-bg">
          <div className="mx-auto flex h-14 max-w-[1240px] items-center gap-2 px-4 max-[359px]:gap-1 max-[359px]:px-3 sm:gap-4 sm:px-6 xl:gap-6 xl:px-8">
            <Logo className="max-[359px]:gap-1.5" />
            <NavList layout="bar" />
            <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2.5">
              <div className="hidden sm:block">
                <ThemeToggle />
              </div>
              <NetworkPill />
              <ConnectButton />
              <Button
                ref={menuRef}
                type="button"
                size="square"
                className="lg:hidden"
                onClick={() => setOpen(true)}
                aria-label="Open menu"
                aria-expanded={open}
              >
                <Menu aria-hidden />
              </Button>
            </div>
          </div>
        </header>

        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1240px] flex-1 px-4 pt-8 pb-24 outline-none sm:px-6 sm:pt-10 lg:px-8 lg:pt-12"
        >
          {children}
        </main>

        <footer className="border-t border-line">
          <ShellFooter className="mx-auto max-w-[1240px] px-4 py-5 sm:px-6 lg:px-8" />
        </footer>

        <AnimatePresence>{open && <MobileDrawer key="drawer" onClose={close} />}</AnimatePresence>
      </div>
    </MotionProvider>
  );
}
