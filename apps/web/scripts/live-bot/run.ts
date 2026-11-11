/**
 * Sealround's live sniper bot, for testnet, mainnet or a local sandbox.
 *
 *   pnpm --filter web live-bot <snipe|copycat|report|reveal|status> [options]
 *
 * What it proves on a real chain: a bot that bids in the first block of a
 * sale still pays exactly the clearing price, like every other winner, and a
 * copycat that replays someone else's sealed bid is rejected. See README.md
 * in this folder for the commands, and bot.ts for how each one works.
 *
 * The bot's key is read from the LIVE_BOT_PRIVATE_KEY environment variable or
 * from a near-cli credentials file (--key-file), never from a flag: a flag
 * lands in the shell history. It stays in this process and is never printed.
 *
 * Output: progress and a readable summary, or with --json one JSON object on
 * stdout (progress then goes to stderr). Exit code 0 on success, 1 when the
 * command failed on the way (or a report check failed), 2 when it refused
 * before sending anything (bad options, wrong network, missing key, unknown
 * or closed sale).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { NearNetwork } from "../../src/lib/config";
import { BotError, connect, copycat, DEFAULT_RPC, describe, report, reveal, snipe, status, type BotOptions } from "./bot";
import { renderCopycat, renderReport, renderReveal, renderSnipe, renderStatus } from "./render";

const HERE = typeof __dirname === "string" ? __dirname : path.resolve("scripts/live-bot");
const COMMANDS = ["snipe", "copycat", "report", "reveal", "status"] as const;
type Command = (typeof COMMANDS)[number];

/** Flags that take a value, and the environment variable each falls back to. */
const VALUE_FLAGS = {
  network: "LIVE_BOT_NETWORK",
  rpc: "LIVE_BOT_RPC_URL",
  contract: "LIVE_BOT_CONTRACT",
  sale: "LIVE_BOT_SALE",
  account: "LIVE_BOT_ACCOUNT",
  "key-file": "LIVE_BOT_KEY_FILE",
  relayer: "LIVE_BOT_RELAYER_URL",
  deposit: "LIVE_BOT_DEPOSIT",
  "max-price": "LIVE_BOT_MAX_PRICE",
  "max-spend": "LIVE_BOT_MAX_SPEND",
  victim: "LIVE_BOT_VICTIM",
  "receipt-dir": "LIVE_BOT_RECEIPT_DIR",
  "poll-ms": "LIVE_BOT_POLL_MS",
  "max-wait": "LIVE_BOT_MAX_WAIT",
} as const;
const BOOL_FLAGS = ["json", "claim", "wait", "direct", "yes-mainnet", "help"] as const;
const KEY_FLAGS = /^--(key|private-key|secret-key|secret|privkey|sk)(=|$)/;

const HELP = `Sealround live sniper bot

  pnpm --filter web live-bot <command> [options]

Commands
  status    the sale, the bot account and the relayer; sends nothing
  snipe     wait for the sale to open, then place the bot's sealed bid in the first block it can
  copycat   replay --victim's sealed bid (or commitment) from the bot account, and show it rejected
  report    after settlement: the bot's fill against the clearing price, to the smallest unit
            (--claim also claims its tokens and refund; --wait waits for the settlement)
  reveal    commit-reveal sales only: reveal the bot's bid from its snipe receipt (--wait)

Options (each also read from the environment variable shown)
  --network <testnet|mainnet|sandbox>   LIVE_BOT_NETWORK       required
  --rpc <url>                           LIVE_BOT_RPC_URL       default: the network's public RPC
  --contract <account>                  LIVE_BOT_CONTRACT      the Sealround contract, required
  --sale <id>                           LIVE_BOT_SALE          required
  --account <account>                   LIVE_BOT_ACCOUNT       the bot account
  --key-file <path>                     LIVE_BOT_KEY_FILE      near-cli credentials JSON of the bot account
                                        LIVE_BOT_PRIVATE_KEY   or the key itself, "ed25519:...": environment only
  --relayer <url>                       LIVE_BOT_RELAYER_URL   gasless through this relayer; without it the bot pays
  --direct                                                     ignore the relayer: the bot signs and pays
  --deposit <amount>                    LIVE_BOT_DEPOSIT       USDC, e.g. 5 (copycat default: the sale's minimum)
  --max-price <amount>                  LIVE_BOT_MAX_PRICE     USDC per whole token, e.g. 0.02 (snipe)
  --max-spend <amount>                  LIVE_BOT_MAX_SPEND     USDC (snipe; default: the deposit)
  --victim <account>                    LIVE_BOT_VICTIM        copycat: whose bid to replay
  --receipt-dir <dir>                   LIVE_BOT_RECEIPT_DIR   default: scripts/live-bot/.run/receipts
  --poll-ms <ms>                        LIVE_BOT_POLL_MS       head polling in the last seconds, default 200
  --max-wait <seconds>                  LIVE_BOT_MAX_WAIT      how long to wait for the open or a phase, default 86400
  --json                                                       one JSON object on stdout
  --yes-mainnet                                                required to act on mainnet

The key is never a flag: it would be saved in your shell history.`;

