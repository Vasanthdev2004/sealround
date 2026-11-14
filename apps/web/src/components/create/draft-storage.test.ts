import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "@/lib/config";
import { utf8Bytes } from "@/lib/token-icon";
import { DEFAULT_DRAFT, type Draft } from "./model";
import { createDraftStore, draftScope, draftStorageKey, encodeDraft, readDraft } from "./draft-storage";

const SCOPE = "sandbox:sealround.test.near";
const draft: Draft = { ...DEFAULT_DRAFT, name: "A draft", symbol: "DRAFT", floor: "unfinished." };
const serialized = (change: Record<string, unknown> = {}) => JSON.stringify({
  version: 1, scope: SCOPE, savedAt: 1234, draft, ...change,
});
const memory = () => {
  const items = new Map<string, string>();
  return { items, getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); }, removeItem: (key: string) => { items.delete(key); } };
};

describe("unsigned sale drafts", () => {
  it("restores unfinished inputs exactly without approving their sale rules", () => {
    expect(readDraft(encodeDraft(draft, SCOPE, 1234), SCOPE)).toEqual({ kind: "valid", record: { version: 1, scope: SCOPE, savedAt: 1234, draft } });
  });

  it("isolates mock mode, networks and contract accounts", () => {
    const cfg = (network: string, contract = "sealround.testnet") => parseConfig({ NEXT_PUBLIC_NEAR_NETWORK: network, NEXT_PUBLIC_FAIRGROUND_CONTRACT: contract });
    const scopes = [draftScope({ mode: "mock" }), draftScope(cfg("testnet")), draftScope(cfg("mainnet")), draftScope(cfg("testnet", "other.testnet"))];
    expect(new Set(scopes.map(draftStorageKey)).size).toBe(4);
    expect(readDraft(serialized(), "testnet:sealround.testnet")).toEqual({ kind: "wrong-scope" });
  });

  it("rejects corrupt, oversized, missing, wrong-type and unsupported records", () => {
    for (const raw of ["{", "null", "[]", "x".repeat(24_001), serialized({ draft: {} }), serialized({ savedAt: -1 }), serialized({ draft: { ...draft, poolOn: "false" } }), serialized({ draft: { ...draft, hue: 360 } }), serialized({ draft: { ...draft, duration: "forever" } })]) {
      expect(readDraft(raw, SCOPE), raw.slice(0, 80)).toEqual({ kind: "invalid" });
    }
    expect(readDraft(null, SCOPE)).toEqual({ kind: "empty" });
    expect(readDraft(serialized({ version: 0 }), SCOPE)).toEqual({ kind: "unsupported" });
    expect(readDraft(serialized({ version: 2 }), SCOPE)).toEqual({ kind: "unsupported" });
  });

  it("stores only the form allowlist and image metadata, never injected keys", () => {
    const raw = encodeDraft({ ...draft, secretKey: "private", account: "signer" } as Draft, SCOPE, 1234);
    expect(raw).not.toMatch(/secretKey|private|signer/);
    expect(readDraft(serialized({ draft: { ...draft, secretKey: "private" } }), SCOPE).kind).toBe("invalid");
  });

  it("validates uploaded icons by data URL size, MIME and image signature", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKx8AAAAASUVORK5CYII=";
    const icon = { dataUrl, type: "image/png", bytes: utf8Bytes(dataUrl), size: 32, name: "token.png" };
    const raw = (iconUpload: unknown) => serialized({ draft: { ...draft, iconMode: "upload", iconUpload } });
    expect(readDraft(raw(icon), SCOPE).kind).toBe("valid");
    for (const bad of ["https://tracker.test/icon.png", "data:text/html,<script>bad</script>", "data:image/svg+xml,<svg/>", "data:image/png;base64,YWJjZA==", `data:image/png;base64,${"A".repeat(2048)}`]) {
      expect(readDraft(raw({ ...icon, dataUrl: bad, bytes: utf8Bytes(bad) }), SCOPE).kind).toBe("invalid");
    }
    expect(readDraft(raw({ ...icon, type: "image/jpeg" }), SCOPE).kind).toBe("invalid");
    expect(readDraft(raw({ ...icon, bytes: 1 }), SCOPE).kind).toBe("invalid");
  });
});

