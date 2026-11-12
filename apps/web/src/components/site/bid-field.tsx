"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotionSafe } from "@/components/visual/use-reduced-motion";
import { cn } from "@/lib/cn";
import { rng } from "@/components/visual/seed";

/**
 * The landing page's moving picture: one sealed-bid sale, start to finish,
 * on a loop. Each dot is a bid. Across is when it arrived; up is its max
 * price, which stays hidden (every dot sits in one sealed lane) until the
 * enclave opens the bids at close. A blue line then drops to the clearing
 * price, the bids above it win, and every winner, bot or person, slides onto
 * that one line: they all pay the same price.
 *
 * It is an illustration, not data: the bids are seeded noise. Canvas 2D,
 * paused when off screen or in a background tab. Reduced motion shows the
 * settled frame and does not loop.
 */

type Bid = { t: number; price: number; bot: boolean; lane: number; win: boolean; rank: number };

const PEOPLE = 116;
const BOTS = 8;
/** Share of bids that win (the supply runs out below them). */
const WIN_SHARE = 0.52;

// Timeline, seconds into one loop.
const T_CLOSE = 4.4;
const T_OPEN = 5.1;
const T_OPEN_END = 6.5;
const T_CLEAR = 6.8;
const T_CLEAR_END = 7.9;
const T_SETTLE = 8.2;
const T_SETTLE_END = 9.4;
const T_FADE = 11.2;
const LOOP = 11.8;

export const BID_FIELD_PHASES = [
  { label: "Bids arrive sealed", at: 0 },
  { label: "Sale closes", at: T_CLOSE },
  { label: "Enclave opens every bid", at: T_OPEN },
  { label: "One clearing price", at: T_CLEAR },
  { label: "Every winner pays it", at: T_SETTLE },
] as const;

function makeBids(seed: number): { bids: Bid[]; clear: number } {
  const r = rng(seed * 7919 + 17);
  const bids: Bid[] = [];
  for (let i = 0; i < BOTS; i++) {
    // Bots are first in, at the very start, and bid near the top.
    bids.push({ t: r() * 0.025, price: 0.8 + r() * 0.17, bot: true, lane: r() * 2 - 1, win: false, rank: 0 });
  }
  for (let i = 0; i < PEOPLE; i++) {
    // People arrive through the window, early-skewed; prices bunch in the middle.
    const p = 0.1 + 0.72 * ((r() + r() + r()) / 3) + (r() < 0.12 ? r() * 0.18 : 0);
    bids.push({ t: 0.04 + Math.pow(r(), 1.45) * 0.94, price: Math.min(0.97, p), bot: false, lane: r() * 2 - 1, win: false, rank: 0 });
  }
  const byPrice = [...bids].sort((a, b) => b.price - a.price);
  const winners = Math.round(bids.length * WIN_SHARE);
  byPrice.forEach((b, i) => {
    b.win = i < winners;
    b.rank = i / bids.length;
  });
  const clear = byPrice[winners - 1].price;
  return { bids, clear };
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const easeOut = (x: number) => 1 - Math.pow(1 - clamp(x), 3);
const easeInOut = (x: number) => {
  const c = clamp(x);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
};
/** A small overshoot for a dot popping in. */
const easeBack = (x: number) => {
  const c = clamp(x);
  const k = 1.9;
  return 1 + (k + 1) * Math.pow(c - 1, 3) + k * Math.pow(c - 1, 2);
};

function readColors(el: HTMLElement) {
  const s = getComputedStyle(el);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    sealed: v("--field-sealed", "rgba(255,255,255,0.55)"),
    open: v("--field-open", "rgba(255,255,255,0.72)"),
    lost: v("--field-lost", "rgba(255,255,255,0.18)"),
    win: v("--field-win", "#5b93ff"),
    bot: v("--field-bot", "#a78bfa"),
    guide: v("--field-guide", "rgba(255,255,255,0.05)"),
    close: v("--field-close", "rgba(255,255,255,0.28)"),
    line: v("--field-line", "#3d7eff"),
    ink: v("--fg", "#f7f8f8"),
    pill: v("--bg-elev-2", "#17181a"),
    pillLine: v("--line-strong", "rgba(255,255,255,0.14)"),
    font: s.fontFamily || "sans-serif",
  };
}

