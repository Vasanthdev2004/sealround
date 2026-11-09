/** Unit helpers shared by the app, the simulator and tests. */

export const USDC_DECIMALS = 6;
export const USDC_ONE = 10n ** 6n;

/** Parse a decimal string ("12.5") into base units with `decimals` places. */
export function parseUnits(value: string, decimals: number): bigint {
  const s = value.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") {
    throw new Error(`invalid amount: ${value}`);
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) {
    throw new Error(`too many decimals (max ${decimals}): ${value}`);
  }
  return BigInt(whole || "0") * 10n ** BigInt(decimals) +
    BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Format base units as a decimal string, trimming trailing zeros. */
export function formatUnits(
  value: bigint,
  decimals: number,
  maxFraction = decimals,
): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFraction);
  frac = frac.replace(/0+$/, "");
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${w}${frac ? "." + frac : ""}`;
}

export const usdc = (v: string | number) => parseUnits(String(v), USDC_DECIMALS);
export const tokens = (v: string | number, decimals = 18) =>
  parseUnits(String(v), decimals);

export const formatUsdc = (v: bigint, maxFraction = 6) =>
  formatUnits(v, USDC_DECIMALS, maxFraction);
export const formatTokens = (v: bigint, decimals = 18, maxFraction = 2) =>
  formatUnits(v, decimals, maxFraction);
