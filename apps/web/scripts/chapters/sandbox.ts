/** Runs the Lantern or Fair Test pilot on a disposable NEAR sandbox. */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { commitmentHex } from "@fairground/clearing";
import { actions, teraToGas, type Account, type SerializedReturnValue } from "near-api-js";
import { createRpc } from "../../src/lib/near/rpc";
import { checkRheaSwap, quoteRhea, rheaSwapAction, RHEA_SANDBOX, type RheaChain, type RheaQuote } from "../../src/lib/near/rhea-swap";
import { verifyPayoutReceipt } from "../../src/lib/chapters/payout-receipt";
import type { ResultView, SaleView } from "../../src/lib/near/views";
import { Chain, REPO_DIR, WEB_DIR, sleep, type Named, type Validator } from "../e2e/chain";
import { Report, type Checks } from "../e2e/report";

const SECOND = 1_000_000_000n;
const TOKEN = 10n ** 18n;
const USDC = 1_000_000n;
const BOUNTY = 10n * USDC;
const STORAGE = 10n ** 22n;
const SALE_ID = "lantern";
const BIN = path.join(REPO_DIR, ".sandbox-bin", "2.14.0", "Linux-x86_64");
const RES = path.join(REPO_DIR, "contracts", "res");
const RUN_DIR = path.join(WEB_DIR, "scripts", "chapters", ".run");
const CONTAINER = `near-sandbox-chapters-${process.pid}-${randomBytes(4).toString("hex")}`;

type Candidate = { title: string; artist: string; content_sha256: string };
type Chapter = { title: string; candidates: [Candidate, Candidate]; submission_ids?: [number, number] | null };
type Submission = Candidate & { submission_id: number; round_id: number; mime_type: string; parent_sha256: string | null };
type Manifest = { rounds: [{ title: string; candidates: [Candidate & { image: string }, Candidate & { image: string }] }, { title: string; candidates: [Candidate & { image: string }, Candidate & { image: string }] }] };
type Payment = "unclaimed" | "pending" | "paid";
type Registration = {
  phase: "deploying" | "enabled";
  contract_id: string;
  curator: string;
  token_id: string;
  quote_token_id: string;
  title: string;
  brief: string;
};
type Round = {
  round_id: number;
  title: string;
  candidates: [Candidate, Candidate];
  starts_at: string;
  commit_end: string;
  reveal_end: string;
  phase: "funding" | "commit" | "reveal" | "awaiting_finalization" | "finalized";
  funded: boolean;
  locked: string;
  revealed: string;
  tallies: [string, string];
  outcome: "winner" | "tie" | "no_quorum" | "unfunded" | null;
  winner: 0 | 1 | null;
  bounty_state: Payment;
  submission_ids: [number, number] | null;
  parent_sha256: string | null;
};
type Vote = { amount: string; commitment: string; revealed_choice: 0 | 1 | null; withdrawal_state: Payment };
type Payout = { recipient: string; token_id: string; amount: string; state: Payment; paid_at: string | null; attempt: number };

// Distinct 16x16 PNG files keep this scenario independent of the gallery assets.
const ART_PNGS = [
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAI0lEQVR4nGO8vCCagRTAQpJqhlENxAEWItXBwagGYgDJoQQA5gcCDJsebXUAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAI0lEQVR4nGO0CO9nIAWwkKSaYVQDcYCFSHVwMKqBGEByKAEAy3oBXDGejK4AAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAI0lEQVR4nGOs8XBnIAWwkKSaYVQDcYCFSHVwMKqBGEByKAEAkfwBSa4/q8sAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAI0lEQVR4nGNUDUthIAWwkKSaYVQDcYCFSHVwMKqBGEByKAEACyABHQf+KkwAAAAASUVORK5CYII=",
];

function loadChapters(): [Chapter, Chapter] {
  const manifest = JSON.parse(readFileSync(path.join(WEB_DIR, "public", "chapters", "lantern.json"), "utf8")) as Manifest;
  if (manifest.rounds.length !== 2) throw new Error("The Lantern pilot needs exactly two chapters");
  const chapter = ({ title, candidates }: Manifest["rounds"][number]): Chapter => {
    if (candidates.length !== 2) throw new Error("Each chapter needs exactly two artists");
    function check({ image, artist, content_sha256, title: candidateTitle }: Manifest["rounds"][number]["candidates"][number]): Candidate {
      if (!/^\/chapters\/lantern-[12]-[ab]\.webp$/.test(image)) throw new Error(`Unexpected art path: ${image}`);
      const bytes = readFileSync(path.join(WEB_DIR, "public", image.slice(1)));
      if (createHash("sha256").update(bytes).digest("hex") !== content_sha256) throw new Error(`Art hash mismatch: ${image}`);
      return { title: candidateTitle, artist, content_sha256 };
    }
    return { title, candidates: [check(candidates[0]), check(candidates[1])] };
  };
  return [chapter(manifest.rounds[0]), chapter(manifest.rounds[1])];
}

function docker(...args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout.trim();
}

async function startSandbox(): Promise<{ chain: Chain; root: Account }> {
  if (!existsSync(path.join(BIN, "near-sandbox"))) throw new Error("Run scripts/sandbox.ps1 once to cache nearcore sandbox 2.14.0");
  // Docker picks a free loopback port. This run cannot replace another agent's sandbox.
  docker("run", "-d", "--pull=never", "--name", CONTAINER, "-p", "127.0.0.1::3030", "-v", `${BIN}:/opt/sbx:ro`, "debian:trixie-slim", "sh", "-c",
    "/opt/sbx/near-sandbox --home /data init --fast && exec /opt/sbx/near-sandbox --home /data run --rpc-addr 0.0.0.0:3030 --network-addr 0.0.0.0:3031");
  const address = docker("port", CONTAINER, "3030/tcp");
  if (!/^127\.0\.0\.1:[0-9]+$/.test(address)) throw new Error(`Unexpected sandbox address: ${address}`);
  const chain = new Chain(`http://${address}`);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await chain.head()).height > 1) break;
    } catch {
      // Docker has started, but the RPC handler may still be booting.
    }
    if (attempt === 99) throw new Error(`Sandbox did not start at ${chain.rpcUrl}`);
    await sleep(300);
  }
  const key = JSON.parse(docker("exec", CONTAINER, "cat", "/data/validator_key.json")) as { account_id: string; secret_key?: string; private_key?: string };
  const secretKey = key.secret_key ?? key.private_key;
  if (!secretKey) throw new Error("The sandbox validator has no key");
  return { chain, root: chain.root({ accountId: key.account_id, secretKey } satisfies Validator) };
}

