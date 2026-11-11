/**
 * The live bot's results as text for a terminal (or a video). `--json` prints
 * the same results as JSON instead (run.ts).
 */
import { duration, fmt, ratio, type CopycatResult, type FillRow, type ReportResult, type RevealResult, type SnipeResult, type StatusResult } from "./bot";

function table(rows: string[][], indent = "  "): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => `${indent}${r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join("  ")}`.trimEnd());
}

const tx = (hash: string | null, paidBy: string | null) => `${hash ?? "(no hash)"}${paidBy === "relayer" ? " (gasless: signed and paid by the relayer)" : paidBy === "user" ? " (signed and paid by the bot)" : ""}`;

export function renderStatus(r: StatusResult): string {
  const q = (v: string) => `${fmt(BigInt(v), r.quote.decimals)} ${r.quote.symbol}`;
  const when = (ms: number, word: string) => (ms > 0 ? `${word} in ${duration(ms)}` : `${word} ${duration(-ms)} ago`);
  const hash = r.sale.repoSealerHash === null ? "(no repo pin to compare)" : r.sale.sealerCodeHash === r.sale.repoSealerHash ? "= this repo's pinned build" : `differs from this repo's pin ${r.sale.repoSealerHash}`;
  const lines = [
    `Sealround live bot: status of sale ${r.sale.id} on ${r.network} (chain "${r.chainId}", contract ${r.contract})`,
    ...table([
      ["status", `${r.sale.status} (${r.sale.mode === "tee" ? "sealed bids, cleared in the enclave" : "commit-reveal, cleared on chain"})`],
      ["bid window", `${when(r.sale.opensInMs, "opens")}, ${when(r.sale.closesInMs, "closes")} (chain clock)`],
      ["floor / ceiling", `${q(r.sale.floorPrice)} / ${r.sale.maxPrice === null ? "none" : q(r.sale.maxPrice)} per token`],
      ["deposit range", `${q(r.sale.minDeposit)} to ${q(r.sale.maxDepositPerAccount)}`],
      ["bids", `${r.sale.bidCount} of ${r.sale.maxBids}, ${q(r.sale.totalDeposits)} deposited`],
      ["sealer code hash", `${r.sale.sealerCodeHash} ${hash}`],
      ["sale key", r.sale.sealerPubkey ?? "(none yet)"],
      ["quote token", `${r.quote.id} (${r.quote.symbol}, ${r.quote.decimals} decimals)`],
    ]),
  ];
  if (r.account) {
    lines.push(
      `account ${r.account.id}: ${fmt(BigInt(r.account.near), 24)} NEAR, ${q(r.account.usdc)}`,
      r.account.bid ? `  has bid #${r.account.bid.index}: ${q(r.account.bid.deposit)}${r.account.bid.claimed ? ", claimed" : ""}` : "  no bid in this sale",
    );
  }
  if (r.relayer) lines.push(`relayer ${r.relayer.url}: ${r.relayer.account ? `account ${r.relayer.account}, pays for ${r.relayer.methods.join(", ")} and bids` : "did not answer"}`);
  return lines.join("\n");
}

export function renderSnipe(r: SnipeResult): string {
  const q = (v: string) => `${fmt(BigInt(v), r.quote.decimals)} ${r.quote.symbol}`;
  const blocks = r.bidBlock !== null ? `block ${r.bidBlock}, ${r.bidBlock - r.openBlock} block(s) after the first open block the bot saw (${r.openBlock})` : `first open block seen: ${r.openBlock}`;
  return [
    `SNIPED: ${r.bidder} bid in sale ${r.saleId} on ${r.network}`,
    ...table([
      ["transaction", tx(r.txHash, r.paidBy)],
      ["landed", `second ${r.landedInSecond} of the sale: ${(r.landedAfterMs / 1000).toFixed(3)} s after bid_start (chain clock), ${blocks}`],
      ["position", `bid #${r.index}${r.index === 0 ? " (the first bid of the sale)" : ` (${r.index} bid(s) were in before it)`}`],
      ["terms", `deposit ${q(r.deposit)}, max price ${q(r.maxPrice)} per token, max spend ${q(r.maxSpend)} (${r.mode === "tee" ? `sealed, ${r.sealedBytes} bytes` : "committed"})`],
      ["sends", `${r.attempts}${r.fallbackReason ? `, paid by the bot because ${r.fallbackReason}` : ""}${r.startedLateByMs > 0 ? `; the sale was already open for ${duration(r.startedLateByMs)} when the bot started` : `; waited ${duration(r.waitedMs)} for the open`}`],
      ["receipt", r.receiptFile],
    ]),
    "",
    r.mode === "tee"
      ? "Nobody can read the bid until the sale closes and the enclave opens every bid at once; the bot then pays the clearing price like everyone else (`report`)."
      : "Reveal the bid after the close with `reveal`; the salt is in the receipt.",
  ].join("\n");
}

