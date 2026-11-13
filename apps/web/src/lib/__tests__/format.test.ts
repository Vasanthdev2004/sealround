import { describe, expect, it } from "vitest";
import { tokenStr } from "../format";

describe("tokenStr", () => {
  it("formats 18-decimal amounts", () => {
    expect(tokenStr(150_000n * 10n ** 18n)).toBe("150K");
    expect(tokenStr(1_250_000n * 10n ** 18n)).toBe("1.25M");
    expect(tokenStr(84_231n * 10n ** 16n)).toBe("842.31");
  });

  it("formats amounts with fewer than 6 decimals at full size", () => {
    expect(tokenStr(1_000n, 0)).toBe("1,000");
    expect(tokenStr(150_000n, 0)).toBe("150K");
    expect(tokenStr(1_250_000_00n, 2)).toBe("1.25M");
    expect(tokenStr(84_231n, 2)).toBe("842.31");
  });

  it("formats 6 and 24 decimals", () => {
    expect(tokenStr(2_500_000n, 6)).toBe("2.5");
    expect(tokenStr(3n * 10n ** 9n * 10n ** 24n, 24)).toBe("3B");
  });
});
