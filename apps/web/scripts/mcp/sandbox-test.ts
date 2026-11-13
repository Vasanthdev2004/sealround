/**
 * The Sealround MCP server, end to end, over stdio:
 *
 *   pnpm --filter web exec tsx scripts/mcp/sandbox-test.ts             (local chain in Docker)
 *   pnpm --filter web exec tsx scripts/mcp/sandbox-test.ts --offline   (no chain: protocol and refusals only)
 *
 * Every server is its own process (server.ts under tsx), started by the MCP
 * SDK's own client (StdioClientTransport) with its settings in the
 * environment, as an MCP client starts it.
 *
 * Offline part (always runs first): the protocol handshake and the tool list,
 * a server with no settings, and every refusal that must come before the
 * network: the RPC URL is a closed port, so a check that went over the
 * network would answer rpc_unreachable instead.
 *
 * Sandbox part: the world of the sandbox end-to-end harness (scripts/e2e:
 * the nearcore sandbox in the Docker container near-sandbox-web, the real
 * contract, OutLayer's contract with the stand-in worker running the pinned
 * enclave job, the real relayer on 127.0.0.1:8790). An agent account lists
 * the sales, reads one, is refused (closed sale, over budget, void terms,
 * wrong key, wrong network, mainnet without opt-in) with no nonce or balance
 * change, places a relayed sealed bid, is refused a second one, reads its bid;
 * another account bids with direct: true; people bid through the web client;
 * the sale closes and the enclave clears it; get_result and my_bid must match
 * the reference clearing of @fairground/clearing to the base unit;
 * verify_sale reports "no OutLayer service" for both runs and a matching bid
 * set; claim pays the fill gasless and a second claim is refused. The key must
 * appear in no tool output and no server log.
 *
 * It refuses to start while near-sandbox-web exists or port 8790 is taken,
 * and always removes its container and stops its relayer. Logs and bid
 * secret files go to scripts/mcp/.run/sandbox-test (git-ignored). Nothing here
 * touches a public network.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { clear, type Bid, type SaleParams } from "@fairground/clearing";
import { KeyPair, teraToGas } from "near-api-js";
import type { BidView, SaleView } from "../../src/lib/near/views";
import type { SaleConfig, SaleMeta } from "../../src/lib/types";
import { removeSandbox, SANDBOX_NAME, SANDBOX_PORT, sandboxExists, WEB_DIR, type Named } from "../e2e/chain";
import { portInUse, RELAYER_PORT, RELAYER_URL, stopLeftoverRelayer } from "../e2e/relayer";
import { Report, show, type Checks } from "../e2e/report";
import { buildWorld, USDC, type World } from "../e2e/world";

const HERE = typeof __dirname === "string" ? __dirname : path.resolve("scripts/mcp");
const RUN_DIR = path.join(HERE, ".run", "sandbox-test");
const SECRETS = path.join(RUN_DIR, "bid-secrets");
const PID_FILE = path.join(RUN_DIR, "relayer.pid");
const SERVER_TS = path.join(HERE, "server.ts");
const TOKEN = 10n ** 18n;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** Nothing listens here: a tool that reached for the network would fail with rpc_unreachable. */
const DEAD_URL = "http://127.0.0.1:9";
const TOOLS = [
  "sealround_claim",
  "sealround_get_result",
  "sealround_get_sale",
  "sealround_list_sales",
  "sealround_my_bid",
  "sealround_place_bid",
  "sealround_verify_sale",
];
const OFFLINE = process.argv.includes("--offline");

// ---------------------------------------------------------------- MCP servers as processes

type Json = Record<string, unknown> & { ok?: boolean; error?: { code?: string; message?: string; nothingSent?: boolean } };
type Called = { isError: boolean; text: string; json: Json };

/** Every tool answer and every server log line of the run, checked for keys at the end. */
const transcript: string[] = [];
const servers: Mcp[] = [];

/** The environment of a server process: this one's, without anything the server or the app would read. */
function baseEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !/^(SEALROUND_|LIVE_BOT_|NEXT_PUBLIC_)/.test(e[0])),
  );
}

class Mcp {
  private constructor(
    readonly label: string,
    readonly client: Client,
    private readonly transport: StdioClientTransport,
    readonly log: string[],
  ) {}

