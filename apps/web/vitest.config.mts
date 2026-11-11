import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests of the data layer (src/lib). They run in Node: the mock client
 * keeps its state in memory when there is no localStorage, and the NEAR
 * client is driven through fake RPC, relayer and signer objects.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
