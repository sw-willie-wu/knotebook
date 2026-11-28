import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver, onlineManager } from "@tanstack/react-query";
import { formatBytes } from "@knotebook/shared";
import { AUTH_CONFIG_QUERY_KEY } from "@/api/authConfig";
import { groupStorageKey } from "@/api/storage";
import { createPrecheckCtxProvider, precheckMessage, precheckUpload } from "./precheck";

const MIB = 1024 * 1024;

function fileOfSize(name: string, size: number): File {
  const f = new File([new Uint8Array([1])], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
}

const CTX = { maxUploadBytes: 10 * MIB, maxMediaUploadBytes: 100 * MIB, roomBytes: undefined };

describe("precheckUpload", () => {
  it("a media file is checked against the media limit", () => {
    expect(precheckUpload(fileOfSize("a.mp4", 50 * MIB), CTX)).toEqual({ ok: true, category: "video" });
    expect(precheckUpload(fileOfSize("a.mp4", 100 * MIB + 1), CTX)).toEqual({
      ok: false,
      reason: "tooLarge",
      limitBytes: 100 * MIB,
    });
  });

  it("a document is checked against the document limit", () => {
    expect(precheckUpload(fileOfSize("a.pdf", 10 * MIB), CTX)).toEqual({ ok: true, category: "pdf" });
    expect(precheckUpload(fileOfSize("a.pdf", 10 * MIB + 1), CTX)).toEqual({
      ok: false,
      reason: "tooLarge",
      limitBytes: 10 * MIB,
    });
  });

  it("an unknown extension is unsupported", () => {
    expect(precheckUpload(fileOfSize("a.zip", 5), CTX)).toEqual({ ok: false, reason: "unsupported" });
  });

  it("an empty file is refused up front; one byte passes", () => {
    expect(precheckUpload(fileOfSize("notes.txt", 0), CTX)).toEqual({ ok: false, reason: "empty" });
    expect(precheckUpload(fileOfSize("notes.txt", 1), CTX)).toEqual({ ok: true, category: "text" });
  });

  it("room: refuses a file larger than the room, accepts one that exactly fits", () => {
    expect(precheckUpload(fileOfSize("a.mp4", 240 * MIB), { ...CTX, maxMediaUploadBytes: 500 * MIB, roomBytes: 180 * MIB })).toEqual({
      ok: false,
      reason: "noRoom",
      roomBytes: 180 * MIB,
    });
    expect(precheckUpload(fileOfSize("a.mp4", 180 * MIB), { ...CTX, maxMediaUploadBytes: 500 * MIB, roomBytes: 180 * MIB }).ok).toBe(true);
  });

  it("unknown room and no storage limit never refuse on room", () => {
    expect(precheckUpload(fileOfSize("a.mp4", 90 * MIB), { ...CTX, roomBytes: undefined }).ok).toBe(true);
    expect(precheckUpload(fileOfSize("a.mp4", 90 * MIB), { ...CTX, roomBytes: null }).ok).toBe(true);
  });

  it("a name without a known extension but an image/* type passes as an image against the document limit", () => {
    const f = (size: number) => {
      const x = new File([new Uint8Array([1])], "clipboard", { type: "image/png" });
      Object.defineProperty(x, "size", { value: size });
      return x;
    };
    expect(precheckUpload(f(5 * MIB), CTX)).toEqual({ ok: true, category: "image" });
    expect(precheckUpload(f(10 * MIB + 1), CTX)).toMatchObject({ ok: false, reason: "tooLarge", limitBytes: 10 * MIB });
    expect(precheckUpload(new File([new Uint8Array([1])], "clipboard", { type: "application/zip" }), CTX)).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });

  it("missing limits skip the size check", () => {
    expect(precheckUpload(fileOfSize("a.mp4", 900 * MIB), { roomBytes: undefined }).ok).toBe(true);
  });
});

describe("precheckMessage", () => {
  const t = (key: string, o?: Record<string, unknown>) => `${key}|${JSON.stringify(o ?? {})}`;

  it("noRoom names the file size and the room left, formatted", () => {
    const f = fileOfSize("a.mp4", 240 * MIB);
    const r = precheckUpload(f, { ...CTX, maxMediaUploadBytes: 500 * MIB, roomBytes: 180 * MIB });
    if (r.ok) throw new Error("expected refusal");
    expect(precheckMessage(f, r, t)).toBe(
      `uploadPrecheck.noRoom|${JSON.stringify({ size: "240 MB", room: "180 MB" })}`,
    );
  });

  it("tooLarge names the size and the limit", () => {
    const f = fileOfSize("a.pdf", 12 * MIB);
    const r = precheckUpload(f, CTX);
    if (r.ok) throw new Error("expected refusal");
    expect(precheckMessage(f, r, t)).toBe(
      `uploadPrecheck.tooLarge|${JSON.stringify({ size: formatBytes(12 * MIB), limit: formatBytes(10 * MIB) })}`,
    );
  });

  it("unsupported has its own message", () => {
    expect(precheckMessage(fileOfSize("a.zip", 1), { ok: false, reason: "unsupported" }, t)).toBe("uploadPrecheck.unsupported|{}");
  });

  it("empty has its own message", () => {
    expect(precheckMessage(fileOfSize("a.txt", 0), { ok: false, reason: "empty" }, t)).toBe("uploadPrecheck.empty|{}");
  });

  it("the English copy renders the documented sentence", async () => {
    const en = (await import("@/i18n/upload-precheck.en.json")).default;
    const f = fileOfSize("a.mp4", 240 * MIB);
    const render = (key: string, o?: Record<string, unknown>) =>
      en.uploadPrecheck.noRoom.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(o?.[k]));
    expect(precheckMessage(f, { ok: false, reason: "noRoom", roomBytes: 180 * MIB }, render)).toBe(
      "This file is 240 MB; this space has 180 MB left.",
    );
  });
});

