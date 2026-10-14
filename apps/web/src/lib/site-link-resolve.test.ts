import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSiteNoteHref, type SiteLinkCandidate } from "@knotebook/shared";
import { FALLBACK_TIMEOUT_MS, resolveFromCache, resolveViaServer } from "./site-link-resolve";

const ORIGIN = window.location.origin;
const GID = "aaaaaaaa-1111-4111-8111-111111111111";
const LIST: SiteLinkCandidate[] = [{ id: "11111111-1111-4111-8111-111111111111", title: "A", slug: "a", groupId: null, ownerHandle: "alice" }];
const parsed = (href: string) => parseSiteNoteHref(href, ORIGIN)!;

describe("#269 resolveFromCache", () => {
  it("快取未載入 → unknown；命中 → hit；載入了沒有 → miss", () => {
    expect(resolveFromCache(undefined, parsed("/n/alice/a"))).toEqual({ kind: "unknown" });
    expect(resolveFromCache(LIST, parsed("/n/alice/a"))).toEqual({ kind: "hit", target: { id: LIST[0]!.id, title: "A" } });
    expect(resolveFromCache(LIST, parsed("/n/alice/b"))).toEqual({ kind: "miss" });
  });
});

describe("#269 resolveViaServer（§6.5 三支端點、寫入者權限、非 200 一律 null）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

  it("n／g／ref 各打對的端點；200 → { id, title }", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(() => ok({ id: "x1", title: "T", extra: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolveViaServer(parsed("/n/Alice/My%20Note"))).toEqual({ id: "x1", title: "T" });
    expect(await resolveViaServer(parsed(`/g/${GID}/plan`))).toEqual({ id: "x1", title: "T" });
    expect(await resolveViaServer(parsed("/notes/legacy-slug"))).toEqual({ id: "x1", title: "T" });
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual([
      "/api/notes/by-path/alice/my%20note",
      `/api/notes/by-group-path/${GID}/plan`,
      "/api/notes/legacy-slug",
    ]);
  });

  it("404／網路錯誤 → null", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: { code: "not_found", message: "x" } }) } as Response)));
    expect(await resolveViaServer(parsed("/n/alice/a"))).toBeNull();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("down"))));
    expect(await resolveViaServer(parsed("/n/alice/a"))).toBeNull();
  });

  it("逾時（5 s）→ abort、null", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_u: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_res, rej) => signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    }));
    const p = resolveViaServer(parsed("/n/alice/a"));
    await vi.advanceTimersByTimeAsync(FALLBACK_TIMEOUT_MS);
    expect(await p).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(FALLBACK_TIMEOUT_MS).toBe(5_000);
  });
});
