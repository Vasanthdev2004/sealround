"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { getClient } from "@/lib/client";
import { isNearMode } from "@/lib/config";
import { networkName } from "@/lib/format";
import { TESTNET_APP_URL } from "@/lib/site";
import { DEMO_FAUCET_USDC, useWallet } from "@/lib/wallet";
import { Button } from "@/components/ui/button";
import { MotionProvider } from "@/components/visual/motion-provider";
import { SpotlightTracker } from "@/components/visual/spotlight";
import { ConnectButton } from "./connect-button";
import { NAV } from "./nav";
import { ThemeToggle } from "./theme-toggle";

export function Logo({
  className,
  wordmarkClassName,
  href = "/sales",
  label = "Sealround sales",
}: {
  className?: string;
  wordmarkClassName?: string;
  href?: string;
  label?: string;
}) {
  return (
    <Link
      href={href}
      className={cn("flex min-h-11 shrink-0 items-center gap-2 rounded-btn text-fg", className)}
      aria-label={label}
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
  return <BarNav items={items} path={path} />;
}

/** Desktop nav. A soft highlight glides to whichever link the pointer is over. */
function BarNav({ items, path }: { items: ReturnType<typeof navItems>; path: string | null }) {
  const [hover, setHover] = useState<string | null>(null);
  return (
    <nav aria-label="Main" className="hidden min-w-0 lg:block">
      <ul className="flex items-center xl:gap-1" onPointerLeave={() => setHover(null)}>
        {items.filter((n) => n.primary || (path !== null && n.match(path))).map((n) => {
          const active = path !== null && n.match(path);
          return (
            <li key={n.href} className="relative">
              {hover === n.href && !active && (
                <motion.span
                  layoutId="nav-hover"
                  aria-hidden
                  className="absolute inset-0 rounded-btn bg-wash-soft"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ type: "spring", stiffness: 520, damping: 40, mass: 0.8 }}
                />
              )}
              <Link
                href={n.href}
                aria-current={active ? "page" : undefined}
                onPointerEnter={(e) => e.pointerType === "mouse" && setHover(n.href)}
                className={cn(
                  "relative inline-flex h-8 items-center rounded-btn px-2 text-[14px] whitespace-nowrap transition-colors duration-150 ease-surface xl:px-2.5",
                  active ? "bg-accent-soft text-accent-bright" : "text-muted hover:text-fg",
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
      const { resetDemo } = await import("@/lib/chapters/demo");
      resetDemo();
      // The connected demo account starts again with its test USDC.
      if (account) await client.faucet(account, DEMO_FAUCET_USDC);
      setStage("idle");
      router.push("/sales");
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
      <span className="text-muted">Reset your demo sales, bids, balances and chapters in this browser?</span>
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
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
        <nav aria-label="Resources" className="flex flex-wrap gap-x-4 gap-y-2">
          {navItems().filter((item) => !item.primary).map((item) => (
            <Link key={item.href} href={item.href} className="inline-flex min-h-8 items-center text-muted transition-colors hover:text-fg">{item.label}</Link>
          ))}
        </nav>
        {!near && <ResetDemo />}
      </div>
    </div>
  );
}

/**
 * Honest environment label. In the demo the chain itself runs in the browser,
 * so it says "Simulated"; against a real contract it names the network.
 */
/** On mainnet, real money moves: say once, above everything, that this is an unaudited experiment. */
function MainnetNotice() {
  if (!isNearMode() || networkName() !== "mainnet") return null;
  return (
    <p className="border-b border-line bg-elev px-4 py-2 text-center text-label text-muted">
      <span className="font-[510] text-warn">Unaudited experiment.</span> Sealround runs on NEAR mainnet with capped
      deposits. If a sale fails, every deposit can be refunded. Bid only what you can afford to lose.
    </p>
  );
}

/**
 * The simulated demo's wallet is a demo account. Say so above everything and
 * link the testnet app, where a real NEAR wallet connects.
 */
export function DemoNotice() {
  if (isNearMode()) return null;
  return (
    <p className="border-b border-line bg-elev px-4 py-2 text-center text-label text-muted">
      <span className="max-sm:hidden">This demo runs on a simulated chain with a demo wallet. </span>
      <span className="sm:hidden">Simulated demo. </span>
      <a
        href={TESTNET_APP_URL}
        className="inline-flex items-center gap-1 font-[510] text-accent-bright underline-offset-2 hover:underline"
      >
        <span className="max-sm:hidden">Use a real NEAR wallet on testnet</span>
        <span className="sm:hidden">Real wallet on testnet</span>
        <ArrowUpRight className="size-3.5" aria-hidden />
      </a>
    </p>
  );
}

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
      <div className="backdrop" aria-hidden />
      <SpotlightTracker />
      <a
        href="#main"
        className="sr-only z-[60] rounded-btn bg-fg px-3 py-2 text-[14px] font-[510] text-bg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <div className="flex min-h-dvh flex-col">
        <MainnetNotice />
        <DemoNotice />
        <header className="material sticky top-0 z-30 border-b border-line">
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