export function renderCopycat(r: CopycatResult): string {
  const q = (v: string) => `${fmt(BigInt(v), r.quote.decimals)} ${r.quote.symbol}`;
  const head =
    r.outcome === "rejected_on_chain"
      ? `COPYCAT REJECTED: the contract refused ${r.bidder}'s replay of ${r.victim}'s sealed bid (${r.reason})`
      : r.outcome === "accepted_void_at_clearing"
        ? `COPYCAT VOID: the contract took ${r.bidder}'s replay of ${r.victim}'s sealed bid, and the enclave will reject it at clearing`
        : `COPYCAT VOID: the contract took ${r.bidder}'s copy of ${r.victim}'s commitment, which it can never reveal`;
  const rows: string[][] = [
    ["copied", `bid #${r.victimIndex} of ${r.victim} (${r.payloadBytes} bytes, deposit ${q(r.victimDeposit)})`],
    ["size check", r.expectedBytes === null ? "(commitments have one size)" : `a sealed bid from ${r.bidder} must be ${r.expectedBytes} bytes; the copy is ${r.payloadBytes}`],
  ];
  if (r.appRefusal) rows.push(["the app", `refused before signing: ${r.appRefusal}`]);
  if (r.relayerRefusal) rows.push(["the relayer", `refused to pay: ${r.relayerRefusal}`]);
  rows.push(["transaction", tx(r.txHash, r.paidBy)]);
  if (r.outcome === "rejected_on_chain") {
    rows.push(["the contract", `bid_rejected, reason ${r.reason}: no bid recorded for ${r.bidder}`]);
    rows.push(["deposit", `${q(r.deposit)} came back in full (${q(r.usdcBefore!)} before, ${q(r.usdcAfter!)} after)`]);
  } else {
    rows.push(["on chain", r.mode === "tee" ? `accepted at bid #${r.index}: the contract cannot read a sealed bid, only check its size` : `accepted at bid #${r.index}: a commitment is a hash, the contract cannot tell whose terms it hides`]);
    rows.push(["at clearing", r.reason]);
    rows.push(["cost", `penalty ${q(r.penaltyIfVoid)} (1 % of the ${q(r.deposit)} deposit, rounded up), 0 tokens; run \`report\` for this account after settlement`]);
  }
  rows.push(["receipt", r.receiptFile]);
  return [head, ...table(rows)].join("\n");
}

function fillRows(r: ReportResult): string[][] {
  const t = (v: string) => fmt(BigInt(v), r.token.decimals);
  const one = 10n ** BigInt(r.token.decimals);
  const qone = 10n ** BigInt(r.quote.decimals);
  const perToken = (f: FillRow) => (BigInt(f.tokens) > 0n ? ratio(BigInt(f.spent) * one, BigInt(f.tokens) * qone, r.quote.decimals + 6) : "-");
  const rows = [["#", "bidder", `tokens (${r.token.symbol})`, `spent (${r.quote.symbol})`, "penalty", `paid per token`, "spent = ceil(tokens x P)"]];
  for (const f of r.fills) {
    rows.push([
      String(f.index),
      `${f.bidder}${f.bidder === r.bidder ? "  <- bot" : ""}`,
      t(f.tokens),
      fmt(BigInt(f.spent), r.quote.decimals),
      f.penalty === "0" ? "" : fmt(BigInt(f.penalty), r.quote.decimals),
      perToken(f),
      BigInt(f.tokens) === 0n ? (f.valid ? "no fill" : "VOID (invalid bid)") : f.paysClearingPrice ? `yes (${f.spent} = ${f.owed})` : `NO (${f.spent} != ${f.owed})`,
    ]);
  }
  return rows;
}