export function BidField({ className }: { className?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotionSafe();
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!wrap || !canvas || !ctx) return;

    let colors = readColors(wrap);
    let w = 0;
    let h = 0;
    let dpr = 1;
    // Set when the field shows a still frame: resizing a canvas clears it, so it is drawn again.
    let redraw: (() => void) | null = null;
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = wrap.clientWidth;
      h = wrap.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      colors = readColors(wrap);
      redraw?.();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    // The theme toggle swaps the tokens; re-read them.
    const mo = new MutationObserver(() => {
      colors = readColors(wrap);
      redraw?.();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    let loop = 0;
    let data = makeBids(loop);
    let shownPhase = -1;
    let shownCount = -1;

    const draw = (s: number) => {
      const padL = 18;
      const padR = 18;
      const padT = 26;
      const padB = 30;
      const iw = w - padL - padR;
      const ih = h - padT - padB;
      const X = (t: number) => padL + t * iw;
      const Y = (p: number) => padT + (1 - p) * ih;
      const laneY = padT + ih * 0.5;
      const clearY = Y(data.clear);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const fade = s > T_FADE ? 1 - clamp((s - T_FADE) / (LOOP - T_FADE)) : 1;
      ctx.globalAlpha = fade;

      // Guides.
      ctx.strokeStyle = colors.guide;
      ctx.lineWidth = 1;
      for (let i = 1; i <= 4; i++) {
        const y = Math.round(padT + (ih * i) / 5) + 0.5;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
        ctx.stroke();
      }

      // The close: a vertical rule drawn down the right edge.
      if (s > T_CLOSE) {
        const k = easeOut((s - T_CLOSE) / 0.6);
        const x = Math.round(X(1)) + 0.5;
        ctx.strokeStyle = colors.close;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(x, padT - 10);
        ctx.lineTo(x, padT - 10 + (ih + 20) * k);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // The clearing line drops from the top to the clearing price.
      let lineY = -1;
      if (s > T_CLEAR) {
        lineY = padT - 6 + (clearY - padT + 6) * easeOut((s - T_CLEAR) / (T_CLEAR_END - T_CLEAR));
        const glow = s > T_SETTLE ? 0.5 + 0.5 * easeOut((s - T_SETTLE) / 0.8) : 0.35;
        ctx.save();
        ctx.strokeStyle = colors.line;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = colors.line;
        ctx.shadowBlur = 14 * glow;
        ctx.beginPath();
        ctx.moveTo(padL, lineY);
        ctx.lineTo(w - padR, lineY);
        ctx.stroke();
        ctx.restore();
      }

      // Bids.
      let count = 0;
      for (let i = 0; i < data.bids.length; i++) {
        const b = data.bids[i];
        const appear = 0.25 + b.t * (T_CLOSE - 0.6);
        if (s < appear) continue;
        count++;
        const pop = easeBack((s - appear) / 0.4);
        const x = X(b.t);
        const sealedY = laneY + b.lane * ih * 0.07;
        const trueY = Y(b.price);
        // Open: each bid leaves the sealed lane for its real price, staggered.
        const open = easeInOut((s - T_OPEN - (i % 24) * 0.022) / (T_OPEN_END - T_OPEN - 0.4));
        let y = sealedY + (trueY - sealedY) * open;
        const passed = lineY >= 0 && trueY <= lineY + 0.5;
        const decided = s > T_CLEAR_END;
        let alpha = 1;
        if (b.win) {
          // Settle: every winner slides onto the clearing line.
          const settle = easeInOut((s - T_SETTLE - b.rank * 1.1) / (T_SETTLE_END - T_SETTLE - 0.5));
          y = y + (clearY - y) * settle;
        } else if (decided) {
          const k = easeOut((s - T_CLEAR_END) / 0.6);
          alpha = 1 - 0.7 * k;
          y += 8 * k;
        }

        const r = (b.bot ? 2.9 : 2.5) * pop;
        if (open <= 0) {
          // Sealed: an outline. Bots are marked violet so you can see them arrive first.
          ctx.globalAlpha = fade;
          ctx.strokeStyle = b.bot ? colors.bot : colors.sealed;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.stroke();
          continue;
        }
        const lit = b.win && (passed || decided);
        ctx.globalAlpha = fade * alpha;
        ctx.fillStyle = b.bot ? colors.bot : lit ? colors.win : open < 1 || !decided ? colors.open : colors.lost;
        if (lit) {
          ctx.shadowColor = b.bot ? colors.bot : colors.win;
          ctx.shadowBlur = 10;
        }
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = fade;

      // The price pill on the line once winners have landed on it.
      if (s > T_SETTLE + 0.3 && lineY >= 0) {
        const k = easeOut((s - T_SETTLE - 0.3) / 0.5);
        const text = "Everyone pays the clearing price";
        ctx.font = `510 12px ${colors.font}`;
        const tw = ctx.measureText(text).width;
        const pw = tw + 20;
        const ph = 24;
        const px = w - padR - pw - 8;
        const py = lineY - ph / 2;
        ctx.globalAlpha = fade * k;
        ctx.fillStyle = colors.pill;
        ctx.strokeStyle = colors.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(px + 0.5, py + 0.5, pw, ph, 12);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = colors.ink;
        ctx.textBaseline = "middle";
        ctx.fillText(text, px + 10, lineY + 1);
      }
      ctx.globalAlpha = 1;

      if (count !== shownCount && countRef.current) {
        shownCount = count;
        countRef.current.textContent = String(count);
      }
      let p = 0;
      for (let i = 0; i < BID_FIELD_PHASES.length; i++) if (s >= BID_FIELD_PHASES[i].at) p = i;
      if (p !== shownPhase) {
        shownPhase = p;
        setPhase(p);
      }
    };

    if (reduce) {
      redraw = () => draw(T_SETTLE_END + 0.6);
      redraw();
      return () => {
        ro.disconnect();
        mo.disconnect();
      };
    }

    let raf = 0;
    let visible = true;
    let start = performance.now();
    let pausedAt = 0;
    const frame = (now: number) => {
      let s = (now - start) / 1000;
      if (s >= LOOP) {
        loop++;
        data = makeBids(loop);
        start = now;
        s = 0;
      }
      draw(s);
      raf = requestAnimationFrame(frame);
    };
    const play = () => {
      if (raf) return;
      if (pausedAt) start += performance.now() - pausedAt;
      pausedAt = 0;
      raf = requestAnimationFrame(frame);
    };
    const pause = () => {
      if (!raf) return;
      cancelAnimationFrame(raf);
      raf = 0;
      pausedAt = performance.now();
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !document.hidden) play();
      else pause();
    });
    io.observe(wrap);
    const onVis = () => (document.hidden || !visible ? pause() : play());
    document.addEventListener("visibilitychange", onVis);
    play();
    return () => {
      pause();
      io.disconnect();
      ro.disconnect();
      mo.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [reduce]);

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex items-center justify-between gap-3 px-4 pt-3.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5 text-label">
          <span className="relative inline-flex size-1.5 shrink-0" aria-hidden>
            <span className="ping-ring absolute inset-0 rounded-full bg-live" />
            <span className="relative size-1.5 rounded-full bg-live" />
          </span>
          <span className="truncate font-[510] text-fg">A sale, start to finish</span>
          <span className="hidden text-subtle sm:inline">
            <span ref={countRef} className="num">
              0
            </span>{" "}
            sealed bids
          </span>
        </div>
        <div className="flex items-center gap-3 text-label text-subtle">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-bot" aria-hidden /> Bot
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-accent" aria-hidden /> Wins
          </span>
        </div>
      </div>
      <div ref={wrapRef} className="bid-field relative h-[260px] w-full sm:h-[340px]">
        <canvas ref={canvasRef} className="absolute inset-0" aria-hidden />
        <span className="pointer-events-none absolute bottom-2 left-[18px] text-[11px] text-subtle">Arrival</span>
        <span className="pointer-events-none absolute right-[18px] bottom-2 text-[11px] text-subtle">Close</span>
      </div>
      <ol className="grid grid-cols-5 gap-px border-t border-line text-[11.5px] sm:text-label" aria-label="Sale phases">
        {BID_FIELD_PHASES.map((p, i) => (
          <li
            key={p.label}
            aria-current={i === phase ? "step" : undefined}
            className={cn(
              "relative px-2 py-3 text-center leading-tight transition-colors duration-300 sm:px-3",
              i === phase ? "text-fg" : i < phase ? "text-muted" : "text-subtle",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "absolute inset-x-3 top-0 h-px origin-left bg-accent transition-transform duration-500 ease-out",
                i <= phase ? "scale-x-100" : "scale-x-0",
              )}
            />
            {p.label}
          </li>
        ))}
      </ol>
    </div>
  );
}
