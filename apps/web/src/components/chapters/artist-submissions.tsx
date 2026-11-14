import Image from "next/image";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { decodeArt, MAX_ART_BYTES, MAX_ART_SUBMISSIONS, readChapterArt } from "@/lib/chapters/art";
import { artistLabel, chapterAmount, type ChapterArtMime, type ChapterRound, type ChapterSeries, type ChapterState, type ChapterSubmission } from "@/lib/chapters/model";
import { readDemoView, runDemo } from "@/lib/chapters/demo";
import { runSandbox, type ChapterSandbox } from "@/lib/chapters/sandbox";
import { canSignChapter, chapterWalletSigner } from "@/lib/chapters/wallet";
import { cn } from "@/lib/cn";
import { sha256Hex, toB64 } from "@/lib/crypto";
import type { WalletState } from "@/lib/wallet";

const ART_TYPES: readonly ChapterArtMime[] = ["image/jpeg", "image/png", "image/webp"];
const DEMO_ARTISTS = ["guest-mira.testnet", "guest-sora.testnet"] as const;

type Asset = { image: string; alt: string };

export function VerifiedArtwork({ assetKey, load, className }: {
  assetKey: string;
  load: () => Promise<Asset>;
  className?: string;
}) {
  const [state, setState] = useState<{ key: string; asset: Asset | null } | null>(null);
  const loadAsset = useEffectEvent(load);
  useEffect(() => {
    let active = true;
    void loadAsset().then((asset) => {
      if (active) setState({ key: assetKey, asset });
    }, () => {
      if (active) setState({ key: assetKey, asset: null });
    });
    return () => { active = false; };
  }, [assetKey]);
  const current = state?.key === assetKey ? state : null;
  return <span className={cn("relative grid place-items-center overflow-hidden bg-elev-2", className ?? "aspect-[3/2]")}>
    {current?.asset ? <Image src={current.asset.image} alt={current.asset.alt} fill unoptimized
      sizes="(min-width: 640px) 50vw, 100vw" className="object-contain"
      onError={() => setState({ key: assetKey, asset: null })} />
      : <span role="status" className="px-3 text-center text-label text-muted">
        {current ? "Artwork could not be verified or displayed." : "Loading artwork…"}
      </span>}
  </span>;
}

type ArtistProps = {
  id: number;
  series: ChapterSeries;
  parent: ChapterRound | undefined;
  artists?: string[];
  submissions: ChapterSubmission[];
  sandbox: ChapterSandbox | null;
  wallet: WalletState;
  onUpdate: (state: ChapterState) => void;
};

export function ArtistSubmissions({ id, parent, artists, submissions, sandbox, wallet, series, onUpdate }: ArtistProps) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const winnerChoice = parent?.winner;
  const winner = parent && winnerChoice != null ? parent.candidates[winnerChoice] : null;
  const full = submissions.length >= MAX_ART_SUBMISSIONS;
  const submitted = submissions.some(({ artist }) => artist === wallet.account);
  const canSubmit = !sandbox || canSignChapter(wallet, sandbox.network ?? "sandbox");
  const invited = !wallet.account || !artists || artists.includes(wallet.account);
  return (
    <section className="panel grid gap-4 p-5 sm:p-6" aria-labelledby="chapter-art-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="chapter-art-title" className="text-h3 text-fg">Artwork for chapter {id}</h3>
          <p className="mt-1 text-small text-muted">{winner
            ? <>Continue the story from <span className="text-fg">{winner.title}</span>, the last winning panel.</>
            : "Submit an original panel for the curator to consider."}</p>
        </div>
        <span className="num text-label text-muted">{submissions.length} of {MAX_ART_SUBMISSIONS} submitted</span>
      </header>
      {parent && winnerChoice != null && winner && <figure className="grid max-w-sm gap-2">
        <VerifiedArtwork assetKey={winner.content_sha256} load={() => readChapterArt(parent, winnerChoice, sandbox, undefined, series)}
          className="aspect-[3/2] rounded-[10px] border border-line" />
        <figcaption className="text-label text-muted">Round {parent.round_id} winner · {artistLabel(winner.artist)}</figcaption>
      </figure>}
      {artists?.length === 0 ? <p className="text-small text-muted">The curator must invite artists before submissions open.</p>
        : !invited ? <p className="text-small text-muted">This wallet needs an invitation from the curator to upload.</p>
        : full ? <p className="text-small text-muted">All submission slots are filled.</p>
        : sandbox && submitted ? <p className="text-small text-muted">This wallet has submitted its entry.</p>
          : open && wallet.account ? <ArtworkForm id={id} wallet={wallet} series={series} sandbox={sandbox} parentSha256={winner?.content_sha256 ?? null}
            submissions={submissions} onCancel={() => setOpen(false)} onSubmitted={(next, title) => {
              setOpen(false);
              setNotice(`“${title}” was submitted for chapter ${id}.`);
              onUpdate(next);
            }} />
            : <div>
              <Button variant="outline" size="lg" loading={wallet.connecting} disabled={!!wallet.account && !canSubmit} onClick={() => {
                if (!wallet.account) void wallet.connect();
                else { setOpen(true); setNotice(null); }
              }}>{wallet.account ? "Submit artwork" : sandbox ? "Connect to submit artwork" : "Connect demo wallet to submit artwork"}</Button>
              {wallet.error && !wallet.account && <p role="alert" className="mt-2 text-small text-bad">{wallet.error}</p>}
            </div>}
      {notice && <p role="status" className="text-small text-fg">{notice}</p>}
    </section>
  );
}