export function renderReport(r: ReportResult): string {
  const q = (v: string) => `${fmt(BigInt(v), r.quote.decimals)} ${r.quote.symbol}`;
  const t = (v: string) => `${fmt(BigInt(v), r.token.decimals)} ${r.token.symbol}`;
  const f = r.fill;
  const lines = [
    `Sealround live bot: report for ${r.bidder} in sale ${r.saleId} on ${r.network}`,
    `  sale ${r.saleStatus}${r.failReason ? ` (${r.failReason})` : ""}, cleared ${r.clearedBy === "enclave" ? "by the enclave" : r.clearedBy === "onchain" ? "on chain" : "(not cleared)"}: ${r.nValid} valid bid(s), ${r.nInvalid} invalid; sold ${t(r.totalSold)} for ${q(r.totalRaised)}`,
    `  clearing price P = ${q(r.clearingPrice)} per ${r.token.symbol} (${r.clearingPrice} base units per 10^${r.token.decimals} token base units; floor ${q(r.floorPrice)})`,
    "",
  ];
  const who = [
    r.botLandedAfterMs !== null ? `sniped ${(r.botLandedAfterMs / 1000).toFixed(3)} s after the open` : null,
    r.botMaxPrice !== null ? `max price ${q(r.botMaxPrice)}` : null,
    r.copiedFrom !== null ? `a copy of ${r.copiedFrom}'s sealed bid` : null,
  ].filter(Boolean);
  lines.push(`  the bot's bid #${f.index}${who.length > 0 ? ` (${who.join(", ")})` : ""}:`);
  const rows: string[][] = [
    ["", "smallest units", "readable"],
    ["deposit", f.deposit, q(f.deposit)],
    ["tokens received", f.tokens, t(f.tokens)],
  ];
  if (BigInt(f.tokens) > 0n) {
    rows.push(
      ["tokens x P, exact", r.exactCost, `${r.quote.symbol} base units`],
      ["USDC paid (spent)", f.spent, `${q(f.spent)} = ceil(tokens x P), rounded up by ${r.roundingUp} of one base unit`],
      ["paid per token", r.pricePaidPerToken ?? "-", `base units per whole token; P is ${r.clearingPrice}`],
    );
  } else {
    rows.push(["USDC paid (spent)", f.spent, q(f.spent)]);
  }
  rows.push(["refund", f.refund, q(f.refund)], ["penalty", f.penalty, f.penalty === "0" ? "none" : `${q(f.penalty)} (invalid bid: 1 % of the deposit, rounded up)`]);
  lines.push(...table(rows, "    "));
  lines.push("", "  every bid of the sale (P paid per token = spent / tokens; it is P plus less than one base unit spread over the fill):");
  lines.push(...table(fillRows(r), "    "));
  lines.push("", "  checks:");
  for (const c of r.checks) lines.push(`    ${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  if (BigInt(f.tokens) > 0n && r.botMaxPrice !== null) {
    lines.push(
      "",
      r.winners > 1
        ? `  The bot was ready to pay up to ${q(r.botMaxPrice)} per token and paid ${q(r.clearingPrice)}: the same price as the ${r.winners - 1} other winner(s). Being first bought it nothing.`
        : `  The bot was ready to pay up to ${q(r.botMaxPrice)} per token and paid the clearing price, ${q(r.clearingPrice)}, not its own max.`,
    );
  } else if (r.copiedFrom !== null && BigInt(f.tokens) === 0n) {
    lines.push("", `  The copy of ${r.copiedFrom}'s sealed bid won nothing and cost the copycat ${q(f.penalty)}.`);
  }
  if (r.claim) {
    lines.push(
      "",
      r.claim.status === "already_claimed"
        ? `  claim: already claimed${r.claim.txHash ? ` (tx ${r.claim.txHash})` : ""}`
        : `  claim: ${tx(r.claim.txHash, r.claim.paidBy)}; received ${t(r.claim.tokensReceived)} and ${q(r.claim.usdcReceived)}`,
    );
  }
  lines.push("", r.ok ? "  RESULT: PASS, the bot paid exactly the clearing price rule, to the smallest unit." : "  RESULT: FAIL, see the checks above.");
  if (r.ok && BigInt(f.tokens) === 0n) lines[lines.length - 1] = "  RESULT: PASS, the bid won nothing; the numbers add up to the smallest unit.";
  return lines.join("\n");
}

export function renderReveal(r: RevealResult): string {
  return `REVEALED: ${r.bidder}'s bid in sale ${r.saleId}: ${tx(r.txHash, r.paidBy)}`;
}
