import { useId } from "react";
import { cn } from "@/lib/cn";

/**
 * Small marks for the chains 1Click can fund a bid from, keyed by the 1Click
 * `blockchain` code (see ORIGINS in lib/oneclick.ts). Drawn inline, so they
 * need no network and stay sharp at any size. Decorative: the chain's name is
 * always written next to the mark.
 */
export function ChainLogo({ chain, className }: { chain: string; className?: string }) {
  const id = useId();
  const box = cn("size-4 shrink-0", className);
  switch (chain) {
    case "base":
      return (
        <svg viewBox="0 0 24 24" className={box} aria-hidden>
          <circle cx="12" cy="12" r="9.9" fill="#fff" />
          <path
            transform="translate(2 2) scale(0.18176)"
            fill="#0052FF"
            d="M54.921 110.034C85.359 110.034 110.034 85.402 110.034 55.017C110.034 24.6319 85.359 0 54.921 0C26.0432 0 2.35281 22.1714 0 50.3923H72.8467V59.6416H0C2.35281 87.8625 26.0432 110.034 54.921 110.034Z"
          />
        </svg>
      );
    case "arb":
      return (
        <svg viewBox="0 0 32 32" className={box} aria-hidden>
          <path
            d="M16 2.6 28 9.5v13L16 29.4 4 22.5v-13Z"
            fill="#213147"
            stroke="#9DCCED"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M9.6 22.6 15 9.6" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M15 9.6h2.2" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
          <path d="m16.6 14.6 3.4 8M18.6 9.6l5.2 12.4" stroke="#12AAFF" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      );
    case "eth":
      return (
        <svg viewBox="0 0 32 32" className={box} aria-hidden>
          <circle cx="16" cy="16" r="16" fill="#627EEA" />
          <g fill="#fff">
            <path fillOpacity=".6" d="M16.5 4v8.87l7.5 3.35z" />
            <path d="M16.5 4 9 16.22l7.5-3.35z" />
            <path fillOpacity=".6" d="M16.5 21.97V28L24 17.62z" />
            <path d="M16.5 28v-6.03L9 17.62z" />
            <path fillOpacity=".2" d="m16.5 20.57 7.5-4.35-7.5-3.35z" />
            <path fillOpacity=".6" d="m9 16.22 7.5 4.35v-7.7z" />
          </g>
        </svg>
      );
    case "sol":
      return (
        <svg viewBox="0 0 32 32" className={box} aria-hidden>
          <defs>
            <linearGradient id={`${id}-sol`} x1="1" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#00FFA3" />
              <stop offset="1" stopColor="#DC1FFF" />
            </linearGradient>
          </defs>
          <circle cx="16" cy="16" r="16" fill="#000" />
          <g transform="translate(7 8.95) scale(0.04526)" fill={`url(#${id}-sol)`}>
            <path d="M64.6 0h333.1l-64.6 77.6H0Z" />
            <path d="M0 116.3h333.1l64.6 77.6H64.6Z" />
            <path d="M64.6 234.1h333.1l-64.6 77.6H0Z" />
          </g>
        </svg>
      );
    case "btc":
      return (
        <svg viewBox="0 0 32 32" className={box} aria-hidden>
          <circle cx="16" cy="16" r="16" fill="#F7931A" />
          <g fill="#fff" transform="rotate(14 16 16)">
            <path
              fillRule="evenodd"
              d="M11 9h6.3c2.3 0 3.6 1.1 3.6 3 0 1.3-.7 2.3-1.9 2.7 1.6.4 2.6 1.6 2.6 3.3 0 2.3-1.5 4-4 4H11Zm2.4 2v3h3.4c1.1 0 1.7-.6 1.7-1.5s-.6-1.5-1.7-1.5Zm0 4.9V20h3.8c1.2 0 1.9-.8 1.9-2.05s-.7-2.05-1.9-2.05Z"
            />
            <rect x="13.2" y="6.8" width="1.5" height="2.6" rx=".3" />
            <rect x="16.1" y="6.8" width="1.5" height="2.6" rx=".3" />
            <rect x="13.2" y="20.6" width="1.5" height="2.6" rx=".3" />
            <rect x="16.1" y="20.6" width="1.5" height="2.6" rx=".3" />
          </g>
        </svg>
      );
    default:
      return null;
  }
}