type ArtworkFile = { mime: ChapterArtMime; encoded: string; bytes: number; digest: string; resized: boolean };

async function artworkFromFile(file: File): Promise<ArtworkFile> {
  const mime = ART_TYPES.find((type) => type === file.type);
  if (!mime || file.size === 0) throw new Error("Choose a JPEG, PNG or WebP image.");
  if (file.size > 10 * 1024 * 1024) throw new Error("Choose a source image under 10 MB.");
  const source = URL.createObjectURL(file);
  try {
    const image = new window.Image();
    image.src = source;
    await image.decode().catch(() => { throw new Error("This browser could not read that image. Export it as a JPEG, PNG or WebP and try again."); });
    if (image.naturalWidth * image.naturalHeight > 24_000_000) throw new Error("Choose a source image under 24 megapixels.");
    let asset: Blob = file;
    let storedType = mime;
    if (file.size > MAX_ART_BYTES || Math.max(image.naturalWidth, image.naturalHeight) > 1600) {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not resize the artwork. Choose a smaller file.");
      // Keep the full composition and reduce resolution or quality only as far as storage requires.
      for (const [limit, quality] of [[1280, 0.82], [960, 0.76], [640, 0.72], [480, 0.66], [320, 0.60], [256, 0.55]]) {
        const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const compressed = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
        if (compressed && compressed.size <= MAX_ART_BYTES && (compressed.type === "image/webp" || compressed.type === "image/png")) {
          asset = compressed;
          storedType = compressed.type;
          break;
        }
      }
      if (asset === file) throw new Error("The artwork could not fit in 48 KiB. Try a smaller image.");
    }
    const bytes = new Uint8Array(await asset.arrayBuffer());
    const encoded = toB64(bytes);
    decodeArt(encoded, storedType);
    return { mime: storedType, encoded, bytes: bytes.length, digest: await sha256Hex(bytes), resized: asset !== file };
  } finally {
    URL.revokeObjectURL(source);
  }
}