  static async start(label: string, env: Record<string, string>): Promise<Mcp> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      // The tsx loader this test runs under, so the server runs as `pnpm mcp` runs it.
      args: [...process.execArgv, SERVER_TS],
      env: { ...baseEnv(), ...env },
      cwd: WEB_DIR,
      stderr: "pipe",
    });
    const log: string[] = [];
    transport.stderr?.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      log.push(text);
      transcript.push(text);
    });
    const client = new Client({ name: "sealround-sandbox-test", version: "0.1.0" });
    await client.connect(transport);
    const mcp = new Mcp(label, client, transport, log);
    servers.push(mcp);
    return mcp;
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<Called> {
    const result = await this.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 240_000 });
    const content = (result.content ?? []) as { type: string; text?: string }[];
    const text = content.map((c) => c.text ?? "").join("\n");
    transcript.push(text);
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      // not JSON: the checks below say so
    }
    return { isError: result.isError === true, text, json };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {});
    await this.transport.close().catch(() => {});
  }
}

/** A refusal: isError, the code, and (when asked) the nothingSent flag. */
function refusedWith(t: Checks, label: string, r: Called, code: string, nothingSent = true): void {
  t.ok(
    `${label}: refused with "${code}"${nothingSent ? ", nothing sent" : ""}`,
    r.isError && r.json.ok === false && r.json.error?.code === code && (!nothingSent || r.json.error?.nothingSent === true),
    show(r.json.error ?? r.text.slice(0, 300)),
  );
  console.log(`      -> ${r.json.error?.message ?? "(no message)"}`);
}

const get = (o: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);

// ---------------------------------------------------------------- offline