function call<T extends SerializedReturnValue>(actor: Account, contractId: string, methodName: string, args: Record<string, unknown> = {}, deposit = 0n, gas = 100) {
  return actor.callFunction<T>({ contractId, methodName, args, deposit, gas: teraToGas(gas), waitUntil: "FINAL" });
}

function register(actor: Account, token: string, accountId: string) {
  return call(actor, token, "storage_deposit", { account_id: accountId, registration_only: true }, STORAGE);
}

function transferCall(actor: Account, token: string, receiver: string, amount: bigint, message: unknown) {
  return call<string>(actor, token, "ft_transfer_call", {
    receiver_id: receiver,
    amount: amount.toString(),
    msg: JSON.stringify(message),
  }, 1n);
}

async function rejected(t: Checks, label: string, run: () => Promise<unknown>, reason: string) {
  try {
    await run();
    t.ok(label, false, "transaction unexpectedly succeeded");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    t.ok(label, message.includes(reason), message);
  }
}

async function launchSale(chain: Chain, root: Account, sale: Named, usdc: Named, bidders: Named[], fairTest: boolean, creator: Account, dex?: string) {
  await sale.account.deployContract(readFileSync(path.join(RES, "fairground.wasm")));
  const sealerHash = readFileSync(path.join(REPO_DIR, "enclave", "res", "fairground_sealer.wasm.sha256"), "utf8").trim().split(/\s+/)[0];
  await call(sale.account, sale.id, "new", {
    // Commit/reveal uses only the existing sale contract's on-chain clearing path.
    outlayer: root.accountId,
    sealer_source: { WasmUrl: { url: "https://example.invalid/fairground_sealer.wasm", hash: sealerHash, build_target: "wasm32-wasip1" } },
    sealer_code_hash: sealerHash,
    sealer_secrets: null,
    allowed_quote_tokens: [usdc.id],
    dex: dex ?? null,
  });
  const saleId = fairTest ? "fairt" : SALE_ID;
  const saleView = () => chain.view<SaleView>(sale.id, "get_sale", { sale_id: saleId });
  const start = await chain.nowNs() + 30n * SECOND;
  const bidEnd = start + 90n * SECOND;
  const params = {
    sale_id: saleId,
    token_name: fairTest ? "Fair Test" : "Lantern",
    token_symbol: fairTest ? "FAIRT" : "LNTN",
    decimals: 18,
    total_supply: ((dex ? 6_000n : 5_000n) * TOKEN).toString(),
    sale_supply: (4_000n * TOKEN).toString(),
    floor_price: "1000",
    min_raise: USDC.toString(),
    bid_start: start.toString(),
    bid_end: bidEnd.toString(),
    min_deposit: USDC.toString(),
    max_deposit_per_account: (2n * USDC).toString(),
    max_bids: bidders.length,
    reveal_mode: "CommitReveal",
    reveal_window: (90n * SECOND).toString(),
    settle_timeout: (600n * SECOND).toString(),
    quote_token: usdc.id,
    description: "Local fixture for creator-led chapters.",
    ...(dex && { liquidity: { raise_share_bps: 2000, pool_tokens: (1000n * TOKEN).toString(), fee_bps: 30 } }),
  };
  const storage = BigInt(await chain.view<string>(sale.id, "get_create_cost", { params }));
  await call(creator, sale.id, "create_sale", { params }, storage, 300);
  const token = (await saleView()).token;
  await chain.advanceTo(start);
  const bids = bidders.map((bidder) => ({ bidder, salt: randomBytes(16) }));
  for (const { bidder, salt } of bids) {
    await call(root, usdc.id, "mint", { account_id: bidder.id, amount: (2n * USDC).toString() });
    const commitment = commitmentHex(saleId, bidder.id, 1_000n, USDC, salt);
    await transferCall(bidder.account, usdc.id, sale.id, USDC, { sale_id: saleId, commitment });
  }
  await chain.advanceTo(bidEnd);
  await call(root, sale.id, "close_sale", { sale_id: saleId }, 0n, 300);
  const revealEnd = (await saleView()).reveal_end;
  if (!revealEnd) throw new Error("The fixture sale did not enter reveal");
  for (const { bidder, salt } of bids) {
    await call(bidder.account, sale.id, "reveal_bid", { sale_id: saleId, max_price: "1000", max_spend: USDC.toString(), salt: salt.toString("hex") });
  }
  await chain.advanceTo(BigInt(revealEnd));
  await call(root, sale.id, "clear_onchain", { sale_id: saleId }, 0n, 150);
  if ((await saleView()).status !== "settled") throw new Error("The fixture sale did not settle");
  let poolId: number | null = null;
  if (dex) {
    await call(root, sale.id, "seed_liquidity", { sale_id: saleId }, 0n, 300);
    const result = await chain.view<ResultView>(sale.id, "get_result", { sale_id: saleId });
    if (result.liquidity?.status !== "seeded" || result.liquidity.dex !== dex || result.liquidity.pool_id === null) {
      throw new Error(`The Rhea pool did not seed: ${result.liquidity?.status ?? "absent"} ${result.liquidity?.next_step ?? ""}`);
    }
    poolId = result.liquidity.pool_id;
  }
  for (const bidder of bidders) await call(bidder.account, sale.id, "claim", { sale_id: saleId, bidder: bidder.id }, 0n, 150);
  await call(creator, sale.id, "claim_proceeds", { sale_id: saleId }, 0n, 150);
  return { token, poolId };
}

