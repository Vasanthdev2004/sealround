"use client";

import { useState } from "react";
import { FilePenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DraftSnapshot } from "./draft-storage";

const LABEL: Record<DraftSnapshot["status"], string> = {
  new: "Your draft stays in this browser",
  saved: "Draft saved on this device",
  restored: "Your saved draft is restored",
  discarded: "Draft discarded. Start fresh below.",
  "discard-failed": "Draft cleared here, but its saved copy could not be removed and may return after a reload.",
  unavailable: "Browser storage is unavailable. Keep this page open to keep your edits.",
  invalid: "The saved draft could not be read. Start fresh below.",
  unsupported: "This draft uses an older or unsupported format. Start fresh below.",
  "wrong-scope": "This draft belongs to another network or contract. It was not restored.",
};

export function DraftBar({ snapshot, scopeLabel, onDiscard }: {
  snapshot: DraftSnapshot;
  scopeLabel: string;
  onDiscard: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <section aria-label="Local sale draft" className="flex flex-wrap items-center justify-between gap-3 border-y border-line py-4">
      <div className="flex min-w-0 items-start gap-3">
        <FilePenLine className="mt-0.5 size-4 shrink-0 text-accent" strokeWidth={1.75} aria-hidden />
        <div className="min-w-0">
          <p className="text-small text-fg" role="status">{LABEL[snapshot.status]}</p>
          <p className="mt-1 text-label text-subtle [overflow-wrap:anywhere]">
            {scopeLabel}. Unsigned form fields only. No sale exists until you confirm creation.
          </p>
        </div>
      </div>
      {confirm ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-small text-muted">Discard your draft?</span>
          <Button size="sm" variant="outline" className="max-sm:min-h-11" onClick={() => { onDiscard(); setConfirm(false); }}>Discard</Button>
          <Button size="sm" variant="ghost" className="max-sm:min-h-11" onClick={() => setConfirm(false)}>Keep editing</Button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" className="max-sm:min-h-11" onClick={() => setConfirm(true)}>Start fresh</Button>
      )}
    </section>
  );
}