type Parsed = { command: Command | null; values: Partial<Record<keyof typeof VALUE_FLAGS, string>>; flags: Set<string> };

function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = { command: null, values: {}, flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (KEY_FLAGS.test(arg)) {
      throw new BotError("usage", `${arg.split("=")[0]}: the key is not taken from the command line, where it would be saved in your shell history. Put it in LIVE_BOT_PRIVATE_KEY, or pass --key-file.`);
    }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if ((BOOL_FLAGS as readonly string[]).includes(name)) {
        if (inline !== undefined) throw new BotError("usage", `--${name} takes no value.`);
        parsed.flags.add(name);
      } else if (Object.hasOwn(VALUE_FLAGS, name)) {
        const value = inline ?? argv[++i];
        if (value === undefined || value.startsWith("--")) throw new BotError("usage", `--${name} needs a value.`);
        parsed.values[name as keyof typeof VALUE_FLAGS] = value;
      } else {
        throw new BotError("usage", `Unknown option ${arg}. See --help.`);
      }
    } else if (parsed.command === null && (COMMANDS as readonly string[]).includes(arg)) {
      parsed.command = arg as Command;
    } else {
      throw new BotError("usage", `Unexpected argument "${arg}". Commands: ${COMMANDS.join(", ")}.`);
    }
  }
  return parsed;
}

/** The bot's key and account from LIVE_BOT_PRIVATE_KEY or a near-cli credentials file. */
function readKey(keyFile: string | undefined, env: NodeJS.ProcessEnv): { secretKey: string | null; keySource: string | null; accountId: string | null } {
  const fromEnv = env["LIVE_BOT_PRIVATE_KEY"]?.trim();
  if (fromEnv && keyFile) throw new BotError("usage", "Both LIVE_BOT_PRIVATE_KEY and a key file are set: use one.");
  if (fromEnv) return { secretKey: fromEnv, keySource: "LIVE_BOT_PRIVATE_KEY", accountId: null };
  if (!keyFile) return { secretKey: null, keySource: null, accountId: null };
  let parsed: { account_id?: string; private_key?: string; secret_key?: string };
  try {
    parsed = JSON.parse(readFileSync(keyFile, "utf8")) as typeof parsed;
  } catch (e) {
    throw new BotError("bad_key", `Could not read the key file ${keyFile} as near-cli credentials JSON (${e instanceof Error ? e.message.split("\n")[0] : String(e)}).`);
  }
  const secretKey = parsed.private_key ?? parsed.secret_key ?? null;
  if (!secretKey) throw new BotError("bad_key", `The key file ${keyFile} has no "private_key".`);
  return { secretKey, keySource: `the key file ${keyFile}`, accountId: parsed.account_id ?? null };
}

