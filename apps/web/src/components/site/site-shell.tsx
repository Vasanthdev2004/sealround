"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Logo } from "@/components/shell/app-shell";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { MotionProvider } from "@/components/visual/motion-provider";
import { SpotlightTracker } from "@/components/visual/spotlight";
import { REPO_URL, appHref } from "@/lib/site";

const LINKS = [
  { href: appHref("/sales"), label: "Sales" },
  { href: appHref("/verify"), label: "Verify a launch" },
  { href: appHref("/how"), label: "How it works" },
];

/** The landing page's frame: a slim translucent bar, the page, and a footer with every way in. */
export function SiteShell({ children }: { children: React.ReactNode }) {
  return (
    <MotionProvider>
      <SpotlightTracker />
      <a
        href="#main"
        className="sr-only z-[60] rounded-btn bg-fg px-3 py-2 text-[14px] font-[510] text-bg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <div className="flex min-h-dvh flex-col">
        <header className="material sticky top-0 z-30 border-b border-line">
          <div className="mx-auto flex h-14 max-w-[1240px] items-center gap-4 px-4 sm:px-6 lg:px-8">
            <Logo href="/" label="Sealround home" />
            <nav aria-label="Main" className="hidden md:block">
              <ul className="flex items-center gap-1">
                {LINKS.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      className="inline-flex h-8 items-center rounded-btn px-2.5 text-[14px] text-muted transition-colors duration-150 hover:bg-wash-soft hover:text-fg"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
                <li>
                  <a
                    href={REPO_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center rounded-btn px-2.5 text-[14px] text-muted transition-colors duration-150 hover:bg-wash-soft hover:text-fg"
                  >
                    GitHub
                  </a>
                </li>
              </ul>
            </nav>
            <div className="ml-auto flex items-center gap-2">
              <ThemeToggle />
              <ButtonLink href={appHref()} variant="primary" size="sm">
                Launch app <ArrowRight className="size-3.5" aria-hidden />
              </ButtonLink>
            </div>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="flex-1 outline-none">
          {children}
        </main>

        <SiteFooter />
      </div>
    </MotionProvider>
  );
}

function SiteFooter() {
  const cols = [
    {
      title: "Product",
      links: [
        { href: appHref(), label: "Sales" },
        { href: appHref("/create"), label: "Launch a sale" },
        { href: appHref("/activity"), label: "Your activity" },
        { href: appHref("/verify"), label: "Verify a launch" },
        { href: appHref("/judge"), label: "Judge mode" },
        { href: appHref("/arena"), label: "Bot Arena" },
      ],
    },
    {
      title: "Learn",
      links: [
        { href: appHref("/how"), label: "How it works" },
        { href: REPO_URL, label: "Source code", external: true },
      ],
    },
  ];
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid max-w-[1240px] gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr] lg:px-8">
        <div className="max-w-sm">
          <Logo href="/" label="Sealround home" />
          <p className="mt-3 text-small text-muted">
            Sealed-bid token sales on NEAR. One clearing price for every winner, bot or person.
          </p>
          <p className="mt-4 text-label text-subtle">
            Unaudited. Built for the NEAR hackathon. Bid only what you can afford to lose.
          </p>
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <h2 className="text-label text-subtle">{c.title}</h2>
            <ul className="mt-3 flex flex-col gap-2">
              {c.links.map((l) => (
                <li key={l.label}>
                  {"external" in l && l.external ? (
                    <a href={l.href} target="_blank" rel="noreferrer" className="text-small text-muted transition-colors hover:text-fg">
                      {l.label}
                    </a>
                  ) : (
                    <Link href={l.href} className="text-small text-muted transition-colors hover:text-fg">
                      {l.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </footer>
  );
}