async function deploySandboxRhea(chain: Chain, root: Account) {
  const pathToWasm = path.join(REPO_DIR, "contracts", "tests", "res", "ref_exchange.wasm");
  if (!existsSync(pathToWasm)) throw new Error("Fetch the pinned Rhea test WASM with node scripts/fetch-rhea-wasm.mjs first.");
  const wasm = readFileSync(pathToWasm);
  const pinnedHash = "8918c505017ceb57646bdd863c34e4fe56e2edc7756963d6f4a1f38d6f9c34d2";
  if (createHash("sha256").update(wasm).digest("hex") !== pinnedHash) throw new Error("Rhea test WASM did not match the pinned hash.");
  const dex = await chain.createAccount(root, "dex", 20);
  if (dex.id !== RHEA_SANDBOX) throw new Error("Expected the isolated local Rhea account.");
  await dex.account.deployContract(wasm);
  await call(dex.account, dex.id, "new", {
    owner_id: root.accountId, boost_farm_id: root.accountId, burrowland_id: root.accountId, exchange_fee: 0, referral_fee: 0,
  });
  return dex.id;
}

async function buildFixture(wasm: Buffer, factoryWasm?: Buffer, withRhea = false) {
  const { chain, root } = await startSandbox();
  console.log(`Chapters sandbox RPC ${chain.rpcUrl}`);
  const sale = await chain.createAccount(root, "fairground", 30);
  const usdc = await chain.createAccount(root, "usdc", 10);
  const chapters = await chain.createAccount(root, "chapters", 15);
  const sponsor = await chain.createAccount(root, "sponsor", factoryWasm ? 20 : 5);
  const mira = await chain.createAccount(root, "mira", 5);
  const sora = await chain.createAccount(root, "sora", 5);
  const voters = [await chain.createAccount(root, "alice", 5), await chain.createAccount(root, "bobby", 5), await chain.createAccount(root, "carol", 5)] as const;
  await usdc.account.deployContract(readFileSync(path.join(RES, "mock_ft.wasm")));
  await call(usdc.account, usdc.id, "new", { name: "Test USDC", symbol: "USDC", decimals: 6 });
  const dex = withRhea ? await deploySandboxRhea(chain, root) : undefined;
  const { token, poolId } = await launchSale(chain, root, sale, usdc, [...voters], !!factoryWasm, factoryWasm ? sponsor.account : root, dex);
  const rhea: RheaChain | null = dex && poolId !== null ? {
    exchange: dex, poolId, input: usdc.id, output: token, network: "sandbox", rpc: createRpc(chain.rpcUrl), rpcUrls: [chain.rpcUrl],
  } : null;
  const swapBuyer = rhea ? await chain.createAccount(root, "swap-buyer", 5) : null;
  if (swapBuyer) await call(root, usdc.id, "mint", { account_id: swapBuyer.id, amount: USDC.toString() });
  let factory: Named | undefined;
  if (factoryWasm) {
    factory = await chain.createAccount(root, "chapters-factory", 45);
    await factory.account.deployGlobalContract(wasm, "codeHash");
    await factory.account.deployContract(factoryWasm);
    await call(factory.account, factory.id, "new", { sale_contract: sale.id, chapters_code_hash: createHash("sha256").update(wasm).digest("hex") });
  } else {
    await chapters.account.deployContract(wasm);
    await call(chapters.account, chapters.id, "new", { curator: sponsor.id, token_id: token, quote_token_id: usdc.id });
    await register(root, token, chapters.id);
    await register(root, usdc.id, chapters.id);
  }
  await call(root, usdc.id, "mint", { account_id: sponsor.id, amount: (100n * USDC).toString() });
  // Mira starts unregistered on USDC so the test can prove a failed transfer is retryable.
  await register(root, usdc.id, sora.id);
  return { chain, root, sale, usdc, chapters, sponsor, mira, sora, voters, token, factory, rhea, swapBuyer };
}

type Fixture = Omit<Awaited<ReturnType<typeof buildFixture>>, "chapters"> & { chapters: Pick<Named, "id"> };

async function enableFairTest(f: Fixture, report: Report): Promise<Fixture | null> {
  const { chain, factory, root, sponsor, token, usdc, voters: [holder] } = f;
  if (!factory) throw new Error("Fair Test needs the factory artifact");
  const saleId = "fairt";
  const story = { title: "Signals after dark", brief: "Continue the winning panel." };
  const registered = () => chain.view<Registration | null>(factory.id, "get_chapters", { sale_id: saleId });
  const deposit = BigInt(await chain.view<string>(factory.id, "enable_cost"));
  const enable = (actor: Account) =>
    call<{ enabled: boolean; error: string | null }>(actor, factory.id, "enable_chapters", { sale_id: saleId, ...story }, deposit, 160);
  let escrow: string | null = null;
  const check = await report.scenario("factory", "Fair Test creator opens a keyless escrow from the published code hash", [], async (t) => {
    t.eq("registry starts empty", await registered(), null);
    t.eq("a holder cannot start the creator’s story", [(await enable(holder.account)).enabled, await registered()], [false, null]);
    t.eq("creator enables Chapters", await enable(sponsor.account), { enabled: true, error: null });
    const record = await registered();
    if (!record) throw new Error("The factory did not register the escrow");
    const deterministicId = `c${createHash("sha256").update(saleId).digest("hex").slice(0, 30)}.${factory.id}`;
    t.eq("registry binds the escrow to the settled sale and creator", record,
      { phase: "enabled", contract_id: deterministicId, curator: sponsor.id, token_id: token, quote_token_id: usdc.id, ...story });
    const keys = await chain.rpc<{ keys: unknown[] }>("query", {
      request_type: "view_access_key_list", account_id: record.contract_id, finality: "final",
    });
    t.eq("factory child has no access keys", keys.keys, []);
    t.eq("escrow initializes with the same creator and assets", await chain.view(record.contract_id, "get_config"),
      { curator: sponsor.id, token_id: token, quote_token_id: usdc.id });
    await rejected(t, "creator cannot allocate a second escrow", () => enable(sponsor.account), "already exist");
    t.eq("the first registration remains in place", await registered(), record);
    for (const asset of [token, usdc.id]) {
      t.eq(`${asset} escrow registration starts empty`, await chain.ftRegistered(asset, record.contract_id), false);
      await register(root, asset, record.contract_id);
      t.eq(`${asset} accepts the escrow registration`, await chain.ftRegistered(asset, record.contract_id), true);
    }
    escrow = record.contract_id;
  });
  return check.status === "pass" && escrow ? { ...f, chapters: { id: escrow } } : null;
}

