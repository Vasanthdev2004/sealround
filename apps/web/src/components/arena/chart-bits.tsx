"use client";

/**
 * The chart helpers live in components/visual/chart-bits, so the result, how
 * and arena charts share one implementation. Re-exported here for the arena's
 * own imports.
 */
export {
  CHART_CURSOR,
  CHART_GRID,
  CHART_SURFACE,
  CHART_TICK,
  Legend,
  LegendItem,
  PricePill,
  TipCard,
  TipRow,
  useSeriesMotion,
} from "@/components/visual/chart-bits";
