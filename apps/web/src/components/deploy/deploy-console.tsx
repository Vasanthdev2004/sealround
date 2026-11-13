"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { ArrowUpRight, Check, Copy, Download, FileUp, KeyRound, Lock, RefreshCw, Rocket, Wallet } from "lucide-react";
import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { CheckRow, type CheckState } from "@/components/ui/bits";
import { Logo } from "@/components/shell/app-shell";
import { cn } from "@/lib/cn";
import {
  PINNED_CONTRACT_BYTES,
  PINNED_CONTRACT_SHA256,
  PINNED_SEALER_SHA256,
  TESTNET,
  formatNear,
  fundingFor,
  hexToBase58,
  listKeys,
  newArgs,
  newKeyPair,
  nearToYocto,
  publicKeyOf,
  sendAsContract,
  sha256Hex,
  viewAccount,
  viewFunction,
  type AccessKey,
  type AccountState,
  type TxResult,
} from "./chain";

/*
 * The deploy flow, in the order of LAUNCH.md T5 and T8:
 *
 * 1. The owner connects a testnet wallet.
 * 2. This page generates an ed25519 key in the tab. The wallet signs one small
 *    transaction: create sealround.<owner>.testnet, fund it, add that key.
 * 3. The page signs deploy + `new` with that key, from the contract account
 *    itself, so nobody can front-run the init (the wasm is too big for most
 *    wallets to carry anyway).
 * 4. It reads the config and code hash back.
 * 5. After the smoke tests, it deletes that key: the contract is locked.
 *
 * T1 to T4 (OutLayer login, publishing the job, the master secret) need the
 * OutLayer CLI and are checked here, not done.
 */

const RPC = TESTNET.rpcUrl;
const KEY_STORE = "sealround-deploy-key:";
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

type KeyInfo = { accountId: string; publicKey: string; secretKey: string };
type Wasm = { bytes: Uint8Array; sha: string; source: string };
type Check = { state: CheckState; label: string; detail?: string };

const noop = () => () => {};

/** Client only: it reads sessionStorage and talks to wallets. */
export function DeployConsole() {
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  return mounted ? <Console /> : <div className="h-96" aria-busy />;
}

function readKey(contractId: string): KeyInfo | null {
  try {
    const raw = sessionStorage.getItem(KEY_STORE + contractId);
    return raw ? (JSON.parse(raw) as KeyInfo) : null;
  } catch {
    return null;
  }
}

