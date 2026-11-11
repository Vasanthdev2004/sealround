"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

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
      <div className="flex h-11 items-center gap-2.5 rounded-tile border border-line bg-inset pr-1.5 pl-3.5 max-sm:h-12 max-sm:pr-1">
        <span className="font-mono text-label text-subtle select-none" aria-hidden>
          $
        </span>
        <code className="min-w-0 flex-1 truncate font-mono text-label text-fg">{command}</code>
        <Button
          size="sm"
          className="max-sm:h-10"
          onClick={copy}
          aria-label={copied ? "Command copied" : `Copy ${command}`}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {failed && <p className="mt-1.5 text-label text-bad">Could not copy. Select the command and copy it by hand.</p>}
    </div>
  );
}
