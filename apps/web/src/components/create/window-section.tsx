"use client";

import { useId } from "react";
import { Field, Segmented } from "@/components/ui/field";
import { dateTime } from "@/lib/format";
import { FormSection, Label, SectionNotices, type SectionProps } from "./form-kit";
import { DURATION_PRESETS, suggestedStart, windowLabel, type DurationPreset, type StartMode } from "./model";

export function WindowSection({ draft, set, error, touch, derived }: SectionProps) {
  const { values, notices } = derived;
  const dur = values.durationMs;
  const start = values.startAt;
  const opensId = useId();
  const lengthId = useId();

  const onStartMode = (m: StartMode) => {
    set("startMode", m);
    if (m === "scheduled" && !draft.startAt) set("startAt", suggestedStart(Date.now()));
  };

  let summary: React.ReactNode = null;
  if (dur !== undefined) {
    if (draft.startMode === "now") {
      summary = (
        <>
          Bids open the moment you create the sale and close <span className="num text-fg">{windowLabel(dur)}</span>{" "}
          later.
        </>
      );
    } else if (typeof start === "number") {
      summary = (
        <>
          Bids open <span className="num text-fg">{dateTime(start)}</span> and close{" "}
          <span className="num text-fg">{dateTime(start + dur)}</span>.
        </>
      );
    }
  }

  return (
    <FormSection
      id="window"
      n={4}
      title="Bid window"
      description="Bids arriving at second one and at the last second are treated the same."
    >
      <div className="flex flex-col gap-2">
        <Label id={opensId}>Opens</Label>
        <Segmented<StartMode>
          labelledBy={opensId}
          value={draft.startMode}
          onChange={onStartMode}
          options={[
            { value: "now", label: "When I create it" },
            { value: "scheduled", label: "At a set time" },
          ]}
        />
      </div>

      {draft.startMode === "scheduled" && (
        <Field
          label="Start time"
          type="datetime-local"
          value={draft.startAt}
          onChange={(e) => set("startAt", e.target.value)}
          onBlur={() => touch("startAt")}
          error={error("startAt")}
          hint="Your local time."
          className="sm:max-w-[300px]"
        />
      )}

      <div className="flex flex-col gap-2">
        <Label id={lengthId}>Length</Label>
        <Segmented<DurationPreset>
          labelledBy={lengthId}
          value={draft.duration}
          onChange={(v) => set("duration", v)}
          options={DURATION_PRESETS.map((p) => ({
            value: p.value,
            label: p.testnet ? (
              <>
                {p.label}
                <span className="text-[11px] opacity-70">testnet</span>
              </>
            ) : (
              p.label
            ),
          }))}
        />
      </div>

      {draft.duration === "custom" && (
        <Field
          label="Custom length"
          inputMode="numeric"
          value={draft.customMinutes}
          suffix="minutes"
          onChange={(e) => set("customMinutes", e.target.value)}
          onBlur={() => touch("customMinutes")}
          error={error("customMinutes")}
          hint={dur !== undefined ? windowLabel(dur) : "1 minute to 30 days."}
          className="sm:max-w-[300px]"
        />
      )}

      {summary && <p className="text-[13px] leading-relaxed text-muted">{summary}</p>}

      <SectionNotices notices={notices} section="window" />
    </FormSection>
  );
}
