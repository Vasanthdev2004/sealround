/**
 * Node entry: `pnpm dev` (runs this file with Node's type stripping) or
 * `pnpm build && pnpm start`. Reads .env if present.
 */
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { JsonRpcProvider } from "near-api-js";
import { ConfigError, assertRelayerKey, createRelayer, loadConfig, nearChain } from "./lib.ts";

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const chain = nearChain(new JsonRpcProvider({ url: config.rpcUrl }), config.relayerAccountId, config.relayerKey);
await assertRelayerKey(chain, config);

const app = createRelayer(config, {
  chain,
  // Behind a proxy, CLIENT_IP_HEADER names the header to trust (createRelayer reads it); otherwise use the socket.
  clientIp: config.clientIpHeader ? undefined : (c) => getConnInfo(c).remote.address,
});

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), msg: "listening", port, network: config.network, relayer: config.relayerAccountId }),
  );
});
