"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * A shell command with a copy button. The command wraps at its spaces instead
 * of being cut, so the sale id at its end always shows.
 */
export function LiveCommand({ command, what }: { command: string; what: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setState("copied");
      window.setTimeout(() => setState("idle"), 1600);
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="min-w-0">
      <div className="flex flex-col gap-1.5 rounded-tile border border-line bg-inset py-1.5 pr-1.5 pl-3.5 sm:flex-row sm:items-start sm:gap-2.5">
        <div className="flex min-w-0 flex-1 gap-2.5 pt-[5px] pb-[3px]">
          <span className="font-mono text-label text-subtle select-none" aria-hidden>
            $
          </span>
          <code className="min-w-0 flex-1 font-mono text-label leading-[1.55] text-fg [overflow-wrap:anywhere]">
            {/* Lines break between words only, never inside "--contract" or an account id. */}
            {command.split(" ").map((word, i) => (
              <span key={i}>
                {i > 0 && " "}
                <span className="whitespace-nowrap">{word}</span>
              </span>
            ))}
          </code>
        </div>
        <Button
          size="sm"
          className="shrink-0 self-end sm:self-auto"
          onClick={() => void copy()}
          aria-label={`Copy the command that checks ${what}`}
        >
          {state === "copied" ? "Copied" : "Copy"}
        </Button>
      </div>
      <span role="status" className="sr-only">
        {state === "copied" ? "Command copied." : ""}
      </span>
      {state === "failed" && (
        <p className="mt-1.5 text-label text-bad">Could not copy. Select the command and copy it by hand.</p>
      )}
    </div>
  );
}
