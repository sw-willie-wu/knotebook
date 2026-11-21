import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { KnowledgeIndexDto, KnowledgeIndexScopeRef } from "@knotebook/shared";
import { knowledgeIndexApiPath, knowledgeIndexKey, useKnowledgeIndex, type IndexQueryFilters } from "./knowledge";

const NONE: IndexQueryFilters = { tagIds: [], status: null, evidence: null };

function dto(over: Partial<KnowledgeIndexDto> = {}): KnowledgeIndexDto {
  return {
    scope: { kind: "personal", groupId: null, groupName: null, folderId: null, folderPath: [] },
    folders: [],
    notes: [],
    entries: [],
    replacements: {},
    tagOptions: [],
    truncated: false,
    backfillPending: false,
    ...over,
  };
}

function fakeResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      return Promise.resolve(handler(url));
    }),
  );
  return urls;
}

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("knowledgeIndexApiPath", () => {
  it("puts tags, status and evidence in the query only when set, tags comma-joined in the given order", () => {
    expect(knowledgeIndexApiPath({ kind: "personal" }, NONE)).toBe("/api/knowledge/index/me");
    expect(knowledgeIndexApiPath({ kind: "group", groupId: "g1" }, NONE)).toBe("/api/knowledge/index/groups/g1");
    expect(knowledgeIndexApiPath({ kind: "folder", folderId: "f/1" }, NONE)).toBe("/api/knowledge/index/folders/f%2F1");
    expect(knowledgeIndexApiPath({ kind: "personal" }, { tagIds: ["b", "a"], status: "outdated", evidence: "tested" })).toBe(
      "/api/knowledge/index/me?tags=b%2Ca&status=outdated&evidence=tested",
    );
    expect(knowledgeIndexApiPath({ kind: "personal" }, { tagIds: [], status: "needsReview", evidence: null })).toBe(
      "/api/knowledge/index/me?status=needsReview",
    );
  });

  it("knowledgeIndexKey differs by scope and by each filter", () => {
    const base = knowledgeIndexKey({ kind: "personal" }, NONE);
    expect(knowledgeIndexKey({ kind: "personal" }, NONE)).toEqual(base);
    expect(knowledgeIndexKey({ kind: "group", groupId: "g1" }, NONE)).not.toEqual(base);
    expect(knowledgeIndexKey({ kind: "personal" }, { ...NONE, status: "outdated" })).not.toEqual(base);
    expect(knowledgeIndexKey({ kind: "personal" }, { ...NONE, tagIds: ["a"] })).not.toEqual(base);
    expect(knowledgeIndexKey({ kind: "personal" }, { ...NONE, evidence: "docs" })).not.toEqual(base);
  });
});

describe("useKnowledgeIndex", () => {
  it("keeps the previous data while only the filters change, but not when the scope changes", async () => {
    let release!: (r: Response) => void;
    const slow = new Promise<Response>((res) => {
      release = res;
    });
    stubFetch((url) => (url.includes("status=outdated") || url.includes("/groups/") ? slow : fakeResponse(dto({ truncated: true }))));
    const { result, rerender } = renderHook(
      ({ scope, filters }: { scope: KnowledgeIndexScopeRef; filters: IndexQueryFilters }) => useKnowledgeIndex(scope, filters),
      { wrapper: wrapper(), initialProps: { scope: { kind: "personal" } as KnowledgeIndexScopeRef, filters: NONE } },
    );
    await waitFor(() => expect(result.current.data?.truncated).toBe(true));

    rerender({ scope: { kind: "personal" }, filters: { tagIds: [], status: "outdated", evidence: null } });
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.truncated).toBe(true);

    rerender({ scope: { kind: "group", groupId: "g1" }, filters: NONE });
    expect(result.current.data).toBeUndefined();
    release(fakeResponse(dto()));
  });

  it("does not retry a 404, but retries other failures with the client default", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 2, retryDelay: 1 } } });
    const wrap = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const failing = (status: number) =>
      ({ ok: false, status, json: () => Promise.resolve({ error: { code: status === 404 ? "not_found" : "internal", message: "x" } }) }) as unknown as Response;

    const notFound = stubFetch(() => failing(404));
    const first = renderHook(() => useKnowledgeIndex({ kind: "folder", folderId: "f1" }, NONE), { wrapper: wrap });
    await waitFor(() => expect(first.result.current.isError).toBe(true));
    expect(notFound).toHaveLength(1);

    const broken = stubFetch(() => failing(500));
    const second = renderHook(() => useKnowledgeIndex({ kind: "folder", folderId: "f2" }, NONE), { wrapper: wrap });
    await waitFor(() => expect(second.result.current.isError).toBe(true));
    expect(broken).toHaveLength(3);
  });

  it("refetches every 10 s while backfillPending is true and stops when it turns false", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    const urls = stubFetch(() => {
      n += 1;
      return fakeResponse(dto({ backfillPending: n < 3 }));
    });
    const { result } = renderHook(() => useKnowledgeIndex({ kind: "personal" }, NONE), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.backfillPending).toBe(true));
    expect(urls).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await waitFor(() => expect(urls).toHaveLength(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await waitFor(() => expect(result.current.data?.backfillPending).toBe(false));
    expect(urls).toHaveLength(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(urls).toHaveLength(3);
  });
});
