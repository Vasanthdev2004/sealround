import { simulateRun } from "@fairground/arena";
import { expect, it } from "vitest";
import { BOT_REPLAY, compareBotEntry } from "./bot-comparison";

it("replays an opening bot against one shared crowd and uses Arena's realized outcomes", () => {
  const { seed, demand, humans, bots } = BOT_REPLAY;
  const arena = simulateRun(seed, demand, { humans, bots });
  const result = compareBotEntry();
  const bot = arena.crowd.find((entry) => entry.kind === "bot");

  expect(arena.crowd.filter((entry) => entry.kind === "human")).toHaveLength(50);
  expect(arena.crowd.filter((entry) => entry.kind === "bot")).toHaveLength(1);
  expect(result.at).toBe(0);
  expect(bot?.arrival).toBe(result.at);
  expect(result.curve.spent).toBe(result.sealround.spent);
  expect(result.curve.sold).toBeGreaterThan(0n);
  expect(result.curve.proceeds - result.curve.spent).toBe(result.curve.profit);
  expect(Number(result.curve.profit) / 1e6).toBe(arena.metrics.bonding_curve.botProfit);
  expect(result.curve.price).toBeLessThan(result.clearingPrice);
  expect(result.sealround.price).toBe(result.clearingPrice);
  expect(result.sealround.profit).toBe(0n);
  expect(result.sealround.sold).toBe(0n);
});
