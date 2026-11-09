"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/panel";
import { getClient } from "@/lib/client";
import { validateConfig } from "@/lib/client/mock";
import { useClientQuery } from "@/lib/hooks";
import { useWallet } from "@/lib/wallet";
import { AllocationSection } from "./allocation-section";
import { Insights } from "./insights";
import { LimitsSection } from "./limits-section";
import { ModeSection } from "./mode-section";
import { PriceSection } from "./price-section";
import { Review } from "./review";
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
} from "./model";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function scrollToSection(k: FieldKey) {
  document.getElementById(sectionDomId(SECTION_OF[k]))?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** /create: sectioned form with a sticky locked-rules summary, then a review step. */
export function CreateSale() {
  const router = useRouter();
  const { account, connect, connecting } = useWallet();
  // Existing sales, to catch a taken symbol while typing. Updates on any change; no polling needed.
  const salesQ = useClientQuery(() => getClient().listSales(), ["create:sales"], 0);
  const sales = salesQ.data;

  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  // Time of the last edit. Null until then, so nothing reads the clock while prerendering.
  const [now, setNow] = useState<number | null>(null);
  const [touched, setTouched] = useState<Partial<Record<FieldKey, true>>>({});
  const [attempted, setAttempted] = useState(false);
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const taken = new Set((sales ?? []).map((s) => s.config.tokenSymbol));
  const derived = derive(draft, taken, now);
  const errorCount = Object.keys(derived.errors).length;

  const set: SectionProps["set"] = (key, value) => {
    setDraft((p) => ({ ...p, [key]: value }));
    setNow(Date.now());
    setReviewError(null);
  };
  const touch = (key: FieldKey) => setTouched((t) => (t[key] ? t : { ...t, [key]: true }));
  const error = (key: FieldKey) => {
    const e = derived.errors[key];
    if (!e) return undefined;
    return e.live || touched[key] || attempted ? e.msg : undefined;
  };

  const review = () => {
    const t = Date.now();
    setNow(t);
    const fresh = derive(draft, taken, t);
    if (!fresh.ready) {
      setAttempted(true);
      const first = FIELD_ORDER.find((k) => fresh.errors[k]);
      if (first) scrollToSection(first);
      return;
    }
    try {
      validateConfig(buildConfig(draft, fresh.ready, t), sales ?? []);
    } catch (e) {
      setReviewError(message(e));
      return;
    }
    setReviewError(null);
    setSubmitError(null);
    setStep("review");
    window.scrollTo({ top: 0 });
  };

  const backToEdit = (focus?: FieldKey) => {
    setStep("edit");
    setSubmitError(null);
    if (focus) {
      setTouched((t) => ({ ...t, [focus]: true }));
      requestAnimationFrame(() => scrollToSection(focus));
    } else {
      requestAnimationFrame(() => window.scrollTo({ top: 0 }));
    }
  };

  const create = async () => {
    if (!account || submitting) return;
    const t = Date.now();
    setNow(t);
    const fresh = derive(draft, taken, t);
    if (!fresh.ready) {
      setSubmitError("Some rules are no longer valid, for example a start time that has now passed.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const sale = await getClient().createSale(account, buildConfig(draft, fresh.ready, t), buildMeta(draft));
      // Stay in the pending state until the sale page takes over.
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
        account={account}
        connect={() => void connect()}
        connecting={connecting}
        submitting={submitting}
        submitError={submitError}
        onBack={() => backToEdit()}
        onCreate={() => void create()}
        onEditField={(k) => backToEdit(k)}
      />
    );
  }

  const sectionProps: SectionProps = { draft, set, error, touch, derived };

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-6">
      <PageHeader
        eyebrow="Step 1 of 2 · Set the rules"
        title="Create a sale"
        description="Buyers seal their bids, the sale clears at one price, and everyone who wins pays it. You set the rules once; after creation nobody can change them."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          <TokenSection {...sectionProps} />
          <AllocationSection {...sectionProps} />
          <PriceSection {...sectionProps} />
          <WindowSection {...sectionProps} />
          <LimitsSection {...sectionProps} />
          <Insights derived={derived} />
          <ModeSection {...sectionProps} />
        </div>

        <aside className="min-w-0 xl:sticky xl:top-[80px]">
          <SummaryCard
            draft={draft}
            derived={derived}
            account={account}
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
