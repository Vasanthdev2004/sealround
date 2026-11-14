"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ACCOUNT_ID } from "@/lib/config";
import { saveChapterArtists } from "@/lib/chapters/creator";
import { chapterAmount, type ChapterState } from "@/lib/chapters/model";
import type { ChapterSandbox } from "@/lib/chapters/sandbox";
import { chapterWalletSigner } from "@/lib/chapters/wallet";
import type { WalletState } from "@/lib/wallet";

export function ChapterArtists({ id, artists, account, sandbox, wallet, onUpdate }: {
  id: number;
  artists: string[];
  account: string;
  sandbox: ChapterSandbox;
  wallet: WalletState;
  onUpdate: (state: ChapterState) => void;
}) {
  const [text, setText] = useState(artists.join("\n"));
  const [review, setReview] = useState<{ accounts: string[]; deposit: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (review) {
        const next = await saveChapterArtists(sandbox, account, id, review.accounts, review.deposit,
          () => chapterWalletSigner(wallet, sandbox.network ?? "sandbox", account));
        setReview(null);
        onUpdate(next);
      } else {
        const accounts = text.trim().split(/[\s,]+/);
        if (accounts.length < 2 || accounts.length > 8 || new Set(accounts).size !== accounts.length || accounts.some((id) => !ACCOUNT_ID.test(id))) {
          throw new Error("Enter 2 to 8 distinct NEAR artist accounts.");
        }
        const deposit = await sandbox.rpc.view<string>(sandbox.contract, "artist_roster_cost", { round_id: id });
        setReview({ accounts, deposit });
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Artist roster did not confirm.");
      if (review) setReview(null);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <form className="panel grid gap-3 p-5 sm:p-6" onSubmit={(event) => void submit(event)}>
    <h3 className="text-h3 text-fg">Invite artists for round {id}</h3>
    {review ? <div className="space-y-2 text-small text-muted">
      <p className="break-words">{review.accounts.join(", ")}</p>
      <p>Roster storage {chapterAmount(review.deposit, 24, "NEAR")}</p>
    </div> : <label className="grid gap-1.5 text-label font-medium text-muted">
      Artist wallet accounts
      <textarea aria-label="Artist wallet accounts" className="inset min-h-24 w-full px-3 py-2 text-small text-fg" value={text} maxLength={520} disabled={busy}
        spellCheck={false} onChange={(event) => setText(event.target.value)} />
      Only invited wallets can upload. Keep artists who have already submitted.
    </label>}
    {error && <p className="text-small text-bad" role="alert">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" variant="outline" loading={busy}>{review ? "Confirm artist roster" : "Review artist roster"}</Button>
      {review && <Button type="button" variant="ghost" disabled={busy} onClick={() => setReview(null)}>Edit</Button>}
    </div>
  </form>;
}