function round(f: Fixture, id: number): Promise<Round> {
  return f.chain.view<Round>(f.chapters.id, "get_round", { round_id: id });
}

function vote(f: Fixture, id: number, voter: Named): Promise<Vote | null> {
  return f.chain.view<Vote | null>(f.chapters.id, "get_vote", { round_id: id, account_id: voter.id });
}

function votesPage(f: Fixture, id: number, from_index: number, limit: number) {
  return f.chain.view<(Vote & { account_id: string })[]>(f.chapters.id, "get_votes", { round_id: id, from_index, limit });
}

function payout(f: Fixture, id: number) {
  return f.chain.view<Payout | null>(f.chapters.id, "get_payout", { round_id: id });
}

function chapterFacts(chapter: Chapter) {
  return [chapter.title, chapter.candidates.map(({ title, artist, content_sha256 }) => [title, artist, content_sha256])];
}

async function artworkRequest(f: Fixture, roundId: number, index: number, parent: string | null) {
  const image = ART_PNGS[(roundId - 1) * 2 + index];
  const bytes = Buffer.from(image, "base64");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const deposit = BigInt(await f.chain.view<string>(f.chapters.id, "art_storage_cost", { byte_length: bytes.length }));
  return { image, digest, deposit, args: { round_id: roundId, title: `Panel ${roundId}.${index + 1}`, mime_type: "image/png", image_base64: image, parent_sha256: parent } };
}

async function submitChaptersArt(t: Checks, f: Fixture, roundId: number, title: string, parent: string | null): Promise<Chapter> {
  const [first, second] = await Promise.all([artworkRequest(f, roundId, 0, parent), artworkRequest(f, roundId, 1, parent)]);
  const args = { round_id: roundId };
  const rosterCost = BigInt(await f.chain.view<string>(f.chapters.id, "artist_roster_cost", args));
  const artists = [f.mira.id, f.sora.id];
  await call(f.sponsor.account, f.chapters.id, "set_artists", { ...args, artists }, rosterCost);
  t.eq("curator publishes the invited artist wallets", await f.chain.view(f.chapters.id, "get_artists", args), artists);
  await rejected(t, "artwork needs a curator invitation", () => call(f.voters[0].account, f.chapters.id, "submit_art", first.args, first.deposit),
    "The curator must invite this artist");
  const mira = await call<Submission>(f.mira.account, f.chapters.id, "submit_art", first.args, first.deposit);
  await rejected(t, "same artist cannot reserve a second slot", () => call(f.mira.account, f.chapters.id, "submit_art", second.args, second.deposit), "already submitted");
  const sora = await call<Submission>(f.sora.account, f.chapters.id, "submit_art", second.args, second.deposit);
  const notes = await f.chain.view<Submission[]>(f.chapters.id, "get_submissions", { round_id: roundId });
  t.eq("submissions list has both immutable artist records", notes, [mira, sora]);
  for (const [submission, request, artist] of [[mira, first, f.mira], [sora, second, f.sora]] as const) {
    const image = await f.chain.view<string>(f.chapters.id, "get_art", { round_id: roundId, submission_id: submission.submission_id });
    t.eq("published artwork has the original bytes, digest, signing artist and parent", [image, submission.content_sha256, submission.artist, submission.parent_sha256],
      [request.image, request.digest, artist.id, parent]);
  }
  const candidate = ({ title, artist, content_sha256 }: Submission): Candidate => ({ title, artist, content_sha256 });
  return { title, candidates: [candidate(mira), candidate(sora)], submission_ids: [mira.submission_id, sora.submission_id] };
}

async function createRound(f: Fixture, chapter: Chapter, quorum: bigint, fundingSeconds = 20n, phaseSeconds = 60n): Promise<Round> {
  const start = await f.chain.nowNs() + fundingSeconds * SECOND;
  const commitEnd = start + phaseSeconds * SECOND;
  const revealEnd = commitEnd + phaseSeconds * SECOND;
  const slots = 8;
  const storage = BigInt(await f.chain.view<string>(f.chapters.id, "storage_cost", { max_voters: slots }));
  const id = await call<number>(f.sponsor.account, f.chapters.id, "create_round", {
    ...chapter,
    sponsor: f.sponsor.id,
    bounty: BOUNTY.toString(),
    quorum: quorum.toString(),
    max_voters: slots,
    starts_at: start.toString(),
    commit_end: commitEnd.toString(),
    reveal_end: revealEnd.toString(),
  }, storage);
  return round(f, id);
}

function fund(f: Fixture, id: number) {
  return transferCall(f.sponsor.account, f.usdc.id, f.chapters.id, BOUNTY, { kind: "fund", round_id: id });
}

type Ballot = { voter: Named; candidate: 0 | 1; amount: bigint; salt: string };

function ballot(voter: Named, candidate: 0 | 1, amount: bigint): Ballot {
  return { voter, candidate, amount, salt: randomBytes(32).toString("hex") };
}

function voteHash(f: Fixture, id: number, b: Ballot) {
  return createHash("sha256").update(`sealround-chapter-v1|${f.chapters.id}|${id}|${b.voter.id}|${b.candidate}|${b.salt}`).digest("hex");
}

