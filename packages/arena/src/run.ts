/**
 * Run the arena: the same crowd through all three launch types, then the same
 * post-launch market, then the metrics. Deterministic for a given seed.
 */

import { formatUnits } from "@fairground/clearing";
import { assumptions } from "./assumptions";
import {
  DEFAULT_CONFIG,
  DEFAULT_DEMAND_MAX,
  DEFAULT_DEMAND_MIN,
  DEFAULT_RUNS,
  DEFAULT_SEED,
  LAUNCH_LABEL,
  LAUNCH_TYPES,
  scale,
  supplyValue,
  type ArenaConfig,
  type LaunchType,
} from "./config";
import { makeCrowd, type Agent } from "./crowd";
import { curveEndpoints, runLaunch, type LaunchOutcome } from "./launches";
import { runMarket, type MarketOutcome } from "./market";
import { METRIC_IDS, METRICS, computeMetrics, type LaunchMetrics, type MetricDef, type MetricId } from "./metrics";

export type RunDetail = {
  seed: number;
  demand: number;
  config: ArenaConfig;
  crowd: Agent[];
  launches: Record<LaunchType, LaunchOutcome>;
  markets: Record<LaunchType, MarketOutcome>;
  metrics: Record<LaunchType, LaunchMetrics>;
};

/** 32-bit integer hash (lowbias32). */
function hash32(v: number): number {
  let x = v >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Seed for run `i` of a batch with base seed `base`. */
export const runSeed = (base: number, i: number) => hash32((base >>> 0) ^ Math.imul(i + 1, 0x9e3779b9));

/** Evenly spaced demand levels, rounded to 4 decimals. */
export function demandLevels(runs: number, min: number, max: number): number[] {
  return Array.from({ length: runs }, (_, i) => {
    const d = runs === 1 ? min : min + ((max - min) * i) / (runs - 1);
    return Math.round(d * 10_000) / 10_000;
  });
}

const withConfig = (config?: Partial<ArenaConfig>): ArenaConfig => ({ ...DEFAULT_CONFIG, ...config });

/** One run: one crowd, three launches, one post-launch market each. */
export function simulateRun(seed: number, demand: number, config?: Partial<ArenaConfig>): RunDetail {
  const cfg = withConfig(config);
  const crowd = makeCrowd(seed, demand, cfg);
  const launches = {} as Record<LaunchType, LaunchOutcome>;
  const markets = {} as Record<LaunchType, MarketOutcome>;
  const metrics = {} as Record<LaunchType, LaunchMetrics>;
  for (const type of LAUNCH_TYPES) {
    launches[type] = runLaunch(type, crowd, cfg);
    markets[type] = runMarket(crowd, launches[type], cfg);
    metrics[type] = computeMetrics(crowd, launches[type], markets[type], cfg);
  }
  return { seed, demand, config: cfg, crowd, launches, markets, metrics };
}

// ---------- JSON-ready report ----------

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  // `|| 0` turns -0 (from sub-unit rounding) into 0.
  return Math.round(v * f) / f || 0;
};

export type LaunchRow = {
  botShare: number;
  botProfit: number;
  premium: number | null;
  humansFilled: number;
  gini: number;
  finalPrice: number;
  botPrice: number | null;
  humanPrice: number | null;
  soldShare: number;
  raised: number;
  botUnsold: number;
};

export type RunRow = { run: number; seed: number; demand: number } & Record<LaunchType, LaunchRow>;

export type Stat = { mean: number; min: number; max: number };
export type Summary = Record<LaunchType, Record<MetricId, Stat>>;

export type ArenaReport = {
  command: string;
  seed: number;
  runs: number;
  demandMin: number;
  demandMax: number;
  config: {
    humans: number;
    bots: number;
    supplyTokens: number;
    launchPrice: number;
    supplyValue: number;
    windowSeconds: number;
    poolDepth: number;
    botBudgetMin: number;
    botBudgetMax: number;
    botMaxPrice: number;
    curveStartPrice: number;
    curveEndPrice: number;
  };
  launches: { id: LaunchType; label: string }[];
  metrics: MetricDef[];
  summary: Summary;
  rows: RunRow[];
  assumptions: string[];
};

export function toRow(m: LaunchMetrics): LaunchRow {
  const opt = (v: number | null, dp: number) => (v === null ? null : round(v, dp));
  return {
    botShare: round(m.botShare, 5),
    botProfit: round(m.botProfit, 2),
    premium: opt(m.premium, 4),
    humansFilled: round(m.humansFilled, 4),
    gini: round(m.gini, 4),
    finalPrice: round(m.finalPrice, 6),
    botPrice: opt(m.botPrice, 6),
    humanPrice: opt(m.humanPrice, 6),
    soldShare: round(m.soldShare, 5),
    raised: round(m.raised, 2),
    botUnsold: round(m.botUnsold, 4),
  };
}

