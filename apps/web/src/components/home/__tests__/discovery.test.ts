import { describe, expect, it } from "vitest";
import type { Sale } from "@/lib/types";
import { matchesSearch, parseSaleFilter } from "../sale-filters";
import { parseSavedSales, savedSalesKey } from "../saved-sales";

const sale = { id: "fair-test", creator: "community.near", config: { tokenName: "Fair Test", tokenSymbol: "FAIR" } } as Sale;

describe("sale discovery", () => {
  it("searches public identity without case or surrounding whitespace sensitivity", () => {
    expect(matchesSearch(sale, "  FAIR community.NEAR ")).toBe(true);
    expect(matchesSearch(sale, "fair-test")).toBe(true);
    expect(matchesSearch(sale, "")).toBe(true);
    expect(matchesSearch(sale, "fair missing")).toBe(false);
  });

  it("restores only known status filters from a shared URL", () => {
    expect(parseSaleFilter("refunding")).toBe("refunding");
    expect(parseSaleFilter("clearing")).toBe("clearing");
    expect(parseSaleFilter(null)).toBe("all");
    expect(parseSaleFilter("__proto__")).toBe("all");
  });
});

describe("public sale bookmarks", () => {
  it("does not share bookmarks between mock, networks or contracts", () => {
    const scopes = [savedSalesKey("mock"), savedSalesKey("near", "testnet", "sale.testnet"), savedSalesKey("near", "mainnet", "sale.near"), savedSalesKey("near", "testnet", "other.testnet")];
    expect(new Set(scopes).size).toBe(4);
  });

  it("recovers from corrupt or incompatible browser storage", () => {
    for (const raw of [null, "{", "null", "42", '{"ids":["fair-test"]}']) expect(parseSavedSales(raw)).toEqual([]);
  });

  it("keeps unique safe IDs and rejects unexpected values", () => {
    expect(parseSavedSales(JSON.stringify(["fair-test", "fair-test", "second.sale", null, 1, "../bad", "", "a".repeat(129)]))).toEqual(["fair-test", "second.sale"]);
  });

  it("bounds the list and oversized records", () => {
    expect(parseSavedSales(JSON.stringify(Array.from({ length: 600 }, (_, i) => `sale-${i}`)))).toHaveLength(500);
    expect(parseSavedSales(" ".repeat(70_001))).toEqual([]);
  });
});