describe("createPrecheckCtxProvider", () => {
  let qc: QueryClient;
  let usage: { usedBytes: number; quotaBytes: number | null };
  const fetchMock = vi.fn();

  function route(url: string): Response {
    if (url === "/api/auth/config") {
      return Response.json({ maxUploadBytes: 10 * MIB, maxMediaUploadBytes: 100 * MIB });
    }
    if (url === "/api/storage" || url === "/api/groups/g1/storage") return Response.json(usage);
    return Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 });
  }

  beforeEach(() => {
    qc = new QueryClient();
    usage = { usedBytes: 20 * MIB, quotaBytes: 100 * MIB };
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => Promise.resolve(route(url)));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    onlineManager.setOnline(true);
  });

  const urls = () => fetchMock.mock.calls.map((c) => c[0] as string);

  it("returns limits and room from the personal space", async () => {
    const ctx = await createPrecheckCtxProvider(qc, { groupId: null, canViewUsage: true })();
    expect(ctx).toEqual({ maxUploadBytes: 10 * MIB, maxMediaUploadBytes: 100 * MIB, roomBytes: 80 * MIB });
    expect(urls()).toContain("/api/storage");
  });

  it("reads a group note's usage from the group's storage endpoint", async () => {
    const ctx = await createPrecheckCtxProvider(qc, { groupId: "g1", canViewUsage: true })();
    expect(ctx.roomBytes).toBe(80 * MIB);
    expect(urls()).toContain("/api/groups/g1/storage");
    expect(urls()).not.toContain("/api/storage");
    expect(qc.getQueryData(groupStorageKey("g1"))).toBeDefined();
  });

  it("a space with no quota has null room", async () => {
    usage = { usedBytes: 5, quotaBytes: null };
    expect((await createPrecheckCtxProvider(qc, { groupId: null, canViewUsage: true })()).roomBytes).toBeNull();
  });

  it("refetches usage on every call", async () => {
    const provider = createPrecheckCtxProvider(qc, { groupId: null, canViewUsage: true });
    expect((await provider()).roomBytes).toBe(80 * MIB);
    usage = { usedBytes: 90 * MIB, quotaBytes: 100 * MIB };
    expect((await provider()).roomBytes).toBe(10 * MIB);
    expect(urls().filter((u) => u === "/api/storage")).toHaveLength(2);
  });

  it("an over-quota space reports zero room, never a negative number", async () => {
    usage = { usedBytes: 120 * MIB, quotaBytes: 100 * MIB };
    const ctx = await createPrecheckCtxProvider(qc, { groupId: null, canViewUsage: true })();
    expect(ctx.roomBytes).toBe(0);
    const f = fileOfSize("a.pdf", MIB);
    const r = precheckUpload(f, ctx);
    if (r.ok) throw new Error("expected refusal");
    expect(r).toMatchObject({ reason: "noRoom", roomBytes: 0 });
    expect(precheckMessage(f, r, (k, o) => JSON.stringify(o))).toContain('"room":"0 B"');
  });

  it("calls made while a check is running share it (a 20-file drop asks once); a later call asks again", async () => {
    const provider = createPrecheckCtxProvider(qc, { groupId: null, canViewUsage: true });
    const results = await Promise.all(Array.from({ length: 20 }, () => provider()));
    expect(new Set(results).size).toBe(1);
    expect(results[0]!.roomBytes).toBe(80 * MIB);
    expect(urls().filter((u) => u === "/api/auth/config")).toHaveLength(1);
    expect(urls().filter((u) => u === "/api/storage")).toHaveLength(1);
    usage = { usedBytes: 90 * MIB, quotaBytes: 100 * MIB };
    expect((await provider()).roomBytes).toBe(10 * MIB);
    expect(urls().filter((u) => u === "/api/storage")).toHaveLength(2);
  });

  it("limits are refetched on every call", async () => {
    const provider = createPrecheckCtxProvider(qc, { groupId: null, canViewUsage: false });
    expect((await provider()).maxMediaUploadBytes).toBe(100 * MIB);
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === "/api/auth/config" ? Response.json({ maxUploadBytes: 2 * MIB, maxMediaUploadBytes: 20 * MIB }) : route(url),
      ),
    );
    expect(await provider()).toMatchObject({ maxUploadBytes: 2 * MIB, maxMediaUploadBytes: 20 * MIB });
  });

  it("an observer's paused fetch on the same keys does not capture the provider (offline)", async () => {
    onlineManager.setOnline(false);
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("offline")));
    const observers = [AUTH_CONFIG_QUERY_KEY, ["storage"]].map((queryKey) => {
      const o = new QueryObserver(qc, { queryKey, queryFn: () => Promise.reject(new Error("unused")) });
      return o.subscribe(() => {});
    });
    expect(qc.getQueryState(AUTH_CONFIG_QUERY_KEY)?.fetchStatus).toBe("paused");
    try {
      const out = await Promise.race([
        createPrecheckCtxProvider(qc, { groupId: null, canViewUsage: true })(),
        new Promise<"hung">((r) => setTimeout(() => r("hung"), 500)),
      ]);
      expect(out).toMatchObject({ roomBytes: undefined, fetchFailed: true });
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      observers.forEach((u) => u());
    }
  });

  it("an observer's paused usage fetch does not capture the provider when the config fetch succeeds", async () => {
    onlineManager.setOnline(false);
    fetchMock.mockImplementation((url: string) =>
      url.includes("storage") ? Promise.reject(new TypeError("offline")) : Promise.resolve(route(url)),
    );
    const unsubscribe = new QueryObserver(qc, {
      queryKey: ["storage"],
      queryFn: () => Promise.reject(new Error("unused")),
    }).subscribe(() => {});
    expect(qc.getQueryState(["storage"])?.fetchStatus).toBe("paused");
    try {
      const out = await Promise.race([
        createPrecheckCtxProvider(qc, { groupId: null, canViewUsage: true })(),
        new Promise<"hung">((r) => setTimeout(() => r("hung"), 500)),
      ]);
      expect(out).toMatchObject({ maxMediaUploadBytes: 100 * MIB, roomBytes: undefined, fetchFailed: true });
    } finally {
      unsubscribe();
    }
  });

  it("without canViewUsage no usage request is made and room is unknown", async () => {
    const ctx = await createPrecheckCtxProvider(qc, { groupId: null, canViewUsage: false })();
    expect(ctx).toEqual({ maxUploadBytes: 10 * MIB, maxMediaUploadBytes: 100 * MIB, roomBytes: undefined });
    expect(urls().filter((u) => u.includes("storage"))).toHaveLength(0);
  });

  it("a rejecting usage fetch resolves with unknown room and fetchFailed, never rejects", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes("storage") ? Promise.reject(new TypeError("network")) : Promise.resolve(route(url)),
    );
    await expect(createPrecheckCtxProvider(qc, { groupId: null, canViewUsage: true })()).resolves.toEqual({
      maxUploadBytes: 10 * MIB,
      maxMediaUploadBytes: 100 * MIB,
      roomBytes: undefined,
      fetchFailed: true,
    });
  });

  it("a 404 usage response (left the group) also falls back", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes("storage")
        ? Promise.resolve(Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 }))
        : Promise.resolve(route(url)),
    );
    const ctx = await createPrecheckCtxProvider(qc, { groupId: "g1", canViewUsage: true })();
    expect(ctx).toMatchObject({ roomBytes: undefined, fetchFailed: true });
  });

  it("a rejecting auth-config fetch falls back to the cached limits", async () => {
    qc.setQueryData(AUTH_CONFIG_QUERY_KEY, { maxUploadBytes: 5 * MIB, maxMediaUploadBytes: 50 * MIB });
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("network")));
    await expect(createPrecheckCtxProvider(qc, { groupId: null, canViewUsage: true })()).resolves.toEqual({
      maxUploadBytes: 5 * MIB,
      maxMediaUploadBytes: 50 * MIB,
      roomBytes: undefined,
      fetchFailed: true,
    });
  });

  it("while offline it still resolves promptly (the queries are not paused)", async () => {
    onlineManager.setOnline(false);
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("offline")));
    const out = await Promise.race([
      createPrecheckCtxProvider(qc, { groupId: null, canViewUsage: true })(),
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 500)),
    ]);
    expect(out).toMatchObject({ roomBytes: undefined, fetchFailed: true });
  });

  it("a fetch that never answers is cut off by the timeout", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_res, rej) => {
            init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
          }),
      );
      const p = createPrecheckCtxProvider(qc, { groupId: null, canViewUsage: true })();
      await vi.advanceTimersByTimeAsync(10_001);
      await expect(p).resolves.toMatchObject({ roomBytes: undefined, fetchFailed: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