function commit(f: Fixture, id: number, b: Ballot, token = f.token) {
  return transferCall(b.voter.account, token, f.chapters.id, b.amount, { kind: "commit", round_id: id, commitment: voteHash(f, id, b) });
}

function reveal(f: Fixture, id: number, b: Ballot) {
  return call(b.voter.account, f.chapters.id, "reveal", { round_id: id, candidate_index: b.candidate, salt: b.salt });
}

function finalize(f: Fixture, id: number) {
  return call<Round>(f.root, f.chapters.id, "finalize", { round_id: id });
}

function withdraw(f: Fixture, id: number, voter: Named) {
  return call<boolean>(voter.account, f.chapters.id, "withdraw_vote", { round_id: id }, 1n, 70);
}

function claim(f: Fixture, id: number, beneficiary: Named) {
  return call<boolean>(beneficiary.account, f.chapters.id, "claim_bounty", { round_id: id }, 1n, 70);
}

async function claimWithHash(f: Fixture, id: number, beneficiary: Named) {
  const result = await beneficiary.account.signAndSendTransaction({
    receiverId: f.chapters.id,
    actions: [actions.functionCall("claim_bounty", { round_id: id }, teraToGas(100), 1n)],
    waitUntil: "FINAL", throwOnFailure: false,
  });
  return result.transaction.hash;
}

async function startRound(f: Fixture, chapter: Chapter, quorum: bigint, beforeFund?: (r: Round) => Promise<void>) {
  const r = await createRound(f, chapter, quorum);
  await beforeFund?.(r);
  await fund(f, r.round_id);
  await f.chain.advanceTo(BigInt(r.starts_at));
  return r;
}

