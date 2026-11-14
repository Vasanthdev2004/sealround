import { DEFAULT_SEED, simulateRun } from "@fairground/arena";
import { USDC_ONE } from "@fairground/clearing";

export const BOT_REPLAY = { seed: DEFAULT_SEED, demand: 1.7, humans: 50, bots: 1 };

/** An Arena replay that isolates one bot and gives both launches the same crowd. */
export function compareBotEntry() {
  const { seed, demand, humans, bots } = BOT_REPLAY;
  const run = simulateRun(seed, demand, { humans, bots });
  const bot = run.crowd[0];
  const side = (venue: "bonding_curve" | "fairground") => {
    const launch = run.launches[venue];
    const market = run.markets[venue];
    const metric = run.metrics[venue];
    // Arena's prices and realized profit come from integer USDC amounts.
    const baseUnits = (usdc: number) => BigInt(Math.round(usdc * Number(USDC_ONE)));
    return {
      price: metric.botPrice === null ? null : baseUnits(metric.botPrice),
      spent: launch.spent[bot.index],
      sold: launch.soldBack[bot.index] + market.sold[bot.index],
      proceeds: launch.proceeds[bot.index] + market.proceeds[bot.index],
      profit: baseUnits(metric.botProfit),
    };
  };
  return {
    at: bot.arrival,
    clearingPrice: run.launches.fairground.finalPrice,
    decimals: run.config.decimals,
    curve: side("bonding_curve"),
    sealround: side("fairground"),
  };
}