/** Mean, min and max of each metric per launch type. Null values are skipped. */
export function summarize(rows: RunRow[]): Summary {
  const out = {} as Summary;
  for (const type of LAUNCH_TYPES) {
    out[type] = {} as Record<MetricId, Stat>;
    for (const id of METRIC_IDS) {
      const vs = rows.map((r) => r[type][id]).filter((v): v is number => typeof v === "number");
      const dp = id === "botProfit" ? 2 : 4;
      out[type][id] = vs.length
        ? {
            mean: round(vs.reduce((a, b) => a + b, 0) / vs.length, dp),
            min: round(Math.min(...vs), dp),
            max: round(Math.max(...vs), dp),
          }
        : { mean: 0, min: 0, max: 0 };
    }
  }
  return out;
}

export type ArenaOptions = {
  seed?: number;
  runs?: number;
  demandMin?: number;
  demandMax?: number;
  config?: Partial<ArenaConfig>;
};

/** Run the whole batch and return a JSON-ready report (plain numbers, no bigint). */
export function runArena(opts: ArenaOptions = {}): ArenaReport {
  const seed = opts.seed ?? DEFAULT_SEED;
  const runs = opts.runs ?? DEFAULT_RUNS;
  const demandMin = opts.demandMin ?? DEFAULT_DEMAND_MIN;
  const demandMax = opts.demandMax ?? DEFAULT_DEMAND_MAX;
  const cfg = withConfig(opts.config);

  const rows: RunRow[] = demandLevels(runs, demandMin, demandMax).map((demand, run) => {
    const s = runSeed(seed, run);
    const d = simulateRun(s, demand, cfg);
    return {
      run,
      seed: s,
      demand,
      bonding_curve: toRow(d.metrics.bonding_curve),
      fixed_price: toRow(d.metrics.fixed_price),
      fairground: toRow(d.metrics.fairground),
    };
  });

  const num = (v: bigint, dp: number) => Number(formatUnits(v, dp).replace(/,/g, ""));
  const value = supplyValue(cfg);
  const { start, end } = curveEndpoints(cfg);

  return {
    command: "pnpm arena",
    seed,
    runs,
    demandMin,
    demandMax,
    config: {
      humans: cfg.humans,
      bots: cfg.bots,
      supplyTokens: num(cfg.supply, cfg.decimals),
      launchPrice: num(cfg.launchPrice, 6),
      supplyValue: num(value, 6),
      windowSeconds: cfg.windowSeconds,
      poolDepth: num(scale(value, cfg.poolDepthShare), 6),
      botBudgetMin: num(scale(value, cfg.botBudgetMin), 6),
      botBudgetMax: num(scale(value, cfg.botBudgetMax), 6),
      botMaxPrice: num(cfg.launchPrice * cfg.botMaxPriceMultiple, 6),
      curveStartPrice: num(start, 6),
      curveEndPrice: num(end, 6),
    },
    launches: LAUNCH_TYPES.map((id) => ({ id, label: LAUNCH_LABEL[id] })),
    metrics: METRICS,
    summary: summarize(rows),
    rows,
    assumptions: assumptions(cfg, { seed, runs, demandMin, demandMax }),
  };
}

// ---------- Price trace for charts ----------

export type TracePoint = {
  /** Seconds after launch. */
  t: number;
  /** Spot price after this arrival traded (and bots answered), USDC per token. */
  price: number;
  actor: "start" | "bot" | "human";
  id: string;
  /** Whole tokens this arrival bought. */
  tokens: number;
  /** USDC this arrival paid. */
  usdc: number;
  /** Whole tokens bots sold back into the curve right after this buy. */
  botsSold: number;
};

export type PriceTrace = {
  windowSeconds: number;
  launchPrice: number;
  /** Bonding curve: one point per buy, plus the starting price. */
  curve: TracePoint[];
  curveSoldOutAt: number | null;
  fixedSoldOutAt: number | null;
  /** Fairground: the one price every winner pays. */
  clearingPrice: number;
  /** Average price bots paid on the curve. */
  curveBotPrice: number | null;
};

/** Price path of one run, for the interactive chart. Plain numbers. */
export function priceTrace(detail: RunDetail): PriceTrace {
  const cfg = detail.config;
  const toTokens = (v: bigint) => Number(v / 10n ** BigInt(Math.max(0, cfg.decimals - 6))) / 1e6;
  const curve = detail.launches.bonding_curve;
  const points: TracePoint[] = [
    { t: 0, price: Number(curve.startPrice) / 1e6, actor: "start", id: "start", tokens: 0, usdc: 0, botsSold: 0 },
    ...curve.path.map((p) => {
      const a = detail.crowd[p.agent];
      return {
        t: p.t,
        price: Number(p.price) / 1e6,
        actor: a.kind,
        id: a.id,
        tokens: toTokens(p.bought),
        usdc: Number(p.paid) / 1e6,
        botsSold: toTokens(p.botsSold),
      };
    }),
  ];
  return {
    windowSeconds: cfg.windowSeconds,
    launchPrice: Number(cfg.launchPrice) / 1e6,
    curve: points,
    curveSoldOutAt: curve.soldOutAt,
    fixedSoldOutAt: detail.launches.fixed_price.soldOutAt,
    clearingPrice: Number(detail.launches.fairground.finalPrice) / 1e6,
    curveBotPrice: detail.metrics.bonding_curve.botPrice,
  };
}