describe("draft lifecycle", () => {
  it("does not access browser storage during server rendering and restores on subscription", () => {
    const db = memory();
    db.setItem(draftStorageKey(SCOPE), serialized());
    const getStorage = vi.fn(() => db);
    const store = createDraftStore(SCOPE, getStorage);
    expect(store.getServerSnapshot().status).toBe("new");
    expect(getStorage).not.toHaveBeenCalled();
    const notify = vi.fn();
    const unsubscribe = store.subscribe(notify);
    expect(store.getSnapshot()).toMatchObject({ draft, status: "restored", savedAt: 1234 });
    expect(notify).toHaveBeenCalledOnce();
    unsubscribe();
    store.subscribe(notify);
    expect(getStorage).toHaveBeenCalledOnce();
  });

  it("saves changes, restores them in another visit and discards only this scope", () => {
    const db = memory();
    db.setItem(draftStorageKey("other"), "untouched");
    const store = createDraftStore(SCOPE, () => db);
    store.subscribe(() => {});
    store.update(draft);
    expect(store.getSnapshot().status).toBe("saved");
    const restored = createDraftStore(SCOPE, () => db);
    restored.subscribe(() => {});
    expect(restored.getSnapshot().draft).toEqual(draft);
    restored.discard();
    expect(restored.getSnapshot()).toMatchObject({ status: "discarded", draft: DEFAULT_DRAFT });
    expect(db.getItem(draftStorageKey(SCOPE))).toBeNull();
    expect(db.getItem(draftStorageKey("other"))).toBe("untouched");
  });

  it("keeps edits usable when browser storage is blocked or full", () => {
    const store = createDraftStore(SCOPE, () => { throw new Error("SecurityError"); });
    expect(() => store.subscribe(() => {})).not.toThrow();
    store.update(draft);
    expect(store.getSnapshot()).toMatchObject({ status: "unavailable", draft });
    store.update((current) => ({ ...current, symbol: "NEXT" }));
    expect(store.getSnapshot().draft.name).toBe(draft.name);
    expect(store.getSnapshot().draft.symbol).toBe("NEXT");
    expect(() => store.discard()).not.toThrow();
  });

  it("does not restore invalid data and reports why", () => {
    const db = memory();
    db.setItem(draftStorageKey(SCOPE), serialized({ version: 0 }));
    const store = createDraftStore(SCOPE, () => db);
    store.subscribe(() => {});
    expect(store.getSnapshot()).toMatchObject({ draft: DEFAULT_DRAFT, status: "unsupported" });
  });

  it("reports a failed write or removal without losing the current form", () => {
    const db = memory();
    db.setItem(draftStorageKey(SCOPE), serialized());
    const store = createDraftStore(SCOPE, () => ({
      ...db,
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    }));
    store.subscribe(() => {});
    store.update((current) => ({ ...current, symbol: "EDIT" }));
    expect(store.getSnapshot()).toMatchObject({ status: "unavailable", draft: { symbol: "EDIT", name: draft.name } });
    store.discard();
    expect(store.getSnapshot()).toMatchObject({ status: "discard-failed", draft: DEFAULT_DRAFT });
    expect(db.getItem(draftStorageKey(SCOPE))).toBe(serialized());
  });

  it("removes a created draft without clearing the review before navigation", () => {
    const db = memory();
    const store = createDraftStore(SCOPE, () => db);
    store.subscribe(() => {});
    store.update(draft);
    store.forget();
    expect(store.getSnapshot().draft).toEqual(draft);
    expect(db.getItem(draftStorageKey(SCOPE))).toBeNull();
  });
});