function ArtworkForm({ id, parentSha256, submissions, sandbox, wallet, series, onCancel, onSubmitted }: Omit<ArtistProps, "parent" | "onUpdate"> & {
  parentSha256: string | null;
  onCancel: () => void;
  onSubmitted: (state: ChapterState, title: string) => void;
}) {
  const fileId = useId();
  const artistId = useId();
  const [title, setTitle] = useState("");
  const [demoArtist, setDemoArtist] = useState("");
  const [art, setArt] = useState<ArtworkFile | null>(null);
  const [review, setReview] = useState<{ deposit: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const account = sandbox ? wallet.account : demoArtist || wallet.account;
  const artistHasEntry = submissions.some((item) => item.artist === account);
  const artHasEntry = art && submissions.some((item) => item.content_sha256 === art.digest);
  const repeatsWinner = art?.digest === parentSha256;
  const blocked = artistHasEntry || artHasEntry || repeatsWinner;

  async function loadFile(file: File | undefined) {
    setArt(null);
    setError(null);
    if (!file || pending.current) return;
    pending.current = true;
    setBusy(true);
    try { setArt(await artworkFromFile(file)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "That image could not be opened."); }
    finally { pending.current = false; setBusy(false); }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account || !art || blocked || pending.current) return;
    const trimmed = title.trim();
    if (!trimmed || new TextEncoder().encode(trimmed).byteLength > 96) {
      setError("Enter an artwork title of at most 96 bytes.");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!review) {
        const deposit = sandbox
          ? await sandbox.rpc.view<string>(sandbox.contract, "art_storage_cost", { byte_length: art.bytes }) : null;
        setReview({ deposit });
        return;
      }
      const action = { kind: "submit_art" as const, roundId: id, title: trimmed, mimeType: art.mime,
        imageBase64: art.encoded, parentSha256 };
      if (sandbox) {
        const signer = chapterWalletSigner(wallet, sandbox.network ?? "sandbox", account);
        if (review.deposit === null) throw new Error("Review the artwork storage deposit again.");
        const next = await runSandbox(sandbox, signer, account, id, { ...action, reviewedDeposit: review.deposit },
          (state) => state.submissions?.[id]?.some((item) => item.artist === account && item.title === trimmed
            && item.content_sha256 === art.digest && item.parent_sha256 === parentSha256) === true);
        onSubmitted(next, trimmed);
      } else {
        await runDemo({ ...action, account }, series);
        onSubmitted(readDemoView(wallet.account, series), trimmed);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Artwork submission could not be confirmed.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <form className="grid gap-3 border-t border-line pt-4" onSubmit={(event) => void submit(event)}>
    <fieldset className="grid min-w-0 gap-3" disabled={busy || review !== null}>
      {!sandbox && <div className="grid gap-1.5">
        <label htmlFor={artistId} className="text-label font-[510] text-muted">Submit as</label>
        <select id={artistId} aria-describedby={`${artistId}-help`} value={demoArtist} onChange={(event) => {
          setDemoArtist(event.target.value);
          setError(null);
        }} className="inset h-10 min-w-0 px-3 text-small text-fg">
          <option value="">Connected demo wallet</option>
          {DEMO_ARTISTS.map((artist) => <option key={artist} value={artist}>{artist === DEMO_ARTISTS[0] ? "Mira" : "Sora"} (demo artist)</option>)}
        </select>
        <p id={`${artistId}-help`} className="text-label text-subtle">The demo artists let you try two entries in this browser.</p>
      </div>}
      <Field label="Artwork title" value={title} required maxLength={96} onChange={(event) => { setTitle(event.target.value); setError(null); }} />
      <div className="grid gap-1.5">
        <label htmlFor={fileId} className="text-label font-[510] text-muted">Artwork file</label>
        <input id={fileId} type="file" accept={ART_TYPES.join(",")} aria-describedby={`${fileId}-help`}
          className="min-w-0 max-w-full rounded-btn text-small text-muted file:mr-3 file:h-11 file:cursor-pointer file:rounded-btn file:border-0 file:bg-wash file:px-3 file:text-fg"
          onChange={(event) => void loadFile(event.target.files?.[0])} />
        <p id={`${fileId}-help`} className="text-label text-subtle">JPEG, PNG or WebP. Larger images are resized to fit 48 KiB.</p>
      </div>
    </fieldset>
    {art && <figure className="grid max-w-md gap-2">
      <div className="relative aspect-[3/2] overflow-hidden rounded-[10px] border border-line bg-elev-2">
        <Image src={`data:${art.mime};base64,${art.encoded}`} alt="Preview of your submitted artwork" fill unoptimized
          sizes="(min-width: 640px) 448px, 100vw" className="object-contain" />
      </div>
      <figcaption className="num text-label text-muted">{art.resized ? "Resized preview · " : "Original file · "}{(art.bytes / 1024).toFixed(1)} KiB</figcaption>
    </figure>}
    {review && <div className="grid gap-1 text-small text-muted" aria-live="polite">
      <p>Artist <span className="break-all text-fg">{account}</span></p>
      <p>{review.deposit === null ? "This entry is stored in your browser for the demo." :
        <>Storage deposit <span className="num text-fg">{chapterAmount(review.deposit, 24, "NEAR")}</span>. Your wallet signs the submission and the file stays public on this chain.</>}</p>
      <p className="break-all font-mono text-label">SHA-256 {art?.digest}</p>
    </div>}
    {blocked && <p role="status" className="text-small text-muted">{artistHasEntry
      ? "This artist already has an entry for this chapter." : repeatsWinner ? "Submit a new panel that continues the winning artwork."
        : "This artwork already has an entry for this chapter."}</p>}
    {error && <p role="alert" className="text-small text-bad">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!art || !title.trim() || blocked}>
        {review ? "Confirm submission" : "Review submission"}
      </Button>
      <Button type="button" variant="ghost" size="lg" disabled={busy} onClick={() => {
        setError(null);
        if (review) setReview(null);
        else onCancel();
      }}>{review ? "Edit artwork" : "Cancel"}</Button>
    </div>
  </form>;
}
