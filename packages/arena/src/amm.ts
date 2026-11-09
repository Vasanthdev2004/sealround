/**
 * Constant-product pool math (x * y = k) in integer units.
 *
 * x: USDC reserve, base units (may include a virtual part).
 * y: token reserve, base units (may include a virtual part).
 * Spot price = x * ONE / y, USDC base units per whole token.
 *
 * Rounding always favours the pool, so x * y never drops below k.
 */

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** floor(sqrt(n)) for a non-negative bigint. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt of a negative number");
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  if (x === 0n) x = 1n;
  for (let i = 0; i < 6; i++) x = (x + n / x) >> 1n;
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}

export class ConstantProductPool {
  x: bigint;
  y: bigint;
  readonly k: bigint;
  readonly one: bigint;

  constructor(x: bigint, y: bigint, one: bigint) {
    if (x <= 0n || y <= 0n) throw new RangeError("pool reserves must be positive");
    this.x = x;
    this.y = y;
    this.k = x * y;
    this.one = one;
  }

  /** Spot price, USDC base units per whole token. */
  price(): bigint {
    return (this.x * this.one) / this.y;
  }

  /** USDC a buyer can spend before the spot price passes `p`. */
  spendToPrice(p: bigint): bigint {
    const xt = isqrt((p * this.k) / this.one);
    return xt > this.x ? xt - this.x : 0n;
  }

  /** Tokens out for spending `usdc` (floor). */
  quoteBuy(usdc: bigint): bigint {
    if (usdc <= 0n) return 0n;
    return this.y - ceilDiv(this.k, this.x + usdc);
  }

  /** USDC needed to buy exactly `tokens` (ceil). */
  costToBuy(tokens: bigint): bigint {
    if (tokens <= 0n) return 0n;
    if (tokens >= this.y) throw new RangeError("cannot buy the whole reserve");
    return ceilDiv(this.k, this.y - tokens) - this.x;
  }

  /** Apply a buy that was quoted with quoteBuy or costToBuy. */
  applyBuy(usdc: bigint, tokens: bigint): void {
    this.x += usdc;
    this.y -= tokens;
  }

  /** Buy with `usdc`. Returns tokens received. */
  buy(usdc: bigint): bigint {
    const t = this.quoteBuy(usdc);
    if (t > 0n) this.applyBuy(usdc, t);
    return t;
  }

  /** Tokens a seller can sell before the spot price falls to `p`. */
  tokensToPrice(p: bigint): bigint {
    if (p <= 0n) return 0n;
    const xt = isqrt((p * this.k) / this.one);
    if (xt <= 0n || xt >= this.x) return 0n;
    const yt = this.k / xt;
    return yt > this.y ? yt - this.y : 0n;
  }

  /** Sell `tokens`. Returns USDC received (floor). */
  sell(tokens: bigint): bigint {
    if (tokens <= 0n) return 0n;
    const y2 = this.y + tokens;
    const x2 = ceilDiv(this.k, y2);
    const out = this.x - x2;
    if (out <= 0n) return 0n;
    this.x = x2;
    this.y = y2;
    return out;
  }
}
