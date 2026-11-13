/**
 * The share cards (Open Graph and X `summary_large_image`), 1200 x 630,
 * drawn for `next/og`. They follow UI-DIRECTION.md in its dark theme: the
 * near-black canvas, hairlines, Inter set tight, Base blue for the price and
 * the action, and the landing hero's dot grid and blue light.
 *
 * next/og lays out with flexbox only: every element with more than one child
 * says `display: flex`. Colours are the dark-theme tokens of globals.css,
 * copied here because the renderer cannot read CSS variables.
 */

import { ImageResponse } from "next/og";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import type { OgFont } from "./fonts";
import { heroFontSize, type CardTone, type SaleCard } from "./sale-card";

export const OG_SIZE = { width: 1200, height: 630 };

const C = {
  bg: "#08090a",
  elev: "#0f1011",
  elev2: "#17181a",
  line: "rgba(255, 255, 255, 0.08)",
  lineStrong: "rgba(255, 255, 255, 0.14)",
  fg: "#f7f8f8",
  muted: "#9ea2aa",
  subtle: "#80848c",
  accent: "#3d7eff",
  accentBright: "#5b93ff",
  accentSoft: "rgba(0, 82, 255, 0.18)",
  action: "#0052ff",
  ok: "#4cc38a",
  warn: "#e2a336",
  bot: "#a78bfa",
  people: "#c9ccd1",
  dim: "#3b3e44",
};

const TONE: Record<CardTone, string> = { accent: C.accent, ok: C.ok, warn: C.warn, neutral: C.subtle };

const PAD_X = 64;

const W = 1200;
const H = 630;

// ---------- shared pieces ----------

/**
 * The 24px dot grid, faded the way each surface fades it: from the top
 * centre on the landing page (its hero mask), down the page in the app.
 */
function gridDots(shape: "hero" | "app"): { x: number; y: number; o: number }[] {
  const dots: { x: number; y: number; o: number }[] = [];
  for (let y = 12; y < H; y += 24) {
    for (let x = 12; x < W; x += 24) {
      const reach =
        shape === "hero"
          ? 1 - Math.hypot((x - W / 2) / 760, (y - 40) / 420)
          : 1 - y / 520 - Math.abs(x - W / 2) / 2400;
      const o = Math.min(1, Math.max(0, reach * 1.6)) * 0.13;
      if (o > 0.01) dots.push({ x, y, o: Math.round(o * 1000) / 1000 });
    }
  }
  return dots;
}

const DOTS = { hero: gridDots("hero"), app: gridDots("app") };

/** The canvas: near-black, the dot grid and, on the landing card, the hero's blue light from the top. */
function Canvas({ children, light = false }: { children: ReactNode; light?: boolean }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        backgroundColor: C.bg,
        color: C.fg,
        fontFamily: "Inter",
      }}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", top: 0, left: 0 }}>
        {light && (
          <defs>
            {/* globals.css .hero-backdrop: an ellipse 60% x 55% of the hero at its top, and a smaller core. */}
            <radialGradient
              id="light"
              gradientUnits="userSpaceOnUse"
              cx={W / 2}
              cy={-30}
              r={720}
              gradientTransform={`translate(${W / 2} -30) scale(1 0.5) translate(${-W / 2} 30)`}
            >
              <stop offset="0" stopColor="#0052ff" stopOpacity="0.34" />
              <stop offset="0.7" stopColor="#0052ff" stopOpacity="0" />
            </radialGradient>
            <radialGradient
              id="core"
              gradientUnits="userSpaceOnUse"
              cx={W / 2}
              cy={0}
              r={360}
              gradientTransform={`translate(${W / 2} 0) scale(1 0.55) translate(${-W / 2} 0)`}
            >
              <stop offset="0" stopColor="#5b93ff" stopOpacity="0.2" />
              <stop offset="0.7" stopColor="#5b93ff" stopOpacity="0" />
            </radialGradient>
          </defs>
        )}
        {light && <rect x="0" y="0" width={W} height={H} fill="url(#light)" />}
        {light && <rect x="0" y="0" width={W} height={H} fill="url(#core)" />}
        {DOTS[light ? "hero" : "app"].map((d) => (
          <circle key={`${d.x}-${d.y}`} cx={d.x} cy={d.y} r="1.15" fill="#ffffff" fillOpacity={d.o} />
        ))}
      </svg>
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          padding: `56px ${PAD_X}px`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** The logo: two solid halves, the gap between them the clearing line. */
function Logo({ size = 30 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: Math.round(size * 0.36) }}>
      <svg width={size + 4} height={size + 4} viewBox="0 0 20 20" fill={C.accentBright}>
        <path d="M3 9a8 7 0 0 1 16 0ZM17 11a8 7 0 0 1-16 0Z" />
      </svg>
      <div style={{ fontSize: size, fontWeight: 600, letterSpacing: -0.03 * size }}>Sealround</div>
    </div>
  );
}