function writeKey(contractId: string, key: KeyInfo | null) {
  try {
    if (key) sessionStorage.setItem(KEY_STORE + contractId, JSON.stringify(key));
    else sessionStorage.removeItem(KEY_STORE + contractId);
  } catch {
    // Storage blocked: the downloaded key file is the only copy.
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Key order does not matter when comparing the config the contract echoes. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function Console() {
  // ---------- owner account ----------
  // Two ways in. Typing the account needs no wallet: near CLI already holds
  // it for T1 to T4 and signs the one transaction that needs it (step 4).
  // A wallet is optional; most mainnet wallets (HOT, MyNearWallet) have no
  // testnet mode, so it cannot be the only way.
  const connectorRef = useRef<Promise<NearConnector> | null>(null);
  const [wallet, setWallet] = useState<NearWalletBase | null>(null);
  const [ownerInput, setOwnerInput] = useState("");
  const [owner, setOwner] = useState("");
  const [ownerBalance, setOwnerBalance] = useState<bigint | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [checkingOwner, setCheckingOwner] = useState(false);

  const connector = () => {
    connectorRef.current ??= import("@hot-labs/near-connect").then(
      ({ NearConnector }) => new NearConnector({ network: "testnet" }),
    );
    return connectorRef.current;
  };

  async function adoptOwner(id: string, w: NearWalletBase | null) {
    if (!/\.testnet$/.test(id) && !/^[0-9a-f]{64}$/.test(id)) throw new Error(`${id} is not a testnet account.`);
    const acct = await viewAccount(RPC, id);
    if (!acct.exists) throw new Error(`${id} does not exist on testnet. Create it with the faucet command below.`);
    setWallet(w);
    setOwner(id);
    setOwnerBalance(acct.balance);
    setContractId((c) => (c && c.endsWith(`.${id}`) ? c : `sealround.${id}`));
  }

  async function takeTypedOwner() {
    setCheckingOwner(true);
    setWalletError(null);
    try {
      await adoptOwner(ownerInput.trim().toLowerCase(), null);
    } catch (e) {
      setWalletError(message(e));
    } finally {
      setCheckingOwner(false);
    }
  }

  async function connect() {
    setConnecting(true);
    setWalletError(null);
    try {
      const c = await connector();
      const w = await c.connect();
      const id = (await w.getAccounts())[0]?.accountId;
      if (!id) throw new Error("The wallet returned no account.");
      await adoptOwner(id, w);
    } catch (e) {
      const text = message(e);
      if (!/user rejected|closed/i.test(text)) setWalletError(text);
    } finally {
      setConnecting(false);
    }
  }

  async function changeOwner() {
    if (wallet) {
      const c = await connector();
      await c.disconnect().catch(() => {});
    }
    setWallet(null);
    setOwner("");
    setOwnerBalance(null);
  }

  // ---------- settings ----------
  const [contractId, setContractId] = useState("");
  const [project, setProject] = useState("fairground-sealer");
  const [sealerSha, setSealerSha] = useState(PINNED_SEALER_SHA256);
  const [profile, setProfile] = useState("default");
  const [wasm, setWasm] = useState<Wasm | null>(null);
  const [wasmError, setWasmError] = useState<string | null>(null);
  const [allowOtherBuild, setAllowOtherBuild] = useState(false);
  const funding = wasm ? fundingFor(wasm.bytes.length) : fundingFor(PINNED_CONTRACT_BYTES);
  const args = owner ? newArgs(owner, project, sealerSha, profile) : null;

  const contractValid =
    !!owner && contractId.length >= 2 && contractId.length <= 64 && ACCOUNT_RE.test(contractId) && contractId.endsWith(`.${owner}`);

  async function takeWasm(bytes: Uint8Array, source: string) {
    setWasm({ bytes, sha: await sha256Hex(bytes), source });
    setWasmError(null);
  }

  async function loadRepoWasm() {
    setWasmError(null);
    try {
      const res = await fetch("/api/deploy/wasm", { cache: "no-store" });
      if (!res.ok) throw new Error(await res.text());
      await takeWasm(new Uint8Array(await res.arrayBuffer()), "contracts/res/fairground.wasm");
    } catch (e) {
      setWasmError(message(e));
    }
  }

  async function pickWasm(file: File | undefined) {
    if (!file) return;
    await takeWasm(new Uint8Array(await file.arrayBuffer()), file.name);
  }

  const wasmPinned = wasm?.sha === PINNED_CONTRACT_SHA256;
  const wasmOk = !!wasm && (wasmPinned || allowOtherBuild);

  // ---------- the contract account's key ----------
  const [key, setKey] = useState<KeyInfo | null>(null);
  const [keySaved, setKeySaved] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const keyFor = key && key.accountId === contractId ? key : contractValid ? readKey(contractId) : null;

  async function makeKey() {
    const k = await newKeyPair();
    const info = { accountId: contractId, ...k };
    writeKey(contractId, info);
    setKey(info);
    setKeySaved(false);
  }

  function downloadKey(k: KeyInfo) {
    // The same fields near CLI's legacy credentials file uses, so near CLI can import it.
    const body = JSON.stringify({ account_id: k.accountId, public_key: k.publicKey, private_key: k.secretKey }, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${k.accountId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setKeySaved(true);
  }

  async function importKey(file: File | undefined) {
    if (!file) return;
    setKeyError(null);
    try {
      const j = JSON.parse(await file.text()) as { account_id?: string; private_key?: string };
      if (!j.account_id || !j.private_key) throw new Error("Expected account_id and private_key.");
      const publicKey = await publicKeyOf(j.private_key);
      const info = { accountId: j.account_id, publicKey, secretKey: j.private_key };
      setContractId(j.account_id);
      writeKey(j.account_id, info);
      setKey(info);
      setKeySaved(true);
    } catch (e) {
      setKeyError(message(e));
    }
  }

  // ---------- chain state ----------
  const [state, setState] = useState<AccountState | null>(null);
  const [keys, setKeys] = useState<AccessKey[] | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [verify, setVerify] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txs, setTxs] = useState<{ label: string; tx: TxResult }[]>([]);
  const [confirmLock, setConfirmLock] = useState("");

  async function refresh(id = contractId) {
    const s = await viewAccount(RPC, id);
    setState(s);
    setKeys(s.exists ? await listKeys(RPC, id) : []);
    if (owner) setOwnerBalance((await viewAccount(RPC, owner)).balance);
    return s;
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }

  const projectId = `${owner}/${project}`;

  const runChecks = () =>
    run("checks", async () => {
      const out: Check[] = [];
      out.push({
        state: wasmOk ? "pass" : "fail",
        label: wasmPinned || !wasm ? "Contract wasm is the pinned build" : "Contract wasm is a rebuild you allowed",
        detail: wasm ? `${wasm.source}: ${wasm.bytes.length.toLocaleString("en-US")} bytes, sha256 ${wasm.sha}` : "No wasm loaded",
      });
      try {
        const v = await viewFunction<{ source?: { WasmUrl?: { build_target?: string } } } | null>(
          RPC,
          TESTNET.outlayer,
          "get_version",
          { project_id: projectId, version_key: sealerSha },
        );
        const target = v?.source?.WasmUrl?.build_target;
        out.push({
          state: v && target === "wasm32-wasip1" ? "pass" : "fail",
          label: "OutLayer has the sealer version (T2)",
          detail: v ? `${projectId} @ ${sealerSha.slice(0, 12)}…, build_target ${target}` : `No version ${sealerSha.slice(0, 12)}… in ${projectId}. Run 1-publish-job.ps1.`,
        });
      } catch (e) {
        out.push({ state: "fail", label: "OutLayer has the sealer version (T2)", detail: message(e) });
      }
      try {
        const row = await viewFunction<{ access?: unknown } | null>(RPC, TESTNET.outlayer, "get_secrets", {
          accessor: { Project: { project_id: projectId } },
          profile,
          owner,
        });
        const access = row ? JSON.stringify(row.access) : "";
        const ok = !!row && access.includes(sealerSha) && access.includes(`"${contractId}"`);
        out.push({
          state: ok ? "pass" : "fail",
          label: "The master secret names this build and this contract (T4)",
          detail: row
            ? ok
              ? access
              : `The row's condition does not name build ${sealerSha.slice(0, 12)}… and caller ${contractId}: ${access}`
            : `No secret row ${projectId} / ${profile}. Run 3-master-secret.ps1 -Contract ${contractId}.`,
        });
      } catch (e) {
        out.push({ state: "fail", label: "The master secret names this build and this contract (T4)", detail: message(e) });
      }
      const s = await refresh();
      out.push({
        state: s.exists ? (s.codeHash ? "fail" : "pending") : "pass",
        label: `${contractId} is free`,
        detail: s.exists
          ? s.codeHash
            ? "It already holds a contract. Pick another account (for example sealround2)."
            : "It exists with no contract: the create step ran. Continue with deploy if this tab holds its key."
          : "Not created yet",
      });
      const need = nearToYocto(funding) + nearToYocto("0.5");
      const bal = (await viewAccount(RPC, owner)).balance;
      out.push({
        state: bal >= need ? "pass" : "fail",
        label: `${owner} can fund it`,
        detail: `Holds ${formatNear(bal)} NEAR; needs ${funding} NEAR plus 0.5 for gas`,
      });
      setChecks(out);
    });

  const checksPass = !!checks && checks.every((c) => c.state === "pass");

  const createAccount = () =>
    run("create", async () => {
      if (!wallet || !keyFor) throw new Error("Connect the wallet and make the key first.");
      const outcome = (await wallet.signAndSendTransaction({
        signerId: owner,
        receiverId: contractId,
        actions: [
          { type: "CreateAccount" },
          { type: "Transfer", params: { deposit: nearToYocto(funding).toString() } },
          { type: "AddKey", params: { publicKey: keyFor.publicKey, accessKey: { permission: "FullAccess" } } },
        ],
      })) as unknown as { transaction?: { hash?: string }; status?: unknown } | undefined;
      // Some wallets return no outcome; the chain read below is the real answer.
      const hash = outcome?.transaction?.hash;
      const status = outcome?.status;
      const failed = !!status && typeof status === "object" && "Failure" in status;
      if (hash) {
        setTxs((t) => [...t, { label: "Create and fund", tx: { hash, failure: failed ? JSON.stringify(status) : null } }]);
      }
      if (failed) throw new Error(`The create transaction failed: ${JSON.stringify(status)}`);
      const s = await refresh();
      if (!s.exists) throw new Error(`${contractId} does not exist yet. Wait a few seconds and press Refresh in step 5.`);
    });

  const checkCreated = () =>
    run("check", async () => {
      if (!keyFor) throw new Error("Make or import the contract key first.");
      const s = await refresh();
      if (!s.exists) {
        throw new Error(`${contractId} does not exist yet. If near CLI printed an error, fix it and run the command again.`);
      }
      const onChain = await listKeys(RPC, contractId);
      if (!onChain.some((k) => k.publicKey === keyFor.publicKey)) {
        throw new Error(`${contractId} exists but does not hold ${keyFor.publicKey}. Import the key file you created it with.`);
      }
    });

  const deploy = () =>
    run("deploy", async () => {
      if (!keyFor || !wasm || !args) throw new Error("Missing the key, the wasm or the arguments.");
      const tx = await sendAsContract(RPC, contractId, keyFor.secretKey, (a) => [
        a.deployContract(wasm.bytes),
        a.functionCall("new", args, 100_000_000_000_000n, 0n),
      ]);
      setTxs((t) => [...t, { label: "Deploy and new", tx }]);
      if (tx.failure) throw new Error(`The transaction failed: ${tx.failure}`);
      await refresh();
      await runVerify();
    });

  async function runVerify() {
    if (!args) return;
    const out: Check[] = [];
    const s = await refresh();
    const expected = wasm ? hexToBase58(wasm.sha) : hexToBase58(PINNED_CONTRACT_SHA256);
    out.push({
      state: s.codeHash === expected ? "pass" : "fail",
      label: "Deployed code is the pinned build",
      detail: `on chain ${s.codeHash ?? "none"}; expected ${expected}`,
    });
    try {
      const cfg = await viewFunction<unknown>(RPC, contractId, "get_config", {});
      out.push({
        state: stable(cfg) === stable(args) ? "pass" : "fail",
        label: "get_config equals the new arguments",
        detail: JSON.stringify(cfg),
      });
    } catch (e) {
      out.push({ state: "fail", label: "get_config equals the new arguments", detail: message(e) });
    }
    const storageCost = BigInt(s.storageBytes) * 10n ** 19n;
    out.push({
      state: s.balance > storageCost ? "pass" : "fail",
      label: "Balance covers the storage",
      detail: `${formatNear(s.balance)} NEAR held, ${formatNear(storageCost)} NEAR locked for ${s.storageBytes.toLocaleString("en-US")} bytes`,
    });
    setVerify(out);
  }

  const lock = () =>
    run("lock", async () => {
      if (!keyFor) throw new Error("This tab does not hold the contract account's key. Import the key file.");
      const current = await listKeys(RPC, contractId);
      if (current.length !== 1 || current[0].publicKey !== keyFor.publicKey) {
        throw new Error(
          `Expected exactly one key, ${keyFor.publicKey}. The account has: ${current.map((k) => k.publicKey).join(", ") || "none"}. Delete the others first (near CLI) or stop.`,
        );
      }
      const tx = await sendAsContract(RPC, contractId, keyFor.secretKey, (a, ownKey) => [a.deleteKey(ownKey)]);
      setTxs((t) => [...t, { label: "Lock (delete the last key)", tx }]);
      if (tx.failure) throw new Error(`The transaction failed: ${tx.failure}`);
      const after = await listKeys(RPC, contractId);
      setKeys(after);
      if (after.length === 0) {
        writeKey(contractId, null);
        setKey(null);
      }
    });

  // ---------- derived progress ----------
  const created = !!state?.exists;
  const deployed = !!state?.codeHash;
  const holdsKey = !!keyFor && !!keys?.some((k) => k.publicKey === keyFor.publicKey);
  const locked = deployed && keys !== null && keys.length === 0;
  const smokeEnv = [
    `NEXT_PUBLIC_FAIRGROUND_CONTRACT=${contractId || "sealround.<owner>.testnet"}`,
    "NEXT_PUBLIC_NEAR_NETWORK=testnet",
    `NEXT_PUBLIC_SEALER_CODE_HASH=${sealerSha}`,
  ].join("\n");

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4">
        <Logo href="/" label="Sealround home" />
        <div>
          <h1 className="text-h1 text-fg">Deploy the contract</h1>
          <p className="mt-3 max-w-[64ch] text-lead text-muted">
            Create, deploy, check and lock the Sealround contract on NEAR testnet. No testnet wallet needed: near CLI
            signs the one transaction from your account, and this tab signs the rest. This is LAUNCH.md T5 and T8. T1 to T4 (OutLayer login, the job, the master secret) still run from the OutLayer CLI; step 3
            checks they are done.
          </p>
        </div>
        <p className="rounded-[12px] border border-line bg-elev px-4 py-3 text-small text-muted">
          Testnet only, on <span className="font-mono text-label">{RPC}</span>. Until the last step deletes the
          contract account&apos;s key, whoever holds that key can replace the contract and read every sealed bid. Keep
          the key file private and lock before anyone else bids.
        </p>
      </header>

      {/* 1. Owner */}
      <Step n={1} title="Your owner account" done={!!owner}>
        {owner ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-mono text-small text-fg">{owner}</div>
              <div className="text-label text-subtle">
                {ownerBalance === null ? "Reading balance…" : `${formatNear(ownerBalance)} NEAR`} ·{" "}
                {wallet ? `signs with ${wallet.manifest.name}` : "signs with near CLI"}
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void changeOwner()}>
              Change
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-small text-muted">
              The testnet account that owns the OutLayer project and the master secret (<span className="font-mono">$ME</span>{" "}
              in LAUNCH.md), the one near CLI used for T1 to T4. It pays about 7 NEAR.
            </p>
            <form
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                void takeTypedOwner();
              }}
            >
              <Field
                className="sm:flex-1"
                label="Owner account"
                value={ownerInput}
                onChange={(e) => setOwnerInput(e.target.value)}
                placeholder="you.testnet"
                spellCheck={false}
                autoComplete="off"
              />
              <Button type="submit" variant="primary" loading={checkingOwner} disabled={!ownerInput.trim()}>
                Use this account
              </Button>
            </form>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-4 text-label text-muted">
              <span>Or, if you have a wallet with testnet (Meteor, Intear, Nightly):</span>
              <Button size="sm" loading={connecting} onClick={() => void connect()} icon={<Wallet className="size-3.5" aria-hidden />}>
                Connect a wallet
              </Button>
            </div>
            <details className="text-label text-muted">
              <summary className="cursor-pointer">No testnet account yet?</summary>
              <p className="mt-2">
                Testnet and mainnet are separate chains, so a <span className="font-mono">.near</span> account does not
                exist here. near CLI makes a funded one and keeps its key in your OS keychain:
              </p>
              <CopyBlock text="near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create" />
            </details>
          </div>
        )}
        {walletError && <ErrorText>{walletError}</ErrorText>}
      </Step>

      {/* 2. Settings */}
      <Step n={2} title="Settings and build" done={wasmOk && contractValid}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Contract account"
            value={contractId}
            onChange={(e) => setContractId(e.target.value.trim().toLowerCase())}
            placeholder="sealround.<owner>.testnet"
            error={contractId && owner && !contractValid ? `Must be a valid sub-account of ${owner}` : undefined}
            spellCheck={false}
          />
          <Field label="OutLayer project" value={project} onChange={(e) => setProject(e.target.value.trim())} spellCheck={false} />
          <Field
            label="Sealer build sha256"
            value={sealerSha}
            onChange={(e) => setSealerSha(e.target.value.trim().toLowerCase())}
            error={/^[0-9a-f]{64}$/.test(sealerSha) ? undefined : "64 lowercase hex characters"}
            hint={sealerSha === PINNED_SEALER_SHA256 ? "The pinned build" : "Not the pinned build"}
            spellCheck={false}
          />
          <Field label="Secret profile" value={profile} onChange={(e) => setProfile(e.target.value.trim())} spellCheck={false} />
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <div className="text-label font-[510] text-muted">Contract wasm</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void loadRepoWasm()} icon={<RefreshCw className="size-3.5" aria-hidden />}>
              Load from the repo
            </Button>
            <label className="btn-lit btn-tactile inline-flex h-8 cursor-pointer items-center gap-2 rounded-[8px] px-3 text-[13px] font-[510]">
              <FileUp className="size-3.5" aria-hidden />
              Pick a file
              <input type="file" accept=".wasm" className="sr-only" onChange={(e) => void pickWasm(e.target.files?.[0])} />
            </label>
          </div>
          {wasm && (
            <dl className="mt-3 grid gap-1 text-label">
              <div className="flex gap-2">
                <dt className="text-subtle">File</dt>
                <dd className="text-fg">
                  {wasm.source}, <span className="num">{wasm.bytes.length.toLocaleString("en-US")}</span> bytes, funding{" "}
                  <span className="num">{funding}</span> NEAR
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-subtle">sha256</dt>
                <dd className={cn("font-mono [overflow-wrap:anywhere]", wasmPinned ? "text-ok" : "text-bad")}>{wasm.sha}</dd>
              </div>
            </dl>
          )}
          {wasm && !wasmPinned && (
            <label className="mt-2 flex items-start gap-2 text-label text-muted">
              <input type="checkbox" checked={allowOtherBuild} onChange={(e) => setAllowOtherBuild(e.target.checked)} className="mt-0.5" />
              This is not the pinned build ({PINNED_CONTRACT_SHA256.slice(0, 12)}…). I rebuilt it on purpose and will
              update every place the hash is pinned.
            </label>
          )}
          {wasmError && <ErrorText>{wasmError}</ErrorText>}
        </div>

        {args && (
          <details className="mt-4 border-t border-line pt-4">
            <summary className="cursor-pointer text-label font-[510] text-muted">The new arguments</summary>
            <pre className="inset mt-2 overflow-x-auto p-3 font-mono text-[12px] text-fg">{JSON.stringify(args, null, 2)}</pre>
          </details>
        )}
      </Step>

      {/* 3. Pre-flight */}
      <Step n={3} title="Check T1 to T4 are done" done={checksPass}>
        <div className="flex flex-col gap-3">
          <div>
            <Button
              size="sm"
              disabled={!owner || !contractValid || !wasm}
              loading={busy === "checks"}
              onClick={() => void runChecks()}
              icon={<RefreshCw className="size-3.5" aria-hidden />}
            >
              Run the checks
            </Button>
          </div>
          {checks && (
            <div className="divide-y divide-line">
              {checks.map((c) => (
                <CheckRow key={c.label} state={c.state} label={c.label} detail={c.detail} />
              ))}
            </div>
          )}
        </div>
      </Step>

      {/* 4. Create */}
      <Step n={4} title={`Create ${contractId || "the contract account"}`} done={created && holdsKey}>
        <p className="text-small text-muted">
          This tab makes a new key for the contract account. Then one transaction from {owner || "your account"} creates
          the account, sends it {funding} NEAR and adds that key. Download the key file first: the tab forgets the key
          when it closes, and without it you cannot deploy or lock.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          {!keyFor ? (
            <div>
              <Button size="sm" disabled={!contractValid} onClick={() => void makeKey()} icon={<KeyRound className="size-3.5" aria-hidden />}>
                Make the contract key
              </Button>
            </div>
          ) : (
            <div className="inset flex flex-col gap-2 p-3">
              <div className="text-label text-subtle">Contract account key (public)</div>
              <div className="font-mono text-label text-fg [overflow-wrap:anywhere]">{keyFor.publicKey}</div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" onClick={() => downloadKey(keyFor)} icon={<Download className="size-3.5" aria-hidden />}>
                  Download the key file
                </Button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-label text-muted">
            <span>Coming back to a half-done deploy?</span>
            <label className="btn-press inline-flex h-8 cursor-pointer items-center gap-2 rounded-[8px] px-3 text-[13px] font-[510] text-fg shadow-[inset_0_0_0_1px_var(--line-strong)] hover:bg-wash focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
              <FileUp className="size-3.5" aria-hidden />
              Import the key file
              <input type="file" accept=".json" className="sr-only" onChange={(e) => void importKey(e.target.files?.[0])} />
            </label>
          </div>
          {keyError && <ErrorText>{keyError}</ErrorText>}
          {keyFor && !created && (
            <label className="flex items-center gap-2 text-label text-muted">
              <input type="checkbox" checked={keySaved} onChange={(e) => setKeySaved(e.target.checked)} />I saved the key file
              somewhere private
            </label>
          )}
          {created ? (
            holdsKey ? (
              <p className="flex items-center gap-2 text-small text-ok">
                <Check className="size-4" aria-hidden /> {contractId} exists and holds this tab&apos;s key.
              </p>
            ) : (
              keys && (
                <p className="text-label text-warn">
                  {contractId} exists but this tab&apos;s key is not on it. Import the right key file.
                </p>
              )
            )
          ) : !keyFor || !keySaved || !checksPass ? (
            <p className="text-label text-subtle">
              {!checksPass ? "Pass the checks in step 3, " : ""}
              {!keyFor ? "make the key" : "download the key file"} and tick the box to see how to create the account.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="text-label text-muted">
                {wallet ? "Sign with near CLI (or with your wallet below). " : ""}Run this in a terminal; near CLI signs
                as {owner} with the key in your keychain:
              </div>
              <CopyBlock
                text={`near account create-account fund-myself ${contractId} '${funding} NEAR' use-manually-provided-public-key ${keyFor.publicKey} sign-as ${owner} network-config testnet sign-with-keychain send`}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  loading={busy === "check"}
                  onClick={() => void checkCreated()}
                  icon={<RefreshCw className="size-3.5" aria-hidden />}
                >
                  I ran it, check the account
                </Button>
                {wallet && (
                  <Button
                    loading={busy === "create"}
                    onClick={() => void createAccount()}
                    icon={<Wallet className="size-3.5" aria-hidden />}
                  >
                    Sign with {wallet.manifest.name} instead
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </Step>

      {/* 5. Deploy */}
      <Step n={5} title="Deploy and initialise" done={deployed}>
        <p className="text-small text-muted">
          Signed in this tab with the contract account&apos;s own key: the wasm and the <span className="font-mono">new</span>{" "}
          call go in one transaction (100 TGas, paid from the account&apos;s {funding} NEAR), so nobody can call{" "}
          <span className="font-mono">new</span> first.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!created || !holdsKey || deployed || !wasmOk}
            loading={busy === "deploy"}
            onClick={() => void deploy()}
            icon={<Rocket className="size-4" aria-hidden />}
          >
            {deployed ? "Deployed" : "Deploy and call new"}
          </Button>
          <Button
            disabled={!contractValid}
            loading={busy === "refresh"}
            onClick={() =>
              void run("refresh", async () => {
                const s = await refresh();
                if (s.codeHash) await runVerify();
              })
            }
            icon={<RefreshCw className="size-3.5" aria-hidden />}
          >
            Refresh
          </Button>
        </div>
        {state && (
          <p className="mt-3 text-label text-subtle">
            {state.exists
              ? `${contractId}: ${formatNear(state.balance)} NEAR, ${state.codeHash ? `code ${state.codeHash}` : "no code"}, ${keys?.length ?? 0} key(s)`
              : `${contractId} does not exist yet.`}
          </p>
        )}
      </Step>

      {/* 6. Verify */}
      <Step n={6} title="Check what was deployed" done={!!verify && verify.every((c) => c.state === "pass")}>
        {verify ? (
          <div className="divide-y divide-line">
            {verify.map((c) => (
              <CheckRow key={c.label} state={c.state} label={c.label} detail={c.detail} />
            ))}
          </div>
        ) : (
          <p className="text-small text-muted">Runs after the deploy, or press Refresh in step 5.</p>
        )}
      </Step>

      {/* 7. Smoke test */}
      <Step n={7} title="Smoke-test a sale before you lock (T6, T7)">
        <p className="text-small text-muted">
          Point the app at the new contract and run one sale end to end: create it, place one bid, close it, claim. Put
          these lines in <span className="font-mono">apps/web/.env.local</span> and restart the dev server, or run{" "}
          <span className="font-mono">5-smoke-sale.ps1</span> and <span className="font-mono">7-smoke-clear.ps1</span> with{" "}
          <span className="font-mono">-Contract {contractId || "<contract>"}</span>, then the evidence sale (
          <span className="font-mono">8-evidence-sale.ps1</span>, LAUNCH.md T7b). The sale must reach{" "}
          <span className="font-mono">settled</span> with no failed checks before step 8.
        </p>
        <pre className="inset mt-3 overflow-x-auto p-3 font-mono text-[12px] text-fg">{smokeEnv}</pre>
        {contractValid && (
          <a
            href={`${TESTNET.explorerAccount}${contractId}`}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-label text-muted hover:text-fg"
          >
            {contractId} on the explorer <ArrowUpRight className="size-3.5" aria-hidden />
          </a>
        )}
      </Step>

      {/* 8. Lock */}
      <Step n={8} title="Lock the contract. Cannot be undone" done={locked}>
        <p className="text-small text-muted">
          Deletes the contract account&apos;s only key. After this nobody, you included, can redeploy, fix or read the bids
          of <span className="font-mono">{contractId || "the contract"}</span>. If the smoke test showed a problem in the
          contract, do not lock: deploy a fresh account (for example <span className="font-mono">sealround2.{owner || "<owner>.testnet"}</span>) and
          point the secret at it first.
        </p>
        {locked ? (
          <p className="mt-4 flex items-center gap-2 text-small text-ok">
            <Lock className="size-4" aria-hidden /> Locked: {contractId} has no access keys.
          </p>
        ) : (
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field
              className="sm:w-80"
              label={`Type ${contractId || "the contract account"} to confirm`}
              value={confirmLock}
              onChange={(e) => setConfirmLock(e.target.value.trim())}
              spellCheck={false}
            />
            <Button
              variant="danger"
              disabled={!deployed || !holdsKey || confirmLock !== contractId}
              loading={busy === "lock"}
              onClick={() => void lock()}
              icon={<Lock className="size-4" aria-hidden />}
            >
              Delete the last key
            </Button>
          </div>
        )}
      </Step>

      {error && (
        <div role="alert" className="rounded-[12px] border border-bad/40 bg-bad-soft px-4 py-3 text-small text-fg">
          {error}
        </div>
      )}

      {txs.length > 0 && (
        <Panel title="Transactions">
          <ul className="flex flex-col gap-2">
            {txs.map(({ label, tx }) => (
              <li key={tx.hash} className="flex flex-wrap items-center justify-between gap-2 text-small">
                <span className={tx.failure ? "text-bad" : "text-fg"}>
                  {label}
                  {tx.failure ? " (failed)" : ""}
                </span>
                <a
                  href={`${TESTNET.explorerTx}${tx.hash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-label text-muted hover:text-fg"
                >
                  {tx.hash.slice(0, 10)}… <ArrowUpRight className="size-3.5" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <section className="panel p-5 sm:p-6" aria-labelledby={`step-${n}`}>
      <div className="mb-4 flex items-center gap-3">
        <span
          className={cn(
            "num flex size-7 shrink-0 items-center justify-center rounded-full text-label font-[590]",
            done ? "bg-ok/15 text-ok" : "bg-wash text-muted",
          )}
          aria-hidden
        >
          {done ? <Check className="size-4" /> : n}
        </span>
        <h2 id={`step-${n}`} className="text-h3 text-fg">
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </h2>
      </div>
      {children}
    </section>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="inset relative mt-2">
      <pre className="overflow-x-auto p-3 pr-20 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
        {text}
      </pre>
      <Button
        size="sm"
        variant="ghost"
        className="absolute top-1.5 right-1.5"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        icon={copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-label text-bad [overflow-wrap:anywhere]">{children}</p>;
}
