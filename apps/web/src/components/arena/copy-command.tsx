"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** A shell command with a copy button. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div>
      <div className="inset flex h-11 items-center gap-3 pr-1.5 pl-3.5">
        <span className="font-mono text-[13px] text-subtle select-none" aria-hidden>
          $
        </span>
        <code className="min-w-0 flex-1 truncate font-mono text-[13.5px] text-fg">{command}</code>
        <button
          type="button"
          onClick={copy}
          className="btn-tactile inline-flex size-8 shrink-0 items-center justify-center text-muted hover:text-fg"
          aria-label={copied ? "Copied" : `Copy ${command}`}
        >
          {copied ? <Check className="size-4 text-ok" strokeWidth={2} /> : <Copy className="size-4" strokeWidth={1.75} />}
        </button>
      </div>
      {failed && <p className="mt-1.5 text-[12px] text-bad">Could not copy. Select the command and copy it by hand.</p>}
    </div>
  );
}
