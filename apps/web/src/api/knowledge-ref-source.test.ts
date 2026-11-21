import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRemoteKnowledgeRefSource } from "./knowledge-ref-source";

const NOTE = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";

const dto = (over: Record<string, unknown> = {}) => ({
  noteId: OTHER,
  noteTitle: "Other note",
  path: "/n/alice/other-note",
  knowledgeId: "k_0000000f",
  blockId: "blk-1",
  heading: "Elsewhere",
  conclusion: "use it",
  ...over,
});

function reply(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response;
}
const notFound = () => reply(404, { error: { code: "not_found", message: "No such knowledge." } });

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(String(input));
      return Promise.resolve(handler(String(input), init));
    }),
  );
  return calls;
}

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createRemoteKnowledgeRefSource", () => {
  it("search with blank text makes no request and returns []", async () => {
    const calls = stubFetch(() => reply(200, { candidates: [] }));
    expect(await createRemoteKnowledgeRefSource(NOTE).search("   ")).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("search sends q and excludeNote and maps candidates to noteId#knowledgeId refs with path#b-blockId hrefs", async () => {
    const calls = stubFetch(() => reply(200, { candidates: [dto()] }));
    const found = await createRemoteKnowledgeRefSource(NOTE).search(" alpha & beta ");
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!, "http://x");
    expect(url.pathname).toBe("/api/knowledge/refs");
    expect(url.searchParams.get("q")).toBe("alpha & beta");
    expect(url.searchParams.get("excludeNote")).toBe(NOTE);
    expect(found).toEqual([
      { ref: `${OTHER}#k_0000000f`, noteId: OTHER, noteTitle: "Other note", blockId: "blk-1", heading: "Elsewhere", conclusion: "use it", href: "/n/alice/other-note#b-blk-1" },
    ]);
  });

  it("resolve returns null without a request for a bare id or the current note's ref", async () => {
    const calls = stubFetch(() => reply(200, dto()));
    const source = createRemoteKnowledgeRefSource(NOTE);
    expect(await source.resolve("k_0000000f")).toBeNull();
    expect(await source.resolve(`${NOTE.toUpperCase()}#k_0000000f`)).toBeNull();
    expect(await source.resolve("not a ref")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("resolve maps a 404 to null and caches a hit for 60 s; a failed request isn't cached", async () => {
    let n = 0;
    const calls = stubFetch(() => {
      n += 1;
      if (n === 1) return reply(500, { error: { code: "internal", message: "boom" } });
      if (n === 2) return reply(200, dto());
      return reply(200, dto({ heading: "Renamed" }));
    });
    const source = createRemoteKnowledgeRefSource(NOTE);
    const ref = `${OTHER}#k_0000000f`;
    await expect(source.resolve(ref)).rejects.toMatchObject({ status: 500 });
    expect((await source.resolve(ref))?.heading).toBe("Elsewhere");
    expect((await source.resolve(ref))?.heading).toBe("Elsewhere");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(`/api/knowledge/refs/${OTHER}/k_0000000f`);
    vi.setSystemTime(Date.now() + 61_000);
    expect((await source.resolve(ref))?.heading).toBe("Renamed");
    expect(calls).toHaveLength(3);
  });

  it("resolve maps a 404 to null", async () => {
    stubFetch(() => notFound());
    expect(await createRemoteKnowledgeRefSource(NOTE).resolve(`${OTHER}#k_0000000f`)).toBeNull();
  });

  it("an aborted search rejects with AbortError", async () => {
    stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const abort = new AbortController();
    const pending = createRemoteKnowledgeRefSource(NOTE).search("alpha", abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("one caller giving up on a resolve doesn't cancel it for the others", async () => {
    const calls = stubFetch(() => reply(200, dto()));
    const source = createRemoteKnowledgeRefSource(NOTE);
    const ref = `${OTHER}#k_0000000f`;
    const abort = new AbortController();
    const first = source.resolve(ref, abort.signal);
    abort.abort();
    expect((await source.resolve(ref))?.heading).toBe("Elsewhere");
    await first;
    expect(calls).toHaveLength(1);
  });
});
