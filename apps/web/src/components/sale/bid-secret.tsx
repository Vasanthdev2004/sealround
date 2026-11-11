"use client";

/**
 * Commit-reveal bid secrets, as the bidder handles them: back up the secret
 * this browser holds (a small JSON file), and bring one in on another device.
 *
 * The secret is the committed max price, max spend and salt. Without it a bid
 * cannot be revealed, and a bid that is not revealed is void and loses 1 % of
 * its deposit. It is kept only in this browser's storage (lib/bid-secrets), so
 * the backup is the bidder's own safety net.
 */

import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { exportBidSecrets, importBidSecrets } from "@/lib/bid-secrets";
import { getClient } from "@/lib/client";
import { cn } from "@/lib/cn";

/** Hands the browser a text file to save. */
function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Saves this account's reveal secrets (every sale on this contract) as a JSON file. */
export function ExportSecretButton({
  account,
  size = "sm",
  className,
}: {
  account: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const [saved, setSaved] = useState(false);
  return (
    <Button
      size={size}
      className={cn("max-sm:h-10", className)}
      icon={<Download className="size-3.5" strokeWidth={1.75} />}
      onClick={() => {
        const text = exportBidSecrets({ contract: getClient().secretsScope, bidder: account });
        downloadText(`sealround-bid-secrets-${account}.json`, text);
        setSaved(true);
      }}
    >
      {saved ? "Saved. Save again" : "Back up reveal secret"}
    </Button>
  );
}

/**
 * Reads a file made by ExportSecretButton into this browser. Says how many
 * secrets it held, or why the file was refused. The page updates by itself
 * (useBidSecret) once the secret for this bid is in.
 */
export function ImportSecrets({
  className,
  variant = "tactile",
  size = "md",
}: {
  className?: string;
  /** `primary` where importing is the one thing left to do (the reveal step). */
  variant?: "tactile" | "primary";
  size?: "md" | "lg";
}) {
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const n = importBidSecrets(await file.text());
      setResult({
        ok: n > 0,
        text:
          n > 0
            ? `Read ${n} ${n === 1 ? "secret" : "secrets"} from the file.`
            : "The file holds no secrets.",
      });
    } catch (e) {
      const why = e instanceof SyntaxError ? "It is not a JSON file." : e instanceof Error ? e.message : String(e);
      setResult({ ok: false, text: `Could not read that file. ${why}` });
    } finally {
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <Button
        variant={variant}
        size={size}
        className={cn("self-start", size === "md" && "max-sm:h-10")}
        icon={<Upload className="size-4" strokeWidth={1.75} />}
        onClick={() => input.current?.click()}
      >
        Import a bid secrets file
      </Button>
      {result && (
        <p role="status" className={cn("text-label", result.ok ? "text-ok" : "text-bad")}>
          {result.text}
        </p>
      )}
    </div>
  );
}
