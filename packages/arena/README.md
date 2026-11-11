# @fairground/arena

The Bot Arena simulator. It runs the same crowd through three launch types and measures what sniper bots get out of each one:

1. **Bonding curve**: constant product with virtual reserves, as on popular meme launchpads. Buyers move the price as they buy, in arrival order.
2. **Fixed price, first come**: one price, first come first served until supply runs out.
3. **Sealround**: sealed bids, one uniform clearing price, computed by `clear()` from `@fairground/clearing` (the same rule the enclave runs).

Deterministic and seeded. No LLM calls, no network, no randomness without a seed.

## Rerun every chart

```sh
pnpm arena          # from the repo root
```

This runs 60 seeded runs (demand from 0.5x to 4x supply), prints a summary table and writes `apps/web/src/data/arena-results.json`. The `/arena` page reads that file, so every chart on it comes from this command. Nothing is typed by hand.

Flags: `--seed <n>`, `--runs <n>`, `--out <path>`, `--no-write`. For example `pnpm arena --seed 5 --no-write` prints a table for another seed without touching the JSON.

```sh
pnpm --filter @fairground/arena test       # determinism, clearing invariants, curve monotonicity
pnpm --filter @fairground/arena typecheck
```

## The model

One run = one crowd + three launches + one shared post-launch market each.

**Crowd.** 200 humans and 5 sniper bots.

- Each human has a private valuation (the most they would pay per token, lognormal around 1.6x the launch price), a budget (lognormal weights scaled to the run's demand level) and an arrival time (second 1 to 1,800, skewed early).
- Each bot has a budget of 2% to 6% of the supply value and acts at second 0, before any human.

**Demand level** = total human budget ÷ (supply × launch price). At 1x, humans bring exactly enough USDC to buy the whole supply at the launch price.

**Launches.**

| | Bots | Humans |
| --- | --- | --- |
| Bonding curve | Buy with their whole budget at second 0. Sell back into the curve after each human buy. | Buy in arrival order until their budget runs out or the price reaches their valuation. |
| Fixed price | Buy with their whole budget at second 0. | Buy in arrival order if their valuation is at least the price, until supply runs out. |
| Sealround | Bid their whole budget with a max price of 100x the launch price. | Bid max price = valuation, max spend = whole budget, if their valuation is at or above the floor. |

The bonding curve uses pump.fun proportions (virtual token reserve = 1.353 × the curve supply). Its virtual USDC reserve is set so buying the whole curve raises exactly what the fixed-price sale raises when it sells out, so neither launch gets more money to work with.

**Post-launch market (identical for all three).** A constant-product pool opens at the launch's final price with 2,000 USDC of liquidity. Humans with budget left and a valuation above the pool price buy in arrival order. After each human buy, bots sell back until the price returns to where it was before that buy, never below what they paid per token.

**Metrics (per run and averaged).**

| Metric | Definition |
| --- | --- |
| Bot share of supply | Tokens bought by bots at launch ÷ all tokens bought at launch |
| Bot profit | USDC bots receive selling to later humans, minus what they paid for the tokens they sold |
| Human price premium | Median price per token paid by humans who got tokens ÷ the average price bots paid |
| Humans filled | Share of humans holding any tokens at the end |
| Holder concentration | Gini coefficient of final holdings across every account holding tokens |

## Every assumption

The full list is generated from `src/config.ts` by `src/assumptions.ts`, written into the JSON and shown next to the charts on `/arena`, so the text cannot drift from the code. In short:

- Supply 1,000,000 tokens, launch price 0.01 USDC, so a sell-out at that price raises 10,000 USDC.
- Humans are honest and simple: they bid their true valuation and never split across wallets.
- Bots follow one selling rule everywhere. Bots that time their sales better would likely make more on the curve and in the fixed-price sale, so those profits are conservative.
- Unsold bot tokens count as zero profit, not at a market value.
- No fees, gas, latency or MEV beyond bots acting first.
- Money is integer throughout (USDC 6 decimals, tokens 18 decimals). Floats appear only in the reported metrics.

**Real launches will vary.** This is a model with stated assumptions, not a forecast. Change any number in `src/config.ts` and rerun `pnpm arena` to see how the results move.

## API

```ts
import { runArena, simulateRun, summarize, priceTrace } from "@fairground/arena";

const report = runArena({ seed: 20261114, runs: 60 }); // JSON-ready, plain numbers
const run = simulateRun(seed, 2.5);                     // one run, bigint internals
const trace = priceTrace(run);                          // price path for charts
```

## Files

- `src/config.ts`: every parameter
- `src/crowd.ts`: humans and bots
- `src/amm.ts`: constant-product math in integers
- `src/launches.ts`: bonding curve, fixed price, Sealround
- `src/market.ts`: the shared post-launch market
- `src/metrics.ts`: the five metrics
- `src/run.ts`: runs, summary, JSON report, price trace
- `src/assumptions.ts`: the assumptions list, generated from the config
- `src/cli.ts`: `pnpm arena`