async function exercise(report: Report, f: Fixture, chapters: [Chapter, Chapter], wasm: Buffer) {
  const { chain, token, usdc, sponsor, mira, sora, voters: [alice, bobby, carol] } = f;
  const tokenBalance = (actor: Pick<Named, "id">) => chain.ft(token, actor.id);
  const quoteBalance = (actor: Pick<Named, "id">) => chain.ft(usdc.id, actor.id);
  const initial = await Promise.all(f.voters.map(tokenBalance));
  const supply = await chain.ftSupply(token);
  await call(f.root, usdc.id, "mint", { account_id: bobby.id, amount: BOUNTY.toString() });
  const quoteSupply = await chain.ftSupply(usdc.id);
  const sandbox = { contract: f.chapters.id, token, quote: usdc.id, rpcUrl: chain.rpcUrl, rpc: createRpc(chain.rpcUrl) };
  const rhea = f.rhea;
  let acquired = 0n;
  const swapBuyer = f.swapBuyer;

  if (rhea && swapBuyer) await report.scenario("rhea", "Fair Test purchase via the pinned Rhea exchange", ["factory"], async (t) => {
    const buyer = swapBuyer;
    await register(f.root, token, buyer.id);
    const amount = 100_000n;
    const quote = await quoteRhea(rhea, amount);
    t.ok("Rhea returns a positive single-pool quote", quote.minimum > 0n && quote.minimum <= quote.estimate);
    const inputBalance = await quoteBalance(buyer);
    const outputBalance = await tokenBalance(buyer);
    const swap = async (reviewed: RheaQuote) => {
      const { receiverId, methodName, args, gas, deposit } = rheaSwapAction(rhea, reviewed);
      const raw = await buyer.account.signAndSendTransaction({ receiverId, actions: [actions.functionCall(methodName, args, gas, deposit)], waitUntil: "FINAL", throwOnFailure: false });
      return checkRheaSwap(rhea, raw.transaction.hash, buyer.id, reviewed);
    };
    const stale = await swap({ ...quote, minimum: quote.estimate + 1n });
    t.eq("an unattainable minimum produced a confirmed full refund", stale.status, "refunded");
    t.eq("the refunded buy left both wallet balances unchanged", [await quoteBalance(buyer), await tokenBalance(buyer)], [inputBalance, outputBalance]);
    const paid = await swap(await quoteRhea(rhea, amount));
    t.ok("the finalized receipt proves sale tokens reached the buyer", paid.status === "bought", paid.status);
    if (paid.status !== "bought") throw new Error(`Rhea receipt outcome was ${paid.status}`);
    acquired = paid.amount;
    t.eq("payment and actual output match the queried wallet balances", [await quoteBalance(buyer), await tokenBalance(buyer)], [inputBalance - amount, outputBalance + acquired]);
  });

  await report.scenario("one", "The first light: two sealed choices and an independent artist payout", rhea ? ["rhea"] : [], async (t) => {
    t.eq("holders claimed their tokens from the sale", initial, [1_000n * TOKEN, 1_000n * TOKEN, 1_000n * TOKEN]);
    const a = ballot(alice, 0, 75n * TOKEN);
    const b = ballot(bobby, 1, 25n * TOKEN);
    const c = ballot(carol, 1, initial[2]);
    const sponsorStart = await quoteBalance(sponsor);
    const chapter = await submitChaptersArt(t, f, 1, chapters[0].title, null);
    await rejected(t, "curator cannot bypass open submissions with bundled art", () => createRound(f, chapters[0], 100n * TOKEN),
      f.factory ? "Choose two signed artist submissions" : "Choose from the submitted artwork");
    const r = await startRound(f, chapter, 100n * TOKEN, async (created) => {
      // The wrong sponsor must fail even when it has the exact bounty amount.
      const wrongSponsorStart = await quoteBalance(bobby);
      await transferCall(bobby.account, usdc.id, f.chapters.id, BOUNTY, { kind: "fund", round_id: created.round_id });
      t.eq("wrong sponsor was fully refunded", await quoteBalance(bobby), wrongSponsorStart);
      const sponsorBalance = await quoteBalance(sponsor);
      await transferCall(sponsor.account, usdc.id, f.chapters.id, BOUNTY - 1n, { kind: "fund", round_id: created.round_id });
      t.eq("the correct sponsor cannot partly fund the bounty", await quoteBalance(sponsor), sponsorBalance);
      await transferCall(alice.account, token, f.chapters.id, BOUNTY, { kind: "fund", round_id: created.round_id });
      t.eq("using Lantern to fund the USDC bounty returns Lantern", await tokenBalance(alice), initial[0]);
      t.eq("rejected transfers did not fund the round", (await round(f, created.round_id)).funded, false);
    });
    const id = r.round_id;
    t.eq("first round pins both selected submissions, hashes and artists", [id, chapterFacts(r), r.submission_ids, r.parent_sha256], [1, chapterFacts(chapter), chapter.submission_ids, null]);
    t.eq("sponsor funded exactly the bounty", await quoteBalance(sponsor), sponsorStart - BOUNTY);
    const wrongTokenStart = await quoteBalance(alice);
    await commit(f, id, { ...a, amount: 1n }, usdc.id);
    t.eq("USDC cannot become voting weight", [await quoteBalance(alice), await vote(f, id, alice)], [wrongTokenStart, null]);
    await commit(f, id, { ...a, amount: (100n * TOKEN / 8n) - 1n });
    t.eq("below-minimum lock returns the full token transfer and reserves no slot", [await tokenBalance(alice), await vote(f, id, alice)], [initial[0], null]);
    for (const ballot of [a, b, c]) await commit(f, id, ballot);
    if (swapBuyer) {
      const boughtVote = ballot(swapBuyer, 0, acquired);
      await commit(f, id, boughtVote);
      t.eq("the buyer can lock exactly the tokens delivered by Rhea", [(await vote(f, id, swapBuyer))?.amount, await tokenBalance(swapBuyer)], [acquired.toString(), 0n]);
    }
    const aBalance = await tokenBalance(alice);
    await commit(f, id, a);
    t.eq("duplicate commit was refunded", [await tokenBalance(alice), (await vote(f, id, alice))?.amount], [aBalance, a.amount.toString()]);
    t.eq("commit exposes weight and the domain-bound hash only", await vote(f, id, alice), {
      amount: a.amount.toString(), commitment: voteHash(f, id, a), revealed_choice: null, withdrawal_state: "unclaimed",
    });
    t.eq("the escrow holds every ballot amount exactly once", await tokenBalance(f.chapters), a.amount + b.amount + c.amount + acquired);
    t.eq("the tally stays empty through voting", (await round(f, id)).tallies, ["0", "0"]);
    await rejected(t, "lock withdrawal before finalization is refused", () => withdraw(f, id, alice), "Finalize the round first");
    t.eq("the original lock remains claimable", (await vote(f, id, alice))?.withdrawal_state, "unclaimed");
    await rejected(t, "early reveal rejected", () => reveal(f, id, a), "Reveal window is closed");
    await rejected(t, "early finalize rejected", () => finalize(f, id), "Round cannot finalize yet");
    await chain.advanceTo(BigInt(r.commit_end));
    await rejected(t, "wrong salt rejected", () => reveal(f, id, { ...a, salt: randomBytes(32).toString("hex") }), "do not match");
    await rejected(t, "wrong candidate rejected", () => reveal(f, id, { ...a, candidate: 1 }), "do not match");
    await reveal(f, id, a);
    await reveal(f, id, b);
    await rejected(t, "duplicate reveal rejected", () => reveal(f, id, a), "Vote already revealed");
    await chain.advanceTo(BigInt(r.reveal_end));
    const result = await finalize(f, id);
    t.eq("Mira wins at quorum despite Carol's unrevealed lock", [result.outcome, result.winner, result.revealed, result.tallies], ["winner", 0, (100n * TOKEN).toString(), [(75n * TOKEN).toString(), (25n * TOKEN).toString()]]);
    const publicVotes = [...await votesPage(f, id, 0, 2), ...await votesPage(f, id, 2, 2)];
    t.eq("public pages retain unique commit order and no salt", publicVotes.map((v) => [v.account_id, v.revealed_choice, Object.hasOwn(v, "salt")]),
      [[alice.id, 0, false], [bobby.id, 1, false], [carol.id, null, false], ...(swapBuyer ? [[swapBuyer.id, null, false]] : [])]);
    t.eq("tally reconstructed from public vote weights", [0, 1].map((choice) => publicVotes.filter((v) => v.revealed_choice === choice)
      .reduce((sum, v) => sum + BigInt(v.amount), 0n).toString()), result.tallies);
    t.eq("repeat finalize preserves the winner", (await finalize(f, id)).winner, 0);
    await rejected(t, "the losing artist cannot take the bounty", () => claim(f, id, sora), "No bounty or refund due");
    const failedHash = await claimWithHash(f, id, mira);
    t.eq("failed transfer left the bounty available and funded", [(await round(f, id)).bounty_state, await quoteBalance(f.chapters)], ["unclaimed", BOUNTY]);
    const unpaid = await payout(f, id);
    t.eq("failed transfer leaves no confirmation timestamp", [unpaid?.state, unpaid?.paid_at], ["unclaimed", null]);
    await register(f.root, usdc.id, mira.id);
    const firstHash = await claimWithHash(f, id, mira);
    t.eq("Mira gets exactly one bounty", await quoteBalance(mira), BOUNTY);
    const paid = await payout(f, id);
    t.eq("callback records actual paid beneficiary, asset, amount and successful attempt", [paid?.recipient, paid?.token_id, paid?.amount, paid?.state, paid?.attempt], [mira.id, usdc.id, BOUNTY.toString(), "paid", 2]);
    if (!paid) throw new Error("Missing payout after the successful retry");
    const proof = await verifyPayoutReceipt(sandbox, id, paid, firstHash);
    t.ok("public verifier finds the successful retry's token receipt and callback", proof.check.status === "passed" && Boolean(proof.evidence?.transferReceiptId), proof.check.message);
    t.eq("public verifier rejects the first, failed claim", (await verifyPayoutReceipt(sandbox, id, paid, failedHash)).check.status, "failed");
    t.ok("confirmed timestamp follows the reveal deadline", paid?.paid_at != null && BigInt(paid.paid_at) >= BigInt(r.reveal_end));
    await rejected(t, "a paid bounty cannot be claimed again", () => claim(f, id, mira), "already");
    await call(carol.account, token, "storage_unregister", { force: false }, 1n);
    t.eq("a token account can unregister while its entire balance is locked", await chain.ftRegistered(token, carol.id), false);
    t.eq("withdrawing to an unregistered holder fails safely", await withdraw(f, id, carol), false);
    t.eq("failed withdrawal leaves the same full lock claimable", [(await vote(f, id, carol))?.withdrawal_state, await tokenBalance(carol)], ["unclaimed", 0n]);
    await register(f.root, token, carol.id);
    t.eq("holder can retry withdrawal after registration", await withdraw(f, id, carol), true);
    for (const voter of [alice, bobby]) await withdraw(f, id, voter);
    if (swapBuyer) {
      await withdraw(f, id, swapBuyer);
      t.eq("the buyer's full acquired amount is withdrawable after voting", await tokenBalance(swapBuyer), acquired);
    }
    t.eq("all holder principal returned, even without a reveal", await Promise.all(f.voters.map(tokenBalance)), initial);
    t.eq("round one left neither token nor quote balance in escrow", [await tokenBalance(f.chapters), await quoteBalance(f.chapters)], [0n, 0n]);
  });

  await report.scenario("two", "Lights across the harbor: same holders return and the other artist wins", ["one"], async (t) => {
    const first = await round(f, 1);
    const parent = first.candidates[0].content_sha256;
    const unrelated = await artworkRequest(f, 2, 0, first.candidates[1].content_sha256);
    await rejected(t, "chapter two rejects art referencing the losing panel",
      () => call(mira.account, f.chapters.id, "submit_art", unrelated.args, unrelated.deposit), "previous winner");
    await rejected(t, "chapter two after uploaded art requires artist continuations", () => createRound(f, chapters[1], 100n * TOKEN),
      f.factory ? "Choose two signed artist submissions" : "Continue the story with submitted artwork");
    const chapter = await submitChaptersArt(t, f, 2, chapters[1].title, parent);
    const r = await startRound(f, chapter, 100n * TOKEN);
    const id = r.round_id;
    t.eq("round two pins the new art and the first winning hash", [id, chapterFacts(r), r.submission_ids, r.parent_sha256], [2, chapterFacts(chapter), chapter.submission_ids, parent]);
    const a = ballot(alice, 0, 25n * TOKEN);
    const b = ballot(bobby, 1, 100n * TOKEN);
    await commit(f, id, a);
    await commit(f, id, b);
    await chain.advanceTo(BigInt(r.commit_end));
    await reveal(f, id, a);
    await reveal(f, id, b);
    await chain.advanceTo(BigInt(r.reveal_end));
    const result = await finalize(f, id);
    t.eq("Sora wins chapter two independently of chapter one", [result.outcome, result.winner, (await round(f, 1)).winner], ["winner", 1, 0]);
    const secondHash = await claimWithHash(f, id, sora);
    const paid = await payout(f, id);
    if (!paid) throw new Error("Missing chapter two payout record");
    const proof = await verifyPayoutReceipt(sandbox, id, paid, secondHash);
    t.ok("public verifier finds the second artist's payout receipt", proof.check.status === "passed", proof.check.message);
    const wrongRound = await verifyPayoutReceipt(sandbox, 1, paid, secondHash);
    t.eq("public verifier rejects a valid claim from a different chapter", wrongRound.check.status, "failed");
    t.eq("each artist got its own round bounty", [await quoteBalance(mira), await quoteBalance(sora)], [BOUNTY, BOUNTY]);
    await withdraw(f, id, alice);
    await withdraw(f, id, bobby);
    await rejected(t, "a returned vote cannot be withdrawn again", () => withdraw(f, id, alice), "already");
    t.eq("the same holders recovered their full balances again", await Promise.all(f.voters.map(tokenBalance)), initial);
    t.eq("round two left neither asset in escrow", [await tokenBalance(f.chapters), await quoteBalance(f.chapters)], [0n, 0n]);
  });

  await report.scenario("refund", "No quorum and a tie both preserve principal and refund the sponsor", ["two"], async (t) => {
    const refundContract = await chain.createAccount(f.root, "refund-chapters", 5);
    await refundContract.account.deployContract(wasm);
    await call(refundContract.account, refundContract.id, "new", { curator: sponsor.id, token_id: token, quote_token_id: usdc.id });
    await register(f.root, token, refundContract.id);
    await register(f.root, usdc.id, refundContract.id);
    const refunds = { ...f, chapters: refundContract };
    for (const kind of ["no_quorum", "tie"] as const) {
      const sponsorStart = await quoteBalance(sponsor);
      const r = await startRound(refunds, { ...chapters[1], title: `Refund fixture: ${kind}` }, 100n * TOKEN);
      const id = r.round_id;
      const a = ballot(alice, 0, 50n * TOKEN);
      const b = ballot(bobby, 1, 50n * TOKEN);
      await commit(refunds, id, a);
      await commit(refunds, id, b);
      await chain.advanceTo(BigInt(r.commit_end));
      await reveal(refunds, id, a);
      if (kind === "tie") await reveal(refunds, id, b);
      await chain.advanceTo(BigInt(r.reveal_end));
      const result = await finalize(refunds, id);
      t.eq(`${kind}: no artist declared`, [result.outcome, result.winner], [kind, null]);
      const refundHash = await claimWithHash(refunds, id, sponsor);
      t.eq(`${kind}: sponsor receives the full bounty back`, await quoteBalance(sponsor), sponsorStart);
      const paid = await payout(refunds, id);
      if (!paid) throw new Error("Missing sponsor refund record");
      const proof = await verifyPayoutReceipt({ ...sandbox, contract: refundContract.id }, id, paid, refundHash);
      t.ok(`${kind}: the actual sponsor refund receipt verifies`, proof.check.status === "passed", proof.check.message);
      await withdraw(refunds, id, alice);
      await withdraw(refunds, id, bobby);
      t.eq(`${kind}: no locks lost`, await Promise.all(f.voters.map(tokenBalance)), initial);
    }
    const r = await createRound(refunds, { ...chapters[1], title: "Unfunded fixture" }, 100n * TOKEN);
    await chain.advanceTo(BigInt(r.starts_at));
    await commit(refunds, r.round_id, ballot(alice, 0, TOKEN));
    t.eq("unfunded round returns attempted lock", await tokenBalance(alice), initial[0]);
    t.eq("unfunded round finalizes without a winner", (await finalize(refunds, r.round_id)).outcome, "unfunded");
    t.eq("rounds preserve supply and leave nothing in escrow", [await chain.ftSupply(token), await chain.ftSupply(usdc.id), await tokenBalance(refundContract), await quoteBalance(refundContract)], [supply, quoteSupply, 0n, 0n]);
  });
}

