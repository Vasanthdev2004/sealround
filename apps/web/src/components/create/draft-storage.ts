import type { AppConfig } from "@/lib/config";
import { rasterIcon, safeIconSrc, utf8Bytes } from "@/lib/token-icon";
import { DEFAULT_DRAFT, type Draft } from "./model";

const VERSION = 1;
const MAX_RECORD_LENGTH = 24_000;
const ENUMS = {
  iconMode: ["none", "mark", "upload"],
  startMode: ["now", "scheduled"],
  duration: ["5", "30", "120", "360", "1440", "custom"],
  revealMode: ["tee", "commit_reveal"],
  revealWindow: ["1", "10", "60", "1440"],
  poolFee: ["5", "30", "100"],
} as const;

export function draftScope(config: AppConfig): string {
  return config.mode === "mock" ? "mock:local" : `${config.near.network}:${config.near.contractId}`;
}

export const draftStorageKey = (scope: string) => `sealround:create-draft:${encodeURIComponent(scope)}`;

type DraftRecord = { version: 1; scope: string; savedAt: number; draft: Draft };
export type DraftRead =
  | { kind: "empty" }
  | { kind: "valid"; record: DraftRecord }
  | { kind: "invalid" | "unsupported" | "wrong-scope" };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Stored drafts are untrusted input. Keep unfinished values, but reject unsafe shapes and icons. */
export function readDraft(raw: string | null, scope: string): DraftRead {
  if (raw === null) return { kind: "empty" };
  if (raw.length > MAX_RECORD_LENGTH) return { kind: "invalid" };
  try {
    const record: unknown = JSON.parse(raw);
    if (!object(record)) return { kind: "invalid" };
    if (record.version !== VERSION) return { kind: "unsupported" };
    if (record.scope !== scope) return { kind: "wrong-scope" };
    if (!Number.isSafeInteger(record.savedAt) || (record.savedAt as number) < 0 || (record.savedAt as number) > 8.64e15) {
      return { kind: "invalid" };
    }
    const draft = record.draft;
    if (!object(draft)) return { kind: "invalid" };
    const keys = Object.keys(DEFAULT_DRAFT) as (keyof Draft)[];
    if (Object.keys(draft).length !== keys.length) return { kind: "invalid" };
    for (const key of keys) {
      const value = draft[key];
      if (key === "iconUpload") continue;
      if (typeof value !== typeof DEFAULT_DRAFT[key]) return { kind: "invalid" };
      if (typeof value === "string" && value.length > 2048) return { kind: "invalid" };
    }
    if (typeof draft.hue !== "number" || !Number.isFinite(draft.hue) || draft.hue < 0 || draft.hue >= 360) {
      return { kind: "invalid" };
    }
    for (const [key, values] of Object.entries(ENUMS)) {
      if (!(values as readonly unknown[]).includes(draft[key])) return { kind: "invalid" };
    }
    const icon = draft.iconUpload;
    if (icon !== null) {
      if (!object(icon) || typeof icon.dataUrl !== "string" || !safeIconSrc(icon.dataUrl)) return { kind: "invalid" };
      const raster = rasterIcon(icon.dataUrl);
      if (!raster || !["png", "jpeg", "webp"].includes(raster.type) || icon.type !== `image/${raster.type}`) {
        return { kind: "invalid" };
      }
      if (!Number.isInteger(icon.size) || (icon.size as number) < 1 || (icon.size as number) > 64 ||
        icon.bytes !== utf8Bytes(icon.dataUrl) || typeof icon.name !== "string" || icon.name.length > 2048) {
        return { kind: "invalid" };
      }
    }
    return { kind: "valid", record: { version: VERSION, scope, savedAt: record.savedAt as number, draft: draft as Draft } };
  } catch {
    return { kind: "invalid" };
  }
}

/** Only form fields are persisted. Wallet data, signatures and bid secrets have no place in this record. */
export function encodeDraft(draft: Draft, scope: string, savedAt: number): string {
  const fields = Object.fromEntries(Object.keys(DEFAULT_DRAFT).map((key) => [key, draft[key as keyof Draft]]));
  if (draft.iconUpload) {
    const { dataUrl, size, type, bytes, name } = draft.iconUpload;
    fields.iconUpload = { dataUrl, size, type, bytes, name };
  }
  return JSON.stringify({ version: VERSION, scope, savedAt, draft: fields });
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export type DraftSnapshot = {
  draft: Draft;
  status: "new" | "restored" | "saved" | "discarded" | "discard-failed" | "unavailable" | "invalid" | "unsupported" | "wrong-scope";
  savedAt: number | null;
};

/** Reads only on subscription after hydration. Failed writes keep the current work in memory. */
export function createDraftStore(scope: string, storage: () => Storage) {
  const initial: DraftSnapshot = { draft: { ...DEFAULT_DRAFT }, status: "new", savedAt: null };
  let snapshot = initial;
  let loaded = false;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const key = draftStorageKey(scope);
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!loaded) {
        loaded = true;
        try {
          const read = readDraft(storage().getItem(key), scope);
          if (read.kind === "valid") snapshot = { draft: read.record.draft, savedAt: read.record.savedAt, status: "restored" };
          else if (read.kind !== "empty") snapshot = { ...initial, status: read.kind };
        } catch {
          snapshot = { ...initial, status: "unavailable" };
        }
        emit();
      }
      return () => { listeners.delete(listener); };
    },
    update(next: Draft | ((current: Draft) => Draft)) {
      const draft = typeof next === "function" ? next(snapshot.draft) : next;
      const savedAt = Date.now();
      snapshot = { draft, savedAt, status: "saved" };
      try {
        const raw = encodeDraft(draft, scope, savedAt);
        if (readDraft(raw, scope).kind !== "valid") throw new Error("Draft cannot be stored");
        storage().setItem(key, raw);
      } catch {
        snapshot = { draft, savedAt: null, status: "unavailable" };
      }
      emit();
    },
    discard() {
      snapshot = { ...initial, draft: { ...DEFAULT_DRAFT }, status: "discarded" };
      try { storage().removeItem(key); }
      catch { snapshot = { ...snapshot, status: "discard-failed" }; }
      emit();
    },
    forget() {
      // Creation succeeded. Keep the review visible until navigation finishes.
      try { storage().removeItem(key); } catch { /* The created sale remains the source of truth. */ }
    },
  };
}
