"use client";

/**
 * "Get 10 test USDC" at the top of the bid form, for the hosted testnet app.
 * Testnet sales are paid in usdc.fakes.testnet, whose `mint` anyone may call.
 * The button asks the connected wallet to call it for the connected account
 * (client.faucet: if the account is not registered on the token yet, that
 * comes first, paid by the relayer or by the wallet with 0.00125 NEAR), then
 * shows the new balance.
 *
 * It renders nothing in mock mode (demo accounts start with 100 test USDC),
 * on mainnet, on a sandbox, for a sale paid in another token, and once the
 * bid window is over.
 */

import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { errorInfo, getClient } from "@/lib/client";
import type { NearNetwork } from "@/lib/config";
import { usdcStr } from "@/lib/format";
import type { Sale, SaleStatus } from "@/lib/types";
import { TESTNET_WALLETS_HINT, useWallet } from "@/lib/wallet";

/**
 * The only token this button mints. The same name as TESTNET_TEST_USDC in
 * lib/client/near.ts, kept apart so the sale page does not load the NEAR
 * client to render (the tests check the two agree).
 */
export const TEST_USDC_TOKEN = "usdc.fakes.testnet";

/** One press mints 10 USDC (6 decimals). */
export const TEST_USDC_AMOUNT = 10_000_000n;

/** Whether the button belongs on this sale's bid form. */
export function offersTestUsdc(o: {
  mode: "mock" | "near";
  network: NearNetwork | null;
  /** The client's USDC contract, the one the faucet mints. */
  usdcContract: string;
  /** The sale's quote token. */
  quoteToken: string;
  status: SaleStatus;
}): boolean {
  return (
    o.mode === "near" &&
    o.network === "testnet" &&
    o.usdcContract === TEST_USDC_TOKEN &&
    o.quoteToken === TEST_USDC_TOKEN &&
    (o.status === "upcoming" || o.status === "open")
  );
}

type State =
  | { kind: "idle" }
  | { kind: "busy"; note: string | null }
  | { kind: "done"; usdc: bigint }
  | { kind: "error"; message: string };

const IDLE: State = { kind: "idle" };

export function GetTestUsdc({ sale, className }: { sale: Sale; className?: string }) {
  const { account, mode, network } = useWallet();
  // Kept per account: switching accounts starts over.
  const [saved, setSaved] = useState<{ account: string | null; state: State }>({ account: null, state: IDLE });

  const usdcContract = mode === "near" ? getClient().usdcContract : "";
  if (!offersTestUsdc({ mode, network, usdcContract, quoteToken: sale.config.quoteToken, status: sale.status })) {
    return null;
  }
  const state = saved.account === account ? saved.state : IDLE;

  async function get() {
    if (!account) return;
    const who = account;
    const client = getClient();
    setSaved({ account: who, state: { kind: "busy", note: null } });
    // The client says so when the wallet must also pay to register the account on USDC.
    const off = client.subscribeNotices((n) => {
      if (n.kind !== "storage_paid" && n.kind !== "storage_sponsored") return;
      setSaved((s) => (s.account === who && s.state.kind === "busy" ? { account: who, state: { kind: "busy", note: n.message } } : s));
    });
    try {
      const balances = await client.faucet(who, TEST_USDC_AMOUNT);
      setSaved({ account: who, state: { kind: "done", usdc: balances.usdc } });
    } catch (e) {
      setSaved({ account: who, state: { kind: "error", message: errorInfo(e).message } });
    } finally {
      off();
    }
  }

  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6", className)}>
      <div className="min-w-0">
        <p className="text-small text-fg">Bids on testnet are paid in test USDC.</p>
        {state.kind === "error" ? (
          <p role="alert" className="mt-0.5 text-label text-bad">
            {state.message}
          </p>
        ) : (
          <p role="status" className="mt-0.5 text-label text-subtle">
            {!account ? (
              `Connect a testnet wallet first. ${TESTNET_WALLETS_HINT}`
            ) : state.kind === "busy" ? (
              (state.note ?? "Your wallet asks you to sign the mint.")
            ) : state.kind === "done" ? (
              <span className="inline-flex items-center gap-1.5">
                <Check className="size-3.5 shrink-0 text-ok" aria-hidden />
                <span>
                  Added 10 test USDC. You have <span className="num text-fg">{usdcStr(state.usdc)}</span> USDC.
                </span>
              </span>
            ) : (
              <>
                Free test token (<span className="num">{TEST_USDC_TOKEN}</span>), no value. Your wallet signs the mint.
              </>
            )}
          </p>
        )}
      </div>
      <Button
        type="button"
        size="sm"
        variant="tactile"
        onClick={get}
        loading={state.kind === "busy"}
        disabled={!account}
        className="shrink-0 max-sm:h-10 max-sm:w-full"
      >
        {state.kind === "busy" ? "Confirm in your wallet" : "Get 10 test USDC"}
      </Button>
    </div>
  );
}
