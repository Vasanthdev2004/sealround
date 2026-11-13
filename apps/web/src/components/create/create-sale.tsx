"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/panel";
import { getClient } from "@/lib/client";
import { validateConfig } from "@/lib/client/mock";
import { useClientQuery } from "@/lib/hooks";
import { focusEl, scrollToEl } from "@/lib/scroll";
import { useWallet } from "@/lib/wallet";
import { AllocationSection } from "./allocation-section";
import { Insights } from "./insights";
import { LimitsSection } from "./limits-section";
import { FixedRules, ModeSection } from "./mode-section";
import { PoolSection } from "./pool-section";
import { PresetPicker } from "./presets";
import { CreateSteps, sectionStatuses } from "./progress";
import { PriceSection } from "./price-section";
import { Review } from "./review";
import type { CreateCost, EditTarget } from "./rules";
import { SimulateSection } from "./simulate-section";
import { SummaryCard } from "./summary-card";
import { TokenSection } from "./token-section";
import { WindowSection } from "./window-section";
import type { SectionProps } from "./form-kit";
import {
  DEFAULT_DRAFT,
  FIELD_ORDER,
  SECTION_OF,
  buildConfig,
  buildMeta,
  derive,
  sectionDomId,
  type Draft,
  type FieldKey,
  type SectionId,
} from "./model";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const sectionOf = (k: EditTarget): SectionId => (k === "mode" ? "mode" : SECTION_OF[k]);

function scrollToSection(k: EditTarget) {
  scrollToEl(document.getElementById(sectionDomId(sectionOf(k))));
}

/**
 * After the section has rendered: focus the first field marked invalid in it,
 * or else its first control, so keyboard and screen-reader users land where
 * the fix is (not on the button they pressed at the bottom of the summary).
 */
function focusSection(k: EditTarget) {
  window.setTimeout(() => {
    const sec = document.getElementById(sectionDomId(sectionOf(k)));
    focusEl(
      sec?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
        sec?.querySelector<HTMLElement>("input, textarea, select, [role=radio][tabindex='0']"),
    );
  }, 80);
}

/** Focus the page's h1 (PageHeader makes it focusable) once the new step has rendered. */
function focusHeading() {
  window.setTimeout(() => focusEl(document.querySelector<HTMLElement>("main h1")), 60);
}

