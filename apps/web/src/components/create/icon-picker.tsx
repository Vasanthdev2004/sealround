"use client";

import { useId, useRef, useState } from "react";
import { ImageUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Segmented } from "@/components/ui/field";
import { TokenMark } from "@/components/ui/token-mark";
import { cn } from "@/lib/cn";
import { MARK_EMOJI, MAX_ICON_BYTES, bytesStr, iconType, tickerMark, utf8Bytes } from "@/lib/token-icon";
import { Label, type SectionProps } from "./form-kit";
import { ACCEPT_ATTR, iconFromFile } from "./icon-image";
import { draftIcon, type IconMode } from "./model";

const MODES: { value: IconMode; label: string }[] = [
  { value: "mark", label: "Generate" },
  { value: "upload", label: "Upload" },
  { value: "none", label: "None" },
];

/** Where the icon shows, largest first: the sale page header, the board, a wallet's token list. */
const PREVIEW_SIZES = [44, 32, 20] as const;

const TYPE_NAME: Record<string, string> = { png: "PNG", jpeg: "JPEG", webp: "WebP", "svg+xml": "SVG" };

/**
 * The token's icon: a generated mark (letters or one emoji on the chosen
 * colour), an uploaded image shrunk to fit the contract's 2,048 bytes, or
 * none. The icon is stored on chain in the token's metadata, so wallets show
 * it; the preview shows it at the sizes it appears in the app.
 */
export function IconPicker({ draft, set, error, touch }: Pick<SectionProps, "draft" | "set" | "error" | "touch">) {
  const labelId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const icon = draftIcon(draft);
  const bytes = icon ? utf8Bytes(icon) : 0;
  const fieldError = error("icon");

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setUploadError(null);
    try {
      const up = await iconFromFile(file);
      set("iconUpload", up);
      set("iconMode", "upload");
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      // The same file can be picked again after a change.
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <Label id={labelId}>
          Icon <span className="font-normal text-subtle">optional</span>
        </Label>
        {icon && (
          <span className="num text-label text-subtle">
            {bytes.toLocaleString("en-US")} / {MAX_ICON_BYTES.toLocaleString("en-US")} bytes
          </span>
        )}
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
        {/* The icon at the sizes it appears. */}
        <div className="flex shrink-0 items-end gap-3" aria-label="Icon preview" role="group">
          {PREVIEW_SIZES.map((s, i) => (
            <TokenMark
              key={s}
              symbol={draft.symbol || "?"}
              hue={draft.hue}
              icon={icon}
              size={s}
              alt={i === 0 ? `Icon preview, ${s} pixels` : ""}
            />
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <Segmented<IconMode>
            labelledBy={labelId}
            value={draft.iconMode}
            onChange={(v) => {
              set("iconMode", v);
              setUploadError(null);
            }}
            options={MODES}
            className="w-fit"
          />

          {draft.iconMode === "mark" && (
            <div className="flex flex-col gap-2.5">
              <Field
                label="Letters or emoji"
                placeholder={draft.symbol ? tickerMark(draft.symbol) : "NI"}
                value={draft.mark}
                maxLength={16}
                autoComplete="off"
                spellCheck={false}
                inputClassName="font-sans!"
                onChange={(e) => set("mark", e.target.value)}
                onBlur={() => touch("icon")}
                error={fieldError}
                hint="Up to 3 letters or digits, or one emoji, on the colour above. Empty uses the ticker."
              />
              <div role="group" aria-label="Emoji" className="-mx-1 flex flex-wrap">
                {MARK_EMOJI.map((e) => {
                  const on = draft.mark.trim() === e;
                  return (
                    <button
                      key={e}
                      type="button"
                      aria-pressed={on}
                      aria-label={`Use ${e}`}
                      onClick={() => set("mark", on ? "" : e)}
                      className={cn(
                        "btn-press grid size-10 place-items-center rounded-btn text-h2 transition-colors duration-[120ms] ease-surface",
                        on ? "bg-accent-soft ring-1 ring-accent/40 ring-inset" : "hover:bg-wash",
                      )}
                    >
                      <span aria-hidden>{e}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {draft.iconMode === "upload" && (
            <div className="flex flex-col gap-2">
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT_ATTR}
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => void choose(e.target.files?.[0])}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="md"
                  loading={busy}
                  onClick={() => fileRef.current?.click()}
                  icon={<ImageUp className="size-4" strokeWidth={1.75} aria-hidden />}
                >
                  {draft.iconUpload ? "Replace image" : "Choose image"}
                </Button>
                {draft.iconUpload && !busy && (
                  <Button
                    variant="ghost"
                    size="md"
                    onClick={() => set("iconUpload", null)}
                    icon={<X className="size-4" strokeWidth={1.75} aria-hidden />}
                  >
                    Remove
                  </Button>
                )}
              </div>
              <p aria-live="polite" className={cn("text-label", uploadError || fieldError ? "text-bad" : "text-subtle")}>
                {uploadError ??
                  fieldError ??
                  (busy
                    ? "Fitting the image…"
                    : draft.iconUpload
                      ? `${draft.iconUpload.name}: cropped square, ${draft.iconUpload.size} px ${
                          TYPE_NAME[iconType(draft.iconUpload.dataUrl) ?? ""] ?? "image"
                        }, ${bytesStr(draft.iconUpload.bytes)}.`
                      : "Cropped to a square and shrunk to fit 2,048 bytes, in this browser.")}
              </p>
            </div>
          )}

          {draft.iconMode === "none" && (
            <p className="text-label text-subtle">The ticker&apos;s monogram stands in. Wallets show no icon.</p>
          )}
        </div>
      </div>
    </div>
  );
}
