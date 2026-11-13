/**
 * Sealround as MCP tools, over stdio, for any MCP client (Claude Desktop,
 * Claude Code, Cursor, ...).
 *
 *   pnpm --silent --filter web mcp                  (from the repo root; --silent keeps pnpm's banner off stdout)
 *   node apps/web/node_modules/tsx/dist/cli.mjs apps/web/scripts/mcp/server.ts
 *
 * Settings come from the environment (config.ts); README.md in this folder
 * lists them, the tools and the safety rules. The tools reuse the web app's
 * NEAR client, bid sealing and verification code, and the live bot's checks
 * (tools.ts, session.ts).
 *
 * stdout carries the protocol and nothing else: console.log and friends are
 * sent to stderr below, and so is every progress line.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ENV, loadConfig, type ServerConfig } from "./config";
import { asToolError } from "./session";
import { claim, getResult, getSale, listSales, myBid, PHASES, placeBid, verifySale } from "./tools";

for (const method of ["log", "info", "debug"] as const) console[method] = (...args: unknown[]) => console.error(...args);

const VERSION = "0.1.0";
const loaded = loadConfig();
const key = loaded.key;

/** Runs one tool and shapes its answer: JSON text, with any copy of the key removed. */
async function run(name: string, fn: (cfg: ServerConfig) => Promise<object>) {
  const started = Date.now();
  let payload: object;
  let isError = false;
  try {
    if (!loaded.config) throw loaded.problem;
    payload = await fn(loaded.config);
  } catch (e) {
    const err = asToolError(e);
    isError = true;
    payload = { ok: false, error: { code: err.code, message: err.message, ...err.extra } };
  }
  const text = key.redact(JSON.stringify(payload, null, 2));
  process.stderr.write(`[sealround-mcp] ${name}: ${isError ? `error ${(payload as { error: { code: string } }).error.code}` : "ok"} in ${Date.now() - started} ms\n`);
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

const amount = (what: string) =>
  z.union([z.string(), z.number()]).describe(`${what}, in whole quote-token units as a decimal (e.g. "0.02"), not base units.`);
const saleId = z.string().describe("The sale id, e.g. \"lantern\". sealround_list_sales lists them.");

const server = new McpServer(
  { name: "sealround", version: VERSION },
  {
    instructions: [
      "Sealround runs sealed-bid, single-price token sales on NEAR. A bid's max price and max spend are sealed to the sale's enclave key in this process and opened only inside a TEE after the sale closes; every winner pays the same clearing price.",
      "Flow: sealround_list_sales, sealround_get_sale, sealround_place_bid while the sale is open, sealround_my_bid, then after settlement sealround_get_result and sealround_claim. sealround_verify_sale checks the enclave's attestation and the frozen bid set.",
      "Amounts are whole quote-token units (e.g. USDC) as decimals. Never place a bid without the user's explicit approval of max_price, max_spend and max_deposit. Use direct: true only when the user approved paying NEAR gas.",
    ].join(" "),
  },
);

server.registerTool(
  "sealround_list_sales",
  {
    title: "List Sealround sales",
    description: "Lists the contract's sales, newest first, with phase, bid window, floor price, bid count and total deposits. Read-only.",
    inputSchema: {
      phase: z.enum(PHASES).optional().describe("Filter: all (default), upcoming, open, closing (bid window over, not final), settled, failed, final (settled or failed)."),
      limit: z.number().int().min(1).max(200).optional().describe("Most sales to return (default 50)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => run("sealround_list_sales", (cfg) => listSales(cfg, args)),
);

server.registerTool(
  "sealround_get_sale",
  {
    title: "Get a Sealround sale",
    description:
      "One sale's rules (floor and max price, deposit limits, supply, liquidity terms), phase and timing by the chain clock, and public totals (bid count, total deposits). Never anything sealed. With an account configured, also its quote-token balance and its public bid. Read-only.",
    inputSchema: { sale_id: saleId },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => run("sealround_get_sale", (cfg) => getSale(cfg, args)),
);

server.registerTool(
  "sealround_place_bid",
  {
    title: "Place a sealed bid",
    description: [
      "Places one sealed bid from the configured account in an open sealed-bid (TEE) sale. The terms are sealed in this process to the sale's enclave key with the web app's own code; only the deposit is public.",
      "Refuses, before anything is sent, a deposit above max_deposit, a bid that would be void, a sale that is not open, a second bid, and a missing or wrong key.",
      "Sent gasless through the relayer; a bid the relayer cannot sponsor is refused unless direct is true (the account then pays the NEAR gas).",
      "Returns the transaction hash, the bid's index and the path of the bid secret file (max price, max spend, salt) saved on this machine. Get the user's approval for every amount first.",
    ].join(" "),
    inputSchema: {
      sale_id: saleId,
      max_price: amount("Highest price you would pay per whole sale token"),
      max_spend: amount("Most you would spend in total"),
      max_deposit: amount("The user-approved cap on the public deposit; the tool refuses a deposit above it"),
      deposit: amount("Public deposit locked with the bid (default: max_spend). A larger deposit hides your max spend; the unspent part is refunded at claim").optional(),
      direct: z.boolean().optional().describe("Sign and pay the NEAR gas from the account instead of the relayer. Only with the user's approval."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => run("sealround_place_bid", (cfg) => placeBid(cfg, args)),
);

server.registerTool(
  "sealround_my_bid",
  {
    title: "My bid in a sale",
    description:
      "The configured account's bid in a sale: its public record (index, deposit, time, claimed), the local bid secret file, and once the sale is settled or failed its fill (tokens, spent, refund, penalty), the clearing price check and what is claimable. Read-only, no key needed.",
    inputSchema: { sale_id: saleId },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => run("sealround_my_bid", (cfg) => myBid(cfg, args)),
);

server.registerTool(
  "sealround_get_result",
  {
    title: "Get a sale's result",
    description:
      "After settlement: the clearing price, tokens sold, raise, valid and invalid bids, whether every winner paid the clearing price, and for an account (default: the configured one) its fill, checks and what is claimable. Before settlement it says the phase. Read-only, no key needed.",
    inputSchema: {
      sale_id: saleId,
      account: z.string().optional().describe("Whose fill to show (default: the configured account)."),
      include_fills: z.boolean().optional().describe("Also list every bid's fill (public after settlement)."),
      wait_seconds: z.number().int().min(0).max(300).optional().describe("Wait up to this long for the sale to settle (default 0)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => run("sealround_get_result", (cfg) => getResult(cfg, args)),
);

server.registerTool(
  "sealround_claim",
  {
    title: "Claim tokens and refund",
    description:
      "After settlement (or failure), claims the configured account's tokens and refund. Zero deposit; gasless through the relayer when it sponsors claim, otherwise refused unless direct is true (the account pays the NEAR gas).",
    inputSchema: {
      sale_id: saleId,
      direct: z.boolean().optional().describe("Sign and pay the NEAR gas from the account instead of the relayer. Only with the user's approval."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => run("sealround_claim", (cfg) => claim(cfg, args)),
);

server.registerTool(
  "sealround_verify_sale",
  {
    title: "Verify a sale",
    description:
      "The checks of `pnpm --filter web verify-sale`, read-only: for each enclave run (the sale key and the clearing) it finds the transaction, fetches OutLayer's attestation and checks the attested and measured build, input and output hashes, the TDX quote's report data, the measurements, the request and the key; then it recomputes the frozen bid-set hash from every listed bid. Returns pass, fail or not_run per check with the evidence.",
    inputSchema: { sale_id: saleId },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => run("sealround_verify_sale", (cfg) => verifySale(cfg, args)),
);

async function main(): Promise<void> {
  const c = loaded.config;
  process.stderr.write(
    c
      ? `[sealround-mcp] ${VERSION}: ${c.network} at ${c.rpcUrl}, contract ${c.contractId}, account ${c.accountId ?? "(none)"}, key ${c.key.present ? `from ${c.key.source}` : c.key.problem ? `unusable (${c.key.problem.code})` : "(none: read-only)"}, relayer ${c.relayerUrl ?? "(none)"}${c.network === "mainnet" ? `, mainnet writes ${c.allowMainnet ? "allowed" : `refused (set ${ENV.allowMainnet}=1)`}` : ""}\n`
      : `[sealround-mcp] ${VERSION}: not configured: ${loaded.problem.message} Every tool will say so.\n`,
  );
  await server.connect(new StdioServerTransport());
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[sealround-mcp] could not start: ${key.redact(message)}\n`);
  process.exit(1);
});