async function offline(report: Report): Promise<void> {
  const fakeKey = KeyPair.fromRandom("ed25519").toString();
  const local = {
    SEALROUND_NETWORK: "sandbox",
    SEALROUND_RPC_URL: DEAD_URL,
    SEALROUND_CONTRACT: "fairground.test.near",
    SEALROUND_ACCOUNT: "agent.test.near",
    SEALROUND_SECRET_DIR: SECRETS,
  };
  const bid = { sale_id: "lantern", max_price: "0.02", max_spend: "2", max_deposit: "5", deposit: "5" };

  await report.scenario("protocol", "offline: the MCP handshake and the tool list", [], async (t) => {
    const mcp = await Mcp.start("protocol", local);
    const info = mcp.client.getServerVersion();
    t.eq("the server introduces itself as sealround", info?.name, "sealround");
    t.ok("it gives the client instructions", (mcp.client.getInstructions() ?? "").includes("sealround_place_bid"));
    const { tools } = await mcp.client.listTools();
    t.eq("it lists exactly the seven Sealround tools", tools.map((x) => x.name).sort(), TOOLS);
    const place = tools.find((x) => x.name === "sealround_place_bid");
    t.eq("place_bid requires sale_id, max_price, max_spend and max_deposit", [...((place?.inputSchema.required as string[] | undefined) ?? [])].sort(), ["max_deposit", "max_price", "max_spend", "sale_id"]);
    const readOnly = tools.filter((x) => x.annotations?.readOnlyHint === true).map((x) => x.name).sort();
    t.eq("the five reads are marked read-only, place_bid and claim are not", readOnly, ["sealround_get_result", "sealround_get_sale", "sealround_list_sales", "sealround_my_bid", "sealround_verify_sale"]);
    t.ok("every tool has a description", tools.every((x) => (x.description ?? "").length > 40));
  });

  await report.scenario("no-config", "offline: a server with no settings says what is missing", [], async (t) => {
    const mcp = await Mcp.start("no-config", {});
    const r = await mcp.call("sealround_get_sale", { sale_id: "lantern" });
    refusedWith(t, "get_sale with no settings", r, "config", false);
    t.ok("the message names SEALROUND_NETWORK", (r.json.error?.message ?? "").includes("SEALROUND_NETWORK"));
  });

  await report.scenario("local-refusals", "offline: refusals before the network (the RPC is a closed port)", [], async (t) => {
    const keyed = await Mcp.start("keyed", { ...local, SEALROUND_PRIVATE_KEY: fakeKey, SEALROUND_RELAYER_URL: DEAD_URL });
    refusedWith(t, "a deposit of 5 above max_deposit 4.99", await keyed.call("sealround_place_bid", { ...bid, max_deposit: "4.99" }), "over_budget");
    refusedWith(t, "the default deposit (max_spend 6) above max_deposit 5", await keyed.call("sealround_place_bid", { ...bid, deposit: undefined, max_spend: "6" }), "over_budget");
    refusedWith(t, "an amount that is not a decimal", await keyed.call("sealround_place_bid", { ...bid, max_price: "2e-2" }), "usage");
    refusedWith(t, "a sale id that is not one", await keyed.call("sealround_place_bid", { ...bid, sale_id: "Not A Sale" }), "usage");
    const unreachable = await keyed.call("sealround_get_sale", { sale_id: "lantern" });
    t.eq("a read with the RPC down fails as rpc_unreachable", [unreachable.isError, unreachable.json.error?.code], [true, "rpc_unreachable"]);

    const bare = await Mcp.start("no-relayer", { ...local, SEALROUND_PRIVATE_KEY: fakeKey });
    refusedWith(t, "place_bid with no relayer and no direct", await bare.call("sealround_place_bid", bid), "not_sponsored");
    refusedWith(t, "claim with no relayer and no direct", await bare.call("sealround_claim", { sale_id: "lantern" }), "not_sponsored");

    const noKey = await Mcp.start("no-key", { ...local, SEALROUND_RELAYER_URL: DEAD_URL });
    refusedWith(t, "place_bid with no key", await noKey.call("sealround_place_bid", bid), "missing_key");
    refusedWith(t, "claim with no key", await noKey.call("sealround_claim", { sale_id: "lantern" }), "missing_key");

    const badKey = await Mcp.start("bad-key", { ...local, SEALROUND_PRIVATE_KEY: "ed25519:not-a-key", SEALROUND_RELAYER_URL: DEAD_URL });
    refusedWith(t, "place_bid with a malformed key", await badKey.call("sealround_place_bid", bid), "bad_key");

    const keyFile = path.join(RUN_DIR, "agent-key.json");
    writeFileSync(keyFile, JSON.stringify({ account_id: "agent.test.near", private_key: fakeKey }));
    const both = await Mcp.start("two-keys", { ...local, SEALROUND_PRIVATE_KEY: fakeKey, SEALROUND_KEY_FILE: keyFile, SEALROUND_RELAYER_URL: DEAD_URL });
    refusedWith(t, "a key in both SEALROUND_PRIVATE_KEY and SEALROUND_KEY_FILE", await both.call("sealround_place_bid", bid), "config");
    const other = await Mcp.start("key-file-account", { ...local, SEALROUND_ACCOUNT: "someone.test.near", SEALROUND_KEY_FILE: keyFile });
    refusedWith(t, "a key file of another account than SEALROUND_ACCOUNT", await other.call("sealround_get_sale", { sale_id: "lantern" }), "config", false);

    const mainnet = await Mcp.start("mainnet", { ...local, SEALROUND_NETWORK: "mainnet", SEALROUND_PRIVATE_KEY: fakeKey, SEALROUND_RELAYER_URL: DEAD_URL });
    refusedWith(t, "place_bid on mainnet without SEALROUND_ALLOW_MAINNET", await mainnet.call("sealround_place_bid", bid), "mainnet_not_confirmed");
    refusedWith(t, "claim on mainnet without SEALROUND_ALLOW_MAINNET", await mainnet.call("sealround_claim", { sale_id: "lantern" }), "mainnet_not_confirmed");
    const read = await mainnet.call("sealround_get_sale", { sale_id: "lantern" });
    t.eq("a mainnet read is not refused (it reaches for the RPC)", read.json.error?.code, "rpc_unreachable");

    const leaked = transcript.some((x) => x.includes(fakeKey) || x.includes(fakeKey.slice(8)));
    t.ok("the key is in no tool answer and no server log", !leaked);
  });
}

// ---------------------------------------------------------------- sandbox

let world: World | null = null;
let cleaned = false;

async function cleanup(): Promise<string[]> {
  if (cleaned) return [];
  cleaned = true;
  const problems: string[] = [];
  await Promise.all(servers.map((s) => s.close()));
  await world?.worker.stop().catch(() => {});
  await world?.stopRelayer().catch((e: unknown) => problems.push(`stopping the relayer: ${e instanceof Error ? e.message : String(e)}`));
  if (!(await stopLeftoverRelayer(PID_FILE))) problems.push(`port ${RELAYER_PORT} is still in use`);
  if (world && !removeSandbox()) problems.push(`could not remove the ${SANDBOX_NAME} container`);
  return problems;
}