async function serve(f: Fixture, chapters: [Chapter, Chapter], creator: boolean) {
  if (creator) {
    await register(f.root, f.usdc.id, f.mira.id);
  } else {
    // Seed the first completed chapter, then leave the second open for wallet testing.
    const first = await startRound(f, chapters[0], 100n * TOKEN);
    const a = ballot(f.voters[0], 0, 100n * TOKEN);
    await commit(f, first.round_id, a);
    await f.chain.advanceTo(BigInt(first.commit_end));
    await reveal(f, first.round_id, a);
    await f.chain.advanceTo(BigInt(first.reveal_end));
    await finalize(f, first.round_id);
    await register(f.root, f.usdc.id, f.mira.id);
    await claim(f, first.round_id, f.mira);
    await withdraw(f, first.round_id, a.voter);

    const second = await createRound(f, chapters[1], 100n * TOKEN, 30n, 300n);
    await fund(f, second.round_id);
    await f.chain.advanceTo(BigInt(second.starts_at));
  }
  const envPath = path.join(RUN_DIR, "sandbox.env");
  const publicEnv = {
    NEXT_PUBLIC_FAIRGROUND_CONTRACT: f.sale.id,
    NEXT_PUBLIC_NEAR_NETWORK: "sandbox",
    NEXT_PUBLIC_NEAR_RPC_URL: f.chain.rpcUrl,
    NEXT_PUBLIC_NEAR_RPC_FALLBACKS: "",
    NEXT_PUBLIC_USDC_CONTRACT: f.usdc.id,
    NEXT_PUBLIC_RELAYER_URL: "",
    NEXT_PUBLIC_APP_URL: "",
    NEXT_PUBLIC_CHAPTERS_CONTRACT: f.factory ? "" : f.chapters.id,
    NEXT_PUBLIC_CHAPTERS_FACTORY: f.factory?.id ?? "",
    NEXT_PUBLIC_DEV_ACCOUNTS: (creator ? [f.sponsor, ...f.voters, f.mira, f.sora, ...(f.swapBuyer ? [f.swapBuyer] : [])] : [...f.voters, f.mira, f.sora, f.sponsor])
      .map(({ id, secret }) => `${id}=${secret}`).join(","),
  };
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(envPath, Object.entries(publicEnv).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  console.log(`Local browser fixture is ready. Read ${envPath} into a sandbox-only dev process.`);
  if (f.factory) console.log("Fair Test is settled. Connect the sale creator, sponsor.test.near, to enable chapters.");
  else if (creator) console.log("Lantern has no chapters yet. Connect the sandbox sponsor to create and fund the first round.");
  else {
    const second = await round(f, 2);
    console.log(`Lantern round ${second.round_id}: commit ends ${second.commit_end}, reveal ends ${second.reveal_end} (chain nanoseconds).`);
  }
  console.log(`Stop this fixture with Ctrl+C when finished. Container ${CONTAINER}`);
  await new Promise<void>((resolve) => {
    const keepAlive = setInterval(() => {}, 60_000);
    const stop = () => {
      clearInterval(keepAlive);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function main() {
  const { values } = parseArgs({ options: { wasm: { type: "string" }, serve: { type: "boolean" }, creator: { type: "boolean" }, "fair-test": { type: "boolean" }, rhea: { type: "boolean" } } });
  if (values.creator && !values.serve) throw new Error("Use --creator with --serve.");
  if (values.rhea && !values["fair-test"]) throw new Error("Use --rhea with --fair-test.");
  const artifact = values.wasm ? path.resolve(REPO_DIR, values.wasm) : path.join(REPO_DIR, "target", "near", "sealround_chapters", "sealround_chapters.wasm");
  const wasm = readFileSync(artifact);
  if (wasm.subarray(0, 4).toString("hex") !== "0061736d") throw new Error(`Not a Wasm artifact: ${artifact}`);
  const chapters = loadChapters();
  let cleanup = false;
  try {
    // The name is unique to this process, so cleanup can only remove our own sandbox.
    cleanup = true;
    const factoryWasm = values["fair-test"] ? readFileSync(path.join(REPO_DIR, "target", "near", "sealround_chapters_factory", "sealround_chapters_factory.wasm")) : undefined;
    const fixture = await buildFixture(wasm, factoryWasm, values.rhea === true);
    if (values.serve) {
      await serve(fixture, chapters, values.creator === true || values["fair-test"] === true);
    } else {
      const report = new Report();
      const escrow = values["fair-test"] ? await enableFairTest(fixture, report) : fixture;
      if (escrow) await exercise(report, escrow, chapters, wasm);
      console.log(`\n${report.table()}`);
      if (!report.allPassed) process.exitCode = 1;
    }
  } finally {
    if (cleanup) {
      const status = spawnSync("docker", ["rm", "-f", CONTAINER], { encoding: "utf8", windowsHide: true });
      if (status.status !== 0 && !status.stderr?.includes("No such container")) {
        console.error(`Could not remove the chapters sandbox ${CONTAINER}`);
        process.exitCode = 1;
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
