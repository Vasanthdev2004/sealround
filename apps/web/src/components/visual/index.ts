/**
 * Shared visual language. See apps/web/UI-DIRECTION.md, "Visual components".
 * Each module carries its own "use client" where it needs one.
 */
export { AnimatedNumber, parseNumeric } from "./animated-number";
export { Legend, LegendItem, PricePill, TipCard, TipRow, useSeriesMotion } from "./chart-bits";
export { CipherChip, type CipherTone } from "./cipher-chip";
export { MotionProvider } from "./motion-provider";
export { LineDot, PriceLine } from "./price-line";
export { Reveal } from "./reveal";
export { SealMark, type SealTone } from "./seal-mark";
export { cipherText, hash32, rng, saleHue } from "./seed";
