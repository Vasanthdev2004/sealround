/**
 * Library entry: build the relayer and get a Fetch API handler (`app.fetch`)
 * for any host: @hono/node-server (src/main.ts), a Vercel Function or a Next.js
 * route handler.
 */
import { isIP } from "node:net";
import { JsonRpcProvider } from "near-api-js";
import { createApp, type AppDeps } from "./app.ts";
import { nearChain, type Chain } from "./chain.ts";
import type { RelayerConfig } from "./config.ts";
import { DailyNearBudget, ipHasher, memoryLimiters } from "./limits.ts";
import { jsonLogger } from "./log.ts";

export { createApp, type AppDeps } from "./app.ts";
export { nearChain, type Chain } from "./chain.ts";
export { ConfigError, loadConfig, type RelayerConfig } from "./config.ts";
export {
  DailyNearBudget,
  MemoryRateLimitStore,
  MemorySponsorLedger,
  ipHasher,
  memoryLimiters,
  type Limiters,
  type RateLimitStore,
  type SponsorLedger,
} from "./limits.ts";
export { jsonLogger, type Logger } from "./log.ts";

/**
 * The relayer with in-memory limits and budgets (per process; per instance on a
 * serverless host). Without CLIENT_IP_HEADER and without an explicit `clientIp`,
 * every caller shares one IP bucket, so set one of them in production.
 */
export function createRelayer(config: RelayerConfig, overrides: Partial<Pick<AppDeps, "chain" | "clientIp" | "log">> = {}) {
  const { clientIpHeader, trustedProxyHops } = config;
  return createApp({
    config,
    chain: overrides.chain ?? nearChain(new JsonRpcProvider({ url: config.rpcUrl }), config.relayerAccountId, config.relayerKey),
    limiters: memoryLimiters(),
    budget: new DailyNearBudget(config.limits.dailyBudget),
    storageBudget: new DailyNearBudget(config.limits.storageBudget),
    clientIp:
      overrides.clientIp ??
      (clientIpHeader ? (c) => forwardedClient(c.req.header(clientIpHeader), trustedProxyHops) : () => undefined),
    hashIp: ipHasher(),
    log: overrides.log ?? jsonLogger,
  });
}

/**
 * Refuses to start unless the relayer key is a full-access key of the relayer
 * account. It must be: the outer transaction carries a Delegate action (and
 * storage_deposit carries NEAR), and function-call keys can sign neither.
 */
export async function assertRelayerKey(chain: Chain, config: RelayerConfig): Promise<void> {
  const key = await chain.accessKey(config.relayerAccountId, config.relayerKey.getPublicKey());
  if (key?.permission !== "FullAccess") {
    throw new Error(`RELAYER_PRIVATE_KEY is not a full-access key of ${config.relayerAccountId} on ${config.rpcUrl}`);
  }
}

/**
 * The client address in a proxy header such as x-forwarded-for. Each proxy
 * appends the address it received the request from, so only the entries added
 * by proxies you run can be trusted: behind `hops` of them the client is the
 * `hops`-th entry from the right, and everything to its left is whatever the
 * client sent. A single-value header a proxy overwrites (x-real-ip on Vercel,
 * fly-client-ip) is the case hops = 1. Anything that is not one IP address
 * counts as no address (one shared bucket).
 */
export function forwardedClient(value: string | undefined, hops: number): string | undefined {
  const entries = value?.split(",").map((entry) => entry.trim()) ?? [];
  const entry = entries[entries.length - hops];
  return entry !== undefined && isIP(entry) !== 0 ? entry : undefined;
}