function Pill({ children, dot }: { children: ReactNode; dot?: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        height: 46,
        padding: "0 22px",
        borderRadius: 999,
        border: `1px solid ${C.lineStrong}`,
        backgroundColor: C.elev,
        fontSize: 22,
        fontWeight: 500,
        color: C.fg,
      }}
    >
      {dot && <div style={{ width: 11, height: 11, borderRadius: 999, backgroundColor: dot }} />}
      {children}
    </div>
  );
}

/** Cells divided by hairlines, between two hairlines (the app's StatRow). */
function StatRow({ cells, valueSize = 34 }: { cells: { label: string; value: string; unit?: string }[]; valueSize?: number }) {
  return (
    <div style={{ display: "flex", borderTop: `1px solid ${C.line}`, borderBottom: `1px solid ${C.line}` }}>
      {cells.map((c, i) => (
        <div
          key={c.label}
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minWidth: 0,
            gap: 8,
            padding: `18px ${i === cells.length - 1 ? 0 : 24}px 18px ${i === 0 ? 0 : 28}px`,
            borderLeft: i === 0 ? "none" : `1px solid ${C.line}`,
          }}
        >
          <div style={{ fontSize: 21, color: C.subtle }}>{c.label}</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10, minWidth: 0 }}>
            <div
              style={{
                flexShrink: 0,
                whiteSpace: "nowrap",
                fontSize: valueSize,
                fontWeight: 500,
                letterSpacing: -0.024 * valueSize,
                lineHeight: 1.1,
              }}
            >
              {c.value}
            </div>
            {c.unit && (
              <div
                style={{
                  flexShrink: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  textOverflow: "ellipsis",
                  fontSize: 22,
                  color: C.muted,
                  lineHeight: 1.1,
                  paddingBottom: 3,
                }}
              >
                {c.unit}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const headline: CSSProperties = { fontWeight: 500, letterSpacing: -3.2, lineHeight: 1.04 };

// ---------- the landing page ----------

/** Seeded, so the picture is the same on every render (and prerenders). */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIELD_W = W - 2 * PAD_X;
const FIELD_H = 112;
const LINE_Y = 52;

/**
 * The settled frame of the landing hero's bid field: every winning bid, the
 * bots' (violet, first in) and the people's, sits on the one blue clearing
 * line; the bids below it lost. An illustration, not data.
 */
const FIELD = (() => {
  const r = seeded(20261114);
  const dots: { x: number; y: number; r: number; fill: string }[] = [];
  for (let i = 0; i < 6; i++) dots.push({ x: 6 + i * 11 + r() * 3, y: LINE_Y, r: 5.5, fill: C.bot });
  for (let i = 0; i < 52; i++) {
    const x = 48 + Math.pow(r(), 1.2) * (FIELD_W - 290);
    dots.push({ x, y: LINE_Y, r: 5.5, fill: C.people });
  }
  for (let i = 0; i < 46; i++) {
    const x = 30 + Math.pow(r(), 1.2) * (FIELD_W - 60);
    dots.push({ x, y: LINE_Y + 22 + r() * (FIELD_H - LINE_Y - 30), r: 4, fill: C.dim });
  }
  return dots;
})();

function BidLine() {
  return (
    <div style={{ display: "flex", position: "relative", width: FIELD_W, height: FIELD_H }}>
      <svg width={FIELD_W} height={FIELD_H} viewBox={`0 0 ${FIELD_W} ${FIELD_H}`}>
        <line x1="0" y1={LINE_Y} x2={FIELD_W} y2={LINE_Y} stroke={C.accent} strokeWidth="2.5" />
        {FIELD.map((d, i) => (
          <circle key={i} cx={d.x.toFixed(1)} cy={d.y.toFixed(1)} r={d.r} fill={d.fill} />
        ))}
      </svg>
      <div
        style={{
          position: "absolute",
          right: 0,
          top: LINE_Y - 22,
          height: 44,
          display: "flex",
          alignItems: "center",
          padding: "0 20px",
          borderRadius: 999,
          backgroundColor: C.action,
          color: "#fff",
          fontSize: 21,
          fontWeight: 500,
        }}
      >
        One clearing price
      </div>
    </div>
  );
}

export function LandingCard() {
  return (
    <Canvas light>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Logo size={32} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            height: 46,
            padding: "0 22px 0 7px",
            borderRadius: 999,
            border: `1px solid ${C.lineStrong}`,
            backgroundColor: "rgba(15, 16, 17, 0.7)",
            fontSize: 21,
            color: C.muted,
          }}
        >
          <div
            style={{
              display: "flex",
              padding: "5px 14px",
              borderRadius: 999,
              backgroundColor: C.accentSoft,
              color: C.accentBright,
              fontWeight: 500,
            }}
          >
            Fair mode
          </div>
          for token launches on NEAR
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 58, fontSize: 84, ...headline }}>
        <div>Bots can&apos;t snipe</div>
        <div style={{ color: C.accentBright }}>what they can&apos;t see.</div>
      </div>
      <div style={{ marginTop: 26, maxWidth: 920, fontSize: 30, lineHeight: 1.4, color: C.muted }}>
        Sealed bids, one clearing price for everyone, opened in an attested enclave on NEAR.
      </div>
      <div style={{ display: "flex", marginTop: "auto" }}>
        <BidLine />
      </div>
    </Canvas>
  );
}

