import { Tag } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import type { Tone } from "@/lib/format";

const STEPS: { title: string; who: string; tone: Tone; body: React.ReactNode }[] = [
  {
    title: "Creator sets the sale",
    who: "creator",
    tone: "neutral",
    body: "Supply for sale, floor price, minimum raise, bid window and per-account caps. Fairground deploys the token with a fixed supply. Every parameter is locked at creation; there is no admin key.",
  },
  {
    title: "Bidder gets USDC on NEAR",
    who: "bidder",
    tone: "accent",
    body: "Either they already hold it, or they fund from SOL, ETH, BTC or USDC on another chain through NEAR Intents 1Click. The USDC lands in their own NEAR account.",
  },
  {
    title: "Bidder submits a sealed bid",
    who: "bidder",
    tone: "accent",
    body: "One transfer carries a public USDC deposit plus an encrypted payload: max price, max spend and a random salt. The browser seals it to the sale’s enclave key, so only the enclave can open it.",
  },
  {
    title: "The window closes",
    who: "anyone",
    tone: "neutral",
    body: "After the window ends, anyone can call close. The bid set is frozen on-chain and the contract stores its hash.",
  },
  {
    title: "The enclave clears the sale",
    who: "OutLayer TEE",
    tone: "warn",
    body: "Inside the TEE, the job decrypts every bid, computes the clearing price and each fill, and returns a signed result. The contract checks the arithmetic it can see, then settles.",
  },
  {
    title: "Everyone claims",
    who: "every bidder",
    tone: "ok",
    body: "Winners get tokens at the clearing price plus any unspent USDC. Losing bids get a full refund. If the minimum raise is missed or clearing fails, everyone is refunded in full.",
  },
];

export function SaleSteps() {
  return (
    <ol className="rounded-panel border border-line bg-elev px-5 pt-5 pb-1">
      {STEPS.map((s, i) => {
        const last = i === STEPS.length - 1;
        return (
          <li key={s.title} className="relative flex gap-4 pb-5">
            {!last && (
              <span
                aria-hidden
                className="absolute top-9 bottom-1 left-[15px] border-l border-dashed border-line-dashed"
              />
            )}
            <span
              className={cn(
                "num relative flex size-8 shrink-0 items-center justify-center rounded-full bg-elev-2 text-[12px] text-muted ring-1 ring-line",
                last && "bg-ok-soft text-ok ring-ok/25",
              )}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
            <div className="min-w-0 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[14px] font-medium tracking-[-0.01em] text-fg">{s.title}</h3>
                <Tag tone={s.tone}>{s.who}</Tag>
              </div>
              <p className="mt-1 max-w-2xl text-[13.5px] leading-relaxed text-muted">{s.body}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