/** /create: a sectioned form beside a sticky summary of the sale, then a review step. */
export function CreateSale() {
  const router = useRouter();
  const { account, connect, connecting, mode } = useWallet();
  // Existing sales, to catch a taken symbol while typing. Updates on any change; no polling needed.
  const salesQ = useClientQuery(() => getClient().listSales(), ["create:sales"], 0);
  const sales = salesQ.data;
  // The exchange launch pools go to (get_config `dex`). None: the contract takes no launch liquidity.
  const dexQ = useClientQuery(() => getClient().getLiquidityDex(), ["create:dex"], 0);
  const dex = dexQ.data ?? null;

  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  // Time of the last edit. Null until then, so nothing reads the clock while prerendering.
  const [now, setNow] = useState<number | null>(null);
  const [touched, setTouched] = useState<Partial<Record<FieldKey, true>>>({});
  const [attempted, setAttempted] = useState(false);
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The sale exists and its page is loading: the review step shows that until the route changes.
  const [created, setCreated] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // NEAR mode: what the contract says these parameters cost (it validates them too).
  const [cost, setCost] = useState<CreateCost>({ state: "idle" });

  const taken = new Set((sales ?? []).map((s) => s.config.tokenSymbol));
  const poolOpts = { pool: dex !== null };
  const derived = derive(draft, taken, now, poolOpts);
  const errorCount = Object.keys(derived.errors).length;

  /** Whether field k's error is on screen: live errors at once, the rest after blur or a review attempt. */
  const shown = (key: FieldKey) => {
    const e = derived.errors[key];
    return !!e && (!!e.live || !!touched[key] || attempted);
  };
  const error = (key: FieldKey) => (shown(key) ? derived.errors[key]?.msg : undefined);
  // Computed before the handlers below: the React Compiler lint otherwise assumes this
  // call could run them during render (they read the clock).
  const statuses = sectionStatuses(derived, shown);

  const set: SectionProps["set"] = (key, value) => {
    setDraft((p) => ({ ...p, [key]: value }));
    setNow(Date.now());
    setReviewError(null);
  };
  const touch = (key: FieldKey) => setTouched((t) => (t[key] ? t : { ...t, [key]: true }));
  /** A preset (or its undo): set several fields at once and mark `fields` touched, so their errors show. */
  const applyPreset = (values: Partial<Draft>, fields: FieldKey[]) => {
    setDraft((p) => ({ ...p, ...values }));
    if (fields.length) setTouched((t) => ({ ...t, ...Object.fromEntries(fields.map((k) => [k, true as const])) }));
    setNow(Date.now());
    setReviewError(null);
  };

  const review = () => {
    const t = Date.now();
    setNow(t);
    const fresh = derive(draft, taken, t, poolOpts);
    if (!fresh.ready) {
      setAttempted(true);
      const first = FIELD_ORDER.find((k) => fresh.errors[k]);
      if (first) {
        scrollToSection(first);
        focusSection(first);
      }
      return;
    }
    const client = getClient();
    const config = buildConfig(draft, fresh.ready, t, client.usdcContract, dex);
    try {
      validateConfig(config, sales ?? []);
    } catch (e) {
      setReviewError(message(e));
      return;
    }
    setReviewError(null);
    setSubmitError(null);
    if (client.mode === "near") {
      // The contract checks the same parameters and names its price: the
      // review step shows it, and Create stays off until it has answered.
      setCost({ state: "loading" });
      client.getCreateCost(account ?? client.contractId, config, buildMeta(draft)).then(
        (yocto) => setCost({ state: "ready", yocto }),
        (e: unknown) => setCost({ state: "error", message: message(e) }),
      );
    }
    setStep("review");
    window.scrollTo({ top: 0 });
    focusHeading();
  };

  const backToEdit = (focus?: EditTarget) => {
    setStep("edit");
    setSubmitError(null);
    if (focus) {
      if (focus !== "mode") setTouched((t) => ({ ...t, [focus]: true }));
      requestAnimationFrame(() => scrollToSection(focus));
      focusSection(focus);
    } else {
      requestAnimationFrame(() => window.scrollTo({ top: 0 }));
      focusHeading();
    }
  };

  const create = async () => {
    if (!account || submitting || created) return;
    const t = Date.now();
    setNow(t);
    const fresh = derive(draft, taken, t, poolOpts);
    if (!fresh.ready) {
      setSubmitError("Some rules are no longer valid, for example a start time that has now passed.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const client = getClient();
      const config = buildConfig(draft, fresh.ready, t, client.usdcContract, dex);
      const meta = buildMeta(draft);
      if (client.mode === "near" && cost.state === "ready") {
        // The wallet attaches what the contract asks at this moment. If that is
        // no longer the figure on screen, show the new one and wait for a second
        // confirmation. A failed read does not block: createSale reads it again
        // and reports its own errors.
        const latest = await client.getCreateCost(account, config, meta).catch(() => null);
        if (latest !== null && latest !== cost.yocto) {
          setCost({ state: "ready", yocto: latest, was: cost.yocto });
          setSubmitting(false);
          return;
        }
      }
      const sale = await client.createSale(account, config, meta);
      // Stay in the pending state until the sale page takes over.
      setCreated(true);
      router.push(`/sale/${sale.id}`);
    } catch (e) {
      setSubmitError(message(e));
      setSubmitting(false);
    }
  };

  if (step === "review") {
    return (
      <Review
        draft={draft}
        derived={derived}
        dex={dex}
        account={account}
        mode={mode}
        cost={cost}
        connect={() => void connect()}
        connecting={connecting}
        submitting={submitting}
        created={created}
        submitError={submitError}
        onBack={() => backToEdit()}
        onCreate={() => void create()}
        onEdit={(k) => backToEdit(k)}
      />
    );
  }

  const sectionProps: SectionProps = { draft, set, error, touch, derived };

  return (
    <div className="flex flex-col gap-8 lg:gap-10">
      <PageHeader
        title="Launch a sale"
        description="Every rule you set here locks when the sale is created."
        aside={<CreateSteps at={0} />}
      />

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start xl:gap-14">
        <div className="flex min-w-0 flex-col gap-10 sm:gap-12">
          {/* While get_config is loading, Pool first stays on offer; it goes if the contract has no dex. */}
          <PresetPicker draft={draft} poolAvailable={dex !== null || dexQ.loading} onApply={applyPreset} />
          <TokenSection {...sectionProps} status={statuses.token} />
          <AllocationSection {...sectionProps} status={statuses.allocation} />
          <PriceSection {...sectionProps} status={statuses.price} />
          <WindowSection {...sectionProps} status={statuses.window} />
          <LimitsSection {...sectionProps} status={statuses.limits} />
          <Insights derived={derived} />
          <ModeSection {...sectionProps} status={statuses.mode} />
          {dex !== null && <PoolSection {...sectionProps} status={statuses.pool} dex={dex} />}
          <SimulateSection derived={derived} />
          <FixedRules />
        </div>

        <aside className="min-w-0 lg:sticky lg:top-[72px]">
          <SummaryCard
            draft={draft}
            derived={derived}
            mode={mode}
            statuses={statuses}
            errorCount={errorCount}
            attempted={attempted}
            reviewError={reviewError}
            onReview={review}
          />
        </aside>
      </div>
    </div>
  );
}