async function sandbox(w: World, report: Report): Promise<void> {
  const fg = w.fairground.id;
  const usdc = w.usdc.id;
  const { creator, alice, bobby, carol } = w.who;
  const app = w.client();
  const view = {
    sale: async (id: string) => (await w.chain.view<SaleView | null>(fg, "get_sale", { sale_id: id }))!,
    bid: (id: string, bidder: string) => w.chain.view<BidView | null>(fg, "get_bid", { sale_id: id, bidder }),
    bids: (id: string) => w.chain.view<BidView[]>(fg, "get_bids", { sale_id: id, from_index: 0, limit: 50 }),
    usdc: (account: string) => w.chain.ft(usdc, account),
  };
  const envFor = (who: Named | null, extra: Record<string, string> = {}): Record<string, string> => ({
    SEALROUND_NETWORK: "sandbox",
    SEALROUND_RPC_URL: w.chain.rpcUrl,
    SEALROUND_CONTRACT: fg,
    SEALROUND_RELAYER_URL: RELAYER_URL,
    SEALROUND_SECRET_DIR: SECRETS,
    ...(who ? { SEALROUND_ACCOUNT: who.id, SEALROUND_PRIVATE_KEY: who.secret } : {}),
    ...extra,
  });
  /** A refusal that must leave the account's key nonce and USDC as they were. */
  const unchanged = async (t: Checks, label: string, who: Named, act: () => Promise<Called>, code: string) => {
    const [nonce0, usdc0] = [await w.chain.nonceOf(who), await view.usdc(who.id)];
    refusedWith(t, label, await act(), code);
    t.eq(`${label}: ${who.id}'s nonce and USDC unchanged`, [await w.chain.nonceOf(who), await view.usdc(who.id)], [nonce0, usdc0]);
  };

  const TEE = "mcp-tee";
  const params: SaleParams = { saleSupply: 500n * TOKEN, floorPrice: 2_000n, minRaise: USDC, decimals: 18, maxPrice: null };
  /** Everyone's sealed terms, by account: the reference clearing needs them. */
  const terms = new Map<string, Omit<Bid, "bidder">>();
  let agent!: Named;
  let mcp!: Mcp;

  await report.scenario("setup", "setup: the e2e world, an agent account with 20 test USDC, a sealed-bid sale", [], async (t) => {
    agent = await w.chain.createAccount(w.root, "agent", 5);
    await w.root.callFunction({ contractId: usdc, methodName: "mint", args: { account_id: agent.id, amount: (20n * USDC).toString() }, gas: teraToGas(30) });
    t.eq("the agent holds 20 test USDC", await view.usdc(agent.id), 20n * USDC);
    await w.startRelayer("mcp");
    t.ok("the relayer answers", await portInUse(RELAYER_PORT));
    const now = Number((await w.chain.nowNs()) / 1_000_000n);
    const config: SaleConfig = {
      tokenName: "MCP Sealed",
      tokenSymbol: "MCPS",
      decimals: 18,
      totalSupply: 1_000n * TOKEN,
      saleSupply: params.saleSupply,
      creatorAllocation: 500n * TOKEN,
      lpReserve: 0n,
      floorPrice: params.floorPrice,
      maxPrice: null,
      minRaise: params.minRaise,
      bidStart: now,
      bidEnd: now + 300_000,
      minDeposit: USDC,
      maxDepositPerAccount: 10n * USDC,
      revealMode: "tee",
      unsoldRule: "burn",
      settleTimeoutMs: 600_000,
      quoteToken: usdc,
      maxBids: 8,
    };
    const meta: SaleMeta = { description: "Sealed-bid sale for the MCP server test.", hue: 0, website: "https://example.com/mcp" };
    const sale = await app.createSale(creator.id, config, meta, { saleId: TEE, minStartLeadMs: 10_000 });
    t.eq("the sale is created with its key and is not open yet", [sale.sealerKeySetup, sale.chainStatus], ["done", "upcoming"]);
    mcp = await Mcp.start("agent", envFor(agent));
  });

  await report.scenario("read", "list_sales and get_sale: rules, phase and public totals, nothing sealed", ["setup"], async (t) => {
    const list = await mcp.call("sealround_list_sales");
    const ids = ((list.json["sales"] as { id: string }[] | undefined) ?? []).map((s) => s.id);
    t.ok("list_sales lists the sale", !list.isError && ids.includes(TEE), show(list.json.error ?? ids));
    const settled = await mcp.call("sealround_list_sales", { phase: "settled" });
    t.eq("list_sales with phase settled does not", ((settled.json["sales"] as unknown[] | undefined) ?? []).length, 0);
    const r = await mcp.call("sealround_get_sale", { sale_id: TEE });
    t.ok("get_sale answers", !r.isError, show(r.json.error));
    const sale = r.json["sale"];
    t.eq("status upcoming, mode tee, sealed to the enclave", [get(sale, "status"), get(sale, "mode"), get(sale, "bidsSealedToEnclave")], ["upcoming", "tee", true]);
    t.eq("floor price 0.002 USDC (2000 base units), min deposit 1 USDC", [get(sale, "rules", "floorPrice", "amount"), get(sale, "rules", "floorPrice", "base"), get(sale, "rules", "minDeposit", "amount")], ["0.002", "2000", "1"]);
    t.eq("public totals: no bids yet", [get(sale, "totals", "bidCount"), get(sale, "totals", "totalDeposits", "base")], [0, "0"]);
    t.eq("the configured account's balance and bid", [get(r.json, "account", "quoteBalance", "amount"), get(r.json, "account", "bid")], ["20", null]);
    t.ok("nothing sealed in the answer (no payload, ciphertext or salt)", !/"(payload|ciphertext|salt)"/.test(r.text));
  });

  const agentBid = { sale_id: TEE, max_price: "0.02", max_spend: "2", max_deposit: "5", deposit: "5" };

  await report.scenario("refusals", "refusals on chain: nothing signed, nothing moved", ["setup"], async (t) => {
    await unchanged(t, "place_bid before the sale opens", agent, () => mcp.call("sealround_place_bid", agentBid), "sale_closed");
    await unchanged(t, "place_bid above max_deposit", agent, () => mcp.call("sealround_place_bid", { ...agentBid, max_deposit: "4.999999" }), "over_budget");
    await unchanged(t, "a void bid (max_spend above the deposit)", agent, () => mcp.call("sealround_place_bid", { ...agentBid, deposit: "2", max_spend: "3" }), "invalid_terms");
    await unchanged(t, "a void bid (max_price below the floor)", agent, () => mcp.call("sealround_place_bid", { ...agentBid, max_price: "0.001" }), "invalid_terms");
    const wrongKey = await Mcp.start("wrong-key", envFor(agent, { SEALROUND_ACCOUNT: alice.id }));
    const [aliceNonce, aliceUsdc] = [await w.chain.nonceOf(alice), await view.usdc(alice.id)];
    await unchanged(t, "alice's account with the agent's key", agent, () => wrongKey.call("sealround_place_bid", agentBid), "key_mismatch");
    t.eq("and alice's nonce and USDC unchanged too", [await w.chain.nonceOf(alice), await view.usdc(alice.id)], [aliceNonce, aliceUsdc]);
    const testnet = await Mcp.start("wrong-network", envFor(agent, { SEALROUND_NETWORK: "testnet" }));
    refusedWith(t, "SEALROUND_NETWORK testnet against the sandbox RPC", await testnet.call("sealround_get_sale", { sale_id: TEE }), "wrong_network", false);
    const mainnet = await Mcp.start("mainnet", envFor(agent, { SEALROUND_NETWORK: "mainnet" }));
    await unchanged(t, "place_bid on mainnet without SEALROUND_ALLOW_MAINNET", agent, () => mainnet.call("sealround_place_bid", agentBid), "mainnet_not_confirmed");
    refusedWith(t, "a sale that does not exist", await mcp.call("sealround_get_sale", { sale_id: "no-such-sale" }), "sale_not_found", false);
  });

  let secretFile = "";
  await report.scenario("bid", "place_bid: sealed in the server, relayed, the secret file saved", ["setup"], async (t) => {
    await w.chain.advanceTo(BigInt((await view.sale(TEE)).bid_start));
    const near0 = await w.chain.nearOf(agent.id);
    const usdc0 = await view.usdc(agent.id);
    const r = await mcp.call("sealround_place_bid", agentBid);
    if (r.isError) throw new Error(`place_bid failed: ${show(r.json.error)}`);
    terms.set(agent.id, { deposit: 5n * USDC, maxPrice: 20_000n, maxSpend: 2n * USDC });
    const onChain = await view.bid(TEE, agent.id);
    t.eq("bid #0 on chain, as reported", [r.json["index"], onChain?.index], [0, 0]);
    t.ok("it reports the transaction hash, and the relayer paid", TX_HASH.test(String(r.json["txHash"])) && r.json["paidBy"] === "relayer", show([r.json["txHash"], r.json["paidBy"]]));
    const tx = await w.chain.rpc<{ transaction: { signer_id: string; receiver_id: string } }>("tx", { tx_hash: r.json["txHash"], sender_account_id: w.relayerAccount.id, wait_until: "EXECUTED_OPTIMISTIC" });
    t.eq("on chain the relayer signed it, carrying the agent's delegate", [tx.transaction.signer_id, tx.transaction.receiver_id], [w.relayerAccount.id, agent.id]);
    t.eq("the agent paid no NEAR, and 5 USDC left it", [(await w.chain.nearOf(agent.id)) - near0, usdc0 - (await view.usdc(agent.id))], [0n, 5n * USDC]);
    const payload = Buffer.from(onChain!.payload, "base64");
    t.eq("the sealed bid is 224 + len(sale id) + len(bidder) bytes", payload.length, 224 + TEE.length + agent.id.length);
    secretFile = String(r.json["secretFile"]);
    const secret = existsSync(secretFile) ? (JSON.parse(readFileSync(secretFile, "utf8")) as Record<string, unknown>) : {};
    t.eq("the secret file holds the terms, the salt and the outcome", [secret["maxPrice"], secret["maxSpend"], /^[0-9a-f]{32}$/.test(String(secret["salt"])), secret["status"], secret["txHash"]], ["20000", "2000000", true, "placed", r.json["txHash"]]);
    t.eq("its hash of the sealed bytes is the hash of the bid on chain", secret["ciphertextSha256"], createHash("sha256").update(payload).digest("hex"));
    t.ok("the answer carries no max price, max spend, salt or ciphertext", !["maxPrice", "maxSpend", "salt", "ciphertext"].some((k) => Object.hasOwn(r.json, k)) && !r.text.includes(String(secret["salt"])));
    await unchanged(t, "a second bid from the agent", agent, () => mcp.call("sealround_place_bid", agentBid), "already_bid");

    const mine = await mcp.call("sealround_my_bid", { sale_id: TEE });
    t.eq("my_bid: the public bid and the secret file, no result yet", [get(mine.json, "bid", "index"), get(mine.json, "bid", "deposit", "amount"), get(mine.json, "secretFile", "status"), mine.json["result"]], [0, "5", "placed", null]);
  });

  await report.scenario("direct", "place_bid with direct: true signs and pays from the account", ["bid"], async (t) => {
    const paid = await Mcp.start("carol-direct", envFor(carol, { SEALROUND_RELAYER_URL: "" }));
    const carolBid = { sale_id: TEE, max_price: "0.004", max_spend: "3", max_deposit: "3" };
    await unchanged(t, "without direct and with no relayer", carol, () => paid.call("sealround_place_bid", carolBid), "not_sponsored");
    const near0 = await w.chain.nearOf(carol.id);
    const r = await paid.call("sealround_place_bid", { ...carolBid, direct: true });
    if (r.isError) throw new Error(`direct place_bid failed: ${show(r.json.error)}`);
    terms.set(carol.id, { deposit: 3n * USDC, maxPrice: 4_000n, maxSpend: 3n * USDC });
    t.ok("accepted, paid by the account itself", r.json["paidBy"] === "user" && TX_HASH.test(String(r.json["txHash"])), show([r.json["paidBy"], r.json["txHash"]]));
    t.ok("carol paid the gas", (await w.chain.settledNear(carol.id)) < near0);
  });

  await report.scenario("close", "people bid through the web client; the sale closes; the enclave clears", ["bid"], async (t) => {
    for (const [who, deposit, maxPrice] of [[alice, 3n * USDC, 6_000n], [bobby, 3n * USDC, 5_000n]] as const) {
      await app.bid(TEE, who.id, deposit, { maxPrice, maxSpend: deposit });
      terms.set(who.id, { deposit, maxPrice, maxSpend: deposit });
    }
    const early = await mcp.call("sealround_get_result", { sale_id: TEE });
    t.eq("get_result before settlement: not final, open", [early.isError, early.json["final"], early.json["status"]], [false, false, "open"]);
    await unchanged(t, "claim before settlement", agent, () => mcp.call("sealround_claim", { sale_id: TEE }), "not_settled");
    await w.chain.advanceTo(BigInt((await view.sale(TEE)).bid_end));
    const closed = await app.closeSale(TEE, creator.id);
    t.eq("the sale is settled", closed.chainStatus, "settled");
  });

  /** The reference clearing over the bids in their on-chain order. */
  const expected = async () => {
    const bids = await view.bids(TEE);
    const ordered = bids.sort((a, b) => a.index - b.index).map((b): Bid => ({ bidder: b.bidder, ...terms.get(b.bidder)! }));
    return { result: clear(params, ordered), order: ordered.map((b) => b.bidder) };
  };

  await report.scenario("result", "get_result and my_bid match the reference clearing to the base unit", ["close"], async (t) => {
    const { result: want, order } = await expected();
    const mineAt = order.indexOf(agent.id);
    const fill = want.fills[mineAt];
    const r = await mcp.call("sealround_get_result", { sale_id: TEE, include_fills: true });
    t.ok("get_result answers, final", !r.isError && r.json["final"] === true, show(r.json.error));
    t.eq("clearing price = reference clearing", get(r.json, "result", "clearingPrice", "base"), want.clearingPrice.toString());
    t.eq("every winner paid the clearing price; four fills listed", [get(r.json, "result", "everyWinnerPaidClearingPrice"), (get(r.json, "result", "fills") as unknown[] | undefined)?.length], [true, 4]);
    t.eq("the agent's tokens, spend and refund = reference clearing", [get(r.json, "account", "fill", "tokens", "base"), get(r.json, "account", "fill", "spent", "base"), get(r.json, "account", "fill", "refund", "base")], [fill.tokens.toString(), fill.spent.toString(), (fill.deposit - fill.spent).toString()]);
    t.eq("the live bot's report checks all pass", get(r.json, "account", "checksPassed"), true);
    t.eq("claimable: the fill's tokens and refund", [get(r.json, "account", "claimable", "tokens", "base"), get(r.json, "account", "claimable", "refund", "base")], [fill.tokens.toString(), (fill.deposit - fill.spent).toString()]);
    const mine = await mcp.call("sealround_my_bid", { sale_id: TEE });
    t.eq("my_bid after settlement shows the same fill", get(mine.json, "result", "fill", "tokens", "base"), fill.tokens.toString());
    const reader = await Mcp.start("no-key", envFor(null));
    const a = await reader.call("sealround_get_result", { sale_id: TEE, account: alice.id });
    t.eq("without a key, alice's fill = reference clearing", get(a.json, "account", "fill", "spent", "base"), want.fills[order.indexOf(alice.id)].spent.toString());
    const list = await reader.call("sealround_list_sales", { phase: "final" });
    t.ok("without a key, list_sales works", !list.isError && JSON.stringify(list.json["sales"]).includes(TEE));
  });

  await report.scenario("verify", "verify_sale: no OutLayer service on a sandbox; the bid set matches", ["close"], async (t) => {
    const r = await mcp.call("sealround_verify_sale", { sale_id: TEE });
    t.ok("verify_sale answers", !r.isError, show(r.json.error));
    const runs = (r.json["runs"] as { kind: string; found: boolean; reason?: string; message?: string }[] | undefined) ?? [];
    t.eq("both runs (key, clear) are reported not found: no_service", runs.map((x) => [x.kind, x.found, x.reason]), [["key", false, "no_service"], ["clear", false, "no_service"]]);
    t.ok("with the web client's words", runs.every((x) => (x.message ?? "").includes("no OutLayer attestation service")));
    t.eq("the bid set: recomputed hash = frozen hash, 4 of 4 bids, the agent's bid is #1", [get(r.json, "bidSet", "result"), get(r.json, "bidSet", "listed"), get(r.json, "bidSet", "accountPlace")], ["pass", 4, 1]);
    t.eq("the recomputed hash is the contract's", get(r.json, "bidSet", "recomputedHash"), (await view.sale(TEE)).bid_set_hash);
    t.eq("verdict: incomplete, not a pass", [r.json["verdict"], r.json["ok"]], ["incomplete", false]);
  });

  await report.scenario("claim", "claim: tokens and refund, gasless; a second claim is refused", ["result"], async (t) => {
    const { result: want, order } = await expected();
    const fill = want.fills[order.indexOf(agent.id)];
    const near0 = await w.chain.nearOf(agent.id);
    const r = await mcp.call("sealround_claim", { sale_id: TEE });
    if (r.isError) throw new Error(`claim failed: ${show(r.json.error)}`);
    t.ok("claimed through the relayer", r.json["paidBy"] === "relayer" && TX_HASH.test(String(r.json["txHash"])), show([r.json["paidBy"], r.json["txHash"]]));
    t.eq("it paid out the fill's tokens and refund", [get(r.json, "received", "tokens", "base"), get(r.json, "received", "quote", "base")], [fill.tokens.toString(), (fill.deposit - fill.spent).toString()]);
    t.eq("the agent paid no NEAR; its bid is claimed", [(await w.chain.nearOf(agent.id)) - near0, (await view.bid(TEE, agent.id))?.claimed], [0n, true]);
    await unchanged(t, "a second claim", agent, () => mcp.call("sealround_claim", { sale_id: TEE }), "already_claimed");
  });

  await report.scenario("keys", "no key in any tool answer or server log", ["setup"], async (t) => {
    const secrets = [agent, carol].flatMap((who) => [who.secret, who.secret.slice("ed25519:".length)]);
    t.ok(`${transcript.length} answers and log chunks hold no key`, !transcript.some((x) => secrets.some((s) => x.includes(s))));
  });
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const started = Date.now();
  console.log(`Sealround MCP server, ${OFFLINE ? "offline checks only" : `offline checks, then a local chain (${SANDBOX_NAME} on 127.0.0.1:${SANDBOX_PORT}, relayer on 127.0.0.1:${RELAYER_PORT})`}\n`);
  if (!OFFLINE) {
    if (sandboxExists()) {
      console.error(`The container ${SANDBOX_NAME} exists: the e2e run or another sandbox test is using it. Run again when it is gone.`);
      cleaned = true;
      return 2;
    }
    if (!(await stopLeftoverRelayer(PID_FILE))) {
      console.error(`Port ${RELAYER_PORT} is in use by a process this test did not start. Run again when it is free.`);
      cleaned = true;
      return 2;
    }
  }
  rmSync(RUN_DIR, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(RUN_DIR, { recursive: true });

  const report = new Report();
  try {
    await offline(report);
    if (!OFFLINE) {
      world = await buildWorld(RUN_DIR, (line) => console.log(line));
      await sandbox(world, report);
    }
  } catch (e) {
    console.error(`\nThe run could not be set up: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    report.scenarios.push({ id: "sandbox", title: "the sandbox world", status: "fail", aborted: true, checks: [], error: e instanceof Error ? e.message : String(e), ms: 0 });
  }
  const problems = await cleanup();
  console.log(`\n${"=".repeat(100)}\n`);
  console.log(report.scenarios.length > 0 ? report.table() : "No scenario ran.");
  for (const problem of problems) console.log(`TEARDOWN PROBLEM: ${problem}`);
  for (const s of servers) if (s.log.some((l) => /could not start/.test(l))) console.log(`SERVER ${s.label}: ${s.log.join("").slice(-400)}`);
  console.log(`\nTook ${((Date.now() - started) / 1000).toFixed(0)} s. Logs and bid secret files: ${RUN_DIR}`);
  writeFileSync(path.join(RUN_DIR, "report.json"), JSON.stringify({ passed: report.allPassed && problems.length === 0, offlineOnly: OFFLINE, scenarios: report.scenarios, teardown: problems }, null, 2));
  return report.allPassed && problems.length === 0 ? 0 : 1;
}

/** Ends with `code` once the event loop is empty; process.exit() is only the fallback (see live-bot/run.ts). */
function exit(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 15_000).unref();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
  process.on(signal, () => {
    console.error(`\n${signal}: stopping the servers and the relayer, removing the container`);
    void cleanup().finally(() => process.exit(130));
  });
}

main().then(exit, async (e: unknown) => {
  console.error(e);
  await cleanup();
  exit(1);
});
