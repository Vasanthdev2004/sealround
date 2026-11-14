/**
 * Reads what the contract and rule checks (verify/checks.ts) need, read-only:
 * the sale's views (get_sale, get_result, get_bids and get_fills, paged), the
 * contract account's code hash, the access keys of the contract and of the
 * sale's token, and the launch pool on the exchange. Then runs the checks.
 * Nothing is signed or sent. A read that fails leaves its checks "not run".
 */

import type { SealerAnswer } from "../near/attestation";
import type { BidView, FillView, RefPoolView, ResultView, SaleView } from "../near/views";
import {
  checkApplied,
  checkContractCode,
  checkLengths,
  checkNoKeys,
  checkPool,
  checkRules,
  notRun,
  parseClearOutput,
  type PoolRead,
} from "./checks";
import { factsFromViews, type SaleFacts } from "./facts";
import { accessKeys, viewAccount, viewCall, type AccessKeyView, type JsonRpc } from "./rpc";
import type { ChainCheck, ChainVerification } from "./types";
import { checkYourBid, type BidTerms } from "./your-bid";

/** get_bids and get_fills page size (the contract allows up to 200). */
const PAGE = 100;

export type ChainRead = {
  facts: SaleFacts | null;
  factsError?: string;
  codeHash: string | null;
  codeError?: string;
  contractKeys: AccessKeyView[] | null;
  tokenAccount: string;
  tokenKeys: AccessKeyView[] | null;
  pool: PoolRead | null;
  poolError?: string;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function paged<T>(count: number, page: (from: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < count; from += PAGE) out.push(...(await page(from)));
  return out;
}

/** The sale as the views print it, in one shape. Views already read can be passed in. */
export async function readSaleFacts(
  rpc: JsonRpc,
  contractId: string,
  saleId: string,
  pre: { sale?: SaleView | null; result?: ResultView | null } = {},
): Promise<SaleFacts> {
  const [sale, result] = await Promise.all([
    pre.sale !== undefined ? pre.sale : viewCall<SaleView | null>(rpc, contractId, "get_sale", { sale_id: saleId }),
    pre.result !== undefined ? pre.result : viewCall<ResultView | null>(rpc, contractId, "get_result", { sale_id: saleId }),
  ]);
  if (!sale) throw new Error(`There is no sale ${saleId} on ${contractId}.`);
  const final = sale.status === "settled" || sale.status === "failed";
  const [bids, fills] = await Promise.all([
    paged(sale.bid_count, (from) => viewCall<BidView[]>(rpc, contractId, "get_bids", { sale_id: saleId, from_index: from, limit: PAGE })),
    final
      ? paged(sale.bid_count, (from) => viewCall<FillView[]>(rpc, contractId, "get_fills", { sale_id: saleId, from_index: from, limit: PAGE }))
      : Promise.resolve([] as FillView[]),
  ]);
  return factsFromViews(contractId, sale, result, bids, fills);
}

/** Every read the checks need. Failures are kept as messages, never thrown. */
export async function readChain(
  rpc: JsonRpc,
  contractId: string,
  saleId: string,
  pre: { sale?: SaleView | null; result?: ResultView | null } = {},
): Promise<ChainRead> {
  const [facts, account, keys] = await Promise.all([
    readSaleFacts(rpc, contractId, saleId, pre).then(
      (f) => ({ f, e: undefined }),
      (e: unknown) => ({ f: null, e: message(e) }),
    ),
    viewAccount(rpc, contractId).then(
      (a) => ({ a, e: undefined }),
      (e: unknown) => ({ a: null, e: message(e) }),
    ),
    accessKeys(rpc, contractId).then(
      (r) => r.keys,
      () => null,
    ),
  ]);
  const f = facts.f;
  const tokenAccount = f?.token ?? `${saleId}.${contractId}`;
  const l = f?.liquidity;
  const wantsPool = !!f && f.status !== "not_final" && l?.status === "seeded" && l.poolId !== null;
  const [tokenKeys, pool] = await Promise.all([
    accessKeys(rpc, tokenAccount).then(
      (r) => r.keys,
      () => null,
    ),
    wantsPool
      ? Promise.all([
          viewCall<RefPoolView | null>(rpc, l!.dex, "get_pool", { pool_id: l!.poolId }),
          viewCall<string>(rpc, l!.dex, "get_pool_shares", { pool_id: l!.poolId, account_id: contractId }),
        ]).then(
          ([p, shares]) =>
            p
              ? {
                  pool: {
                    tokenIds: p.token_account_ids,
                    amounts: p.amounts.map((a) => BigInt(a)),
                    sharesTotal: BigInt(p.shares_total_supply),
                    contractShares: BigInt(shares ?? "0"),
                  } satisfies PoolRead,
                  e: undefined,
                }
              : { pool: null, e: "the exchange does not list this pool" },
          (e: unknown) => ({ pool: null, e: message(e) }),
        )
      : Promise.resolve({ pool: null, e: undefined }),
  ]);
  return {
    facts: f,
    ...(facts.e ? { factsError: facts.e } : {}),
    codeHash: account.a?.code_hash ?? null,
    ...(account.e ? { codeError: account.e } : {}),
    contractKeys: keys,
    tokenAccount,
    tokenKeys,
    pool: pool.pool,
    ...(pool.e ? { poolError: pool.e } : {}),
  };
}

export type ChainContext = {
  contractId: string;
  /** sha256 hex of the contract build the app pins (contracts/res/fairground.wasm). */
  pinnedContract: string;
  /** The clearing run's answer, and the size and sha256 of the bytes it came in, when its transaction was found and read. */
  clear?: { answer: SealerAnswer | null; bytes: number; sha256: string } | null;
  /** A bidder's own terms (verify-sale --bid-secret): adds a your_bid check per bidder. */
  terms?: readonly BidTerms[];
};

/** The checks over what readChain read. Pure. */
export function chainChecks(read: ChainRead, c: ChainContext): ChainVerification {
  const f = read.facts;
  const why = `Could not read the sale's views: ${read.factsError ?? "unknown error"}`;
  const checks: ChainCheck[] = [
    read.codeHash === null && read.codeError
      ? notRun("contract_code", `Could not read ${c.contractId}: ${read.codeError}`)
      : checkContractCode(c.contractId, read.codeHash, c.pinnedContract),
    checkNoKeys("contract_keys", c.contractId, read.contractKeys),
    checkNoKeys("token_keys", read.tokenAccount, read.tokenKeys),
  ];
  if (!f) {
    checks.push(notRun("applied", why), notRun("rules", why), notRun("lengths", why), notRun("pool", why));
  } else {
    checks.push(
      checkApplied(c.clear ? parseClearOutput(c.clear.answer) : null, f, c.clear ? { bytes: c.clear.bytes, sha256: c.clear.sha256 } : null),
      checkRules(f),
      checkLengths(f),
      checkPool(f, read.pool, read.poolError),
    );
    for (const t of c.terms ?? []) checks.push(checkYourBid(t, f));
  }
  return { simulated: false, checks };
}