function options(parsed: Parsed, env: NodeJS.ProcessEnv, say: (line: string) => void): BotOptions {
  const value = (name: keyof typeof VALUE_FLAGS): string | null => {
    const v = parsed.values[name] ?? env[VALUE_FLAGS[name]];
    return v === undefined || v.trim() === "" ? null : v.trim();
  };
  const network = value("network");
  if (network !== "testnet" && network !== "mainnet" && network !== "sandbox") {
    throw new BotError("usage", `--network (or LIVE_BOT_NETWORK) must be testnet, mainnet or sandbox${network ? ` (got "${network}")` : ""}.`);
  }
  const contractId = value("contract");
  const saleId = value("sale");
  if (!contractId) throw new BotError("usage", "--contract (or LIVE_BOT_CONTRACT) is required: the Sealround contract account.");
  if (!saleId) throw new BotError("usage", "--sale (or LIVE_BOT_SALE) is required.");
  const key = readKey(value("key-file") ?? undefined, env);
  const accountId = value("account") ?? key.accountId;
  if (key.accountId && accountId !== key.accountId) throw new BotError("usage", `The key file belongs to ${key.accountId}, not to --account ${accountId}.`);
  const number = (name: "poll-ms" | "max-wait", fallback: number, min: number) => {
    const raw = value(name);
    const n = raw === null ? fallback : Number(raw);
    if (!Number.isFinite(n) || n < min) throw new BotError("usage", `--${name} must be a number of at least ${min}.`);
    return n;
  };
  const rpcUrl = value("rpc") ?? DEFAULT_RPC[network as NearNetwork];
  try {
    if (!/^https?:$/.test(new URL(rpcUrl).protocol)) throw new Error("protocol");
  } catch {
    throw new BotError("usage", `--rpc must be an http(s) URL (got "${rpcUrl}").`);
  }
  return {
    network,
    rpcUrl,
    contractId,
    saleId,
    accountId,
    secretKey: key.secretKey,
    keySource: key.keySource,
    relayerUrl: parsed.flags.has("direct") ? null : value("relayer"),
    deposit: value("deposit"),
    maxPrice: value("max-price"),
    maxSpend: value("max-spend"),
    victim: value("victim"),
    receiptDir: path.resolve(value("receipt-dir") ?? path.join(HERE, ".run", "receipts")),
    pollMs: number("poll-ms", 200, 20),
    maxWaitMs: number("max-wait", 86_400, 1) * 1000,
    allowMainnet: parsed.flags.has("yes-mainnet"),
    claim: parsed.flags.has("claim"),
    wait: parsed.flags.has("wait"),
    say,
  };
}

/** Runs one command. Returns the exit code; prints as it goes. */
async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let json = argv.includes("--json");
  const out = (text: string) => process.stdout.write(`${text}\n`);
  const say = (line: string) => (json ? process.stderr : process.stdout).write(`  .. ${line}\n`);
  try {
    const parsed = parseArgs(argv);
    json = parsed.flags.has("json");
    if (parsed.flags.has("help") || parsed.command === null) {
      out(HELP);
      return parsed.command === null && !parsed.flags.has("help") ? 2 : 0;
    }
    const opts = options(parsed, env, say);
    const command = parsed.command;
    const writes = command === "snipe" || command === "copycat" || command === "reveal" || (command === "report" && opts.claim);
    const session = await connect(opts, { account: command !== "status", key: writes });
    say(`${opts.network} (chain "${session.chainId}") at ${opts.rpcUrl}; contract ${opts.contractId}; sale ${opts.saleId} (${session.sale.status})${opts.accountId ? `; bot ${opts.accountId}` : ""}`);
    let result: { ok: boolean };
    let text: string;
    switch (command) {
      case "status": {
        const r = await status(session);
        [result, text] = [r, renderStatus(r)];
        break;
      }
      case "snipe": {
        const r = await snipe(session);
        [result, text] = [r, renderSnipe(r)];
        break;
      }
      case "copycat": {
        const r = await copycat(session);
        [result, text] = [r, renderCopycat(r)];
        break;
      }
      case "report": {
        const r = await report(session);
        [result, text] = [r, renderReport(r)];
        break;
      }
      case "reveal": {
        const r = await reveal(session);
        [result, text] = [r, renderReveal(r)];
        break;
      }
    }
    out(json ? JSON.stringify(result, null, 2) : `\n${text}`);
    return result.ok ? 0 : 1;
  } catch (e) {
    const code = e instanceof BotError ? e.code : "error";
    const message = e instanceof BotError ? e.message : describe(e);
    if (json) out(JSON.stringify({ ok: false, error: { code, message } }, null, 2));
    else process.stderr.write(`\nERROR (${code}): ${message}\n`);
    if (!(e instanceof BotError) && e instanceof Error && env["LIVE_BOT_DEBUG"]) process.stderr.write(`${e.stack}\n`);
    return e instanceof BotError ? e.exitCode : 1;
  }
}

/**
 * Ends with `code` once the event loop is empty, so everything printed gets
 * out and every socket is closed. process.exit() while an RPC socket is still
 * closing trips a libuv assertion on Windows (exit code 0xC0000409), so it is
 * only the fallback for a handle that never closes.
 */
function exit(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 15_000).unref();
}

main(process.argv.slice(2)).then(exit, (e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  exit(1);
});