// ---------- the app ----------

export function AppCard() {
  return (
    <Canvas>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Logo size={32} />
        <div style={{ fontSize: 22, color: C.subtle }}>Token sales on NEAR</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 62, fontSize: 96, ...headline }}>
        <div>Sealed bids.</div>
        <div style={{ color: C.accentBright }}>One price.</div>
      </div>
      <div style={{ marginTop: 24, maxWidth: 900, fontSize: 30, lineHeight: 1.4, color: C.muted }}>
        Every winner, bot or person, pays the same clearing price.
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: "auto" }}>
        <StatRow
          valueSize={28}
          cells={[
            { label: "Bids", value: "Sealed until close" },
            { label: "Opened", value: "In an attested enclave" },
            { label: "Price", value: "One for every winner" },
          ]}
        />
      </div>
    </Canvas>
  );
}

// ---------- one sale ----------

export function SaleCardImage({ card }: { card: SaleCard }) {
  const heroSize = card.hero ? heroFontSize(card.hero.value, card.hero.unit) : 96;
  return (
    <Canvas>
      {/* Token, and the sale's phase. */}
      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            width: 76,
            height: 76,
            borderRadius: 18,
            border: `1px solid ${C.line}`,
            backgroundColor: C.elev2,
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: -0.6,
            color: C.muted,
          }}
        >
          {card.monogram}
        </div>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, gap: 4 }}>
          <div
            style={{
              fontSize: 44,
              fontWeight: 500,
              letterSpacing: -1.3,
              lineHeight: 1.1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {card.name}
          </div>
          <div style={{ fontSize: 24, color: C.muted, whiteSpace: "nowrap" }}>
            {`${card.symbol} · sealed-bid sale`}
          </div>
        </div>
        <Pill dot={TONE[card.tone]}>{card.phase}</Pill>
      </div>

      {/* The number that matters. */}
      <div style={{ display: "flex", flexDirection: "column", marginTop: 44 }}>
        {card.hero && <div style={{ fontSize: 24, color: C.subtle }}>{card.hero.label}</div>}
        {card.hero ? (
          <div style={{ display: "flex", alignItems: "flex-end", flexWrap: "wrap", columnGap: 24, marginTop: 4 }}>
            <div style={{ fontSize: heroSize, fontWeight: 500, letterSpacing: -0.04 * heroSize, lineHeight: 1.05 }}>
              {card.hero.value}
            </div>
            <div style={{ fontSize: 32, color: C.muted, paddingBottom: Math.round(heroSize * 0.12) }}>
              {card.hero.unit}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 88, ...headline, letterSpacing: -3 }}>{card.outcome}</div>
        )}
        <div
          style={{
            marginTop: 12,
            fontSize: 29,
            lineHeight: 1.35,
            fontWeight: card.lineAccent ? 500 : 400,
            color: card.lineAccent ? C.accentBright : C.muted,
          }}
        >
          {card.line}
        </div>
        {card.note && <div style={{ fontSize: 29, lineHeight: 1.35, color: C.muted }}>{card.note}</div>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", marginTop: "auto", gap: 26 }}>
        <StatRow cells={card.stats} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Logo size={26} />
          <div style={{ fontSize: 22, color: C.subtle }}>{card.network}</div>
        </div>
      </div>
    </Canvas>
  );
}

// ---------- rendering ----------

export function renderCard(element: ReactElement, fonts: OgFont[] | undefined): ImageResponse {
  // Without Inter, leave `fonts` out so next/og uses its bundled font.
  return new ImageResponse(element, { ...OG_SIZE, ...(fonts ? { fonts } : {}) });
}

/**
 * Renders a card to PNG bytes before answering, so a failed render can fall
 * back to another card instead of breaking the response stream.
 */
export async function renderCardBytes(element: ReactElement, fonts: OgFont[] | undefined): Promise<ArrayBuffer> {
  const res = renderCard(element, fonts);
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error("empty image");
  return bytes;
}
