import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SiteLimitsDto } from "@knotebook/shared";
import { AUTH_CONFIG_QUERY_KEY } from "./authConfig";
import { SITE_LIMITS_QUERY_KEY, useSiteLimits, useUpdateSiteLimits } from "./siteLimits";

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as unknown as Response;
}

function stubFetch(routes: Record<string, () => Response>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const route = routes[`${method} ${url}`];
      if (!route) throw new Error(`unexpected fetch: ${method} ${url}`);
      return Promise.resolve(route());
    }),
  );
  return calls;
}

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
}

const dto = (rateEdit: number, stored: number | null): SiteLimitsDto => ({
  items: [{ key: "rateEdit", value: rateEdit, source: stored === null ? "default" : "admin", locked: false, stored }],
  machine: { cpus: 4, cpuSource: "os", memoryBytes: 8 * 1024 ** 3, memorySource: "os" },
  changes: [],
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("站台限制 API hooks", () => {
  it("GET /api/admin/limits；PATCH 成功後 cache 是回傳值，並失效 ['auth-config']", async () => {
    const calls = stubFetch({
      "GET /api/admin/limits": () => fakeResponse(200, dto(30, null)),
      "PATCH /api/admin/limits": () => fakeResponse(200, dto(10, 10)),
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const read = renderHook(() => useSiteLimits(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(read.result.current.data).toEqual(dto(30, null)));
    const spy = vi.spyOn(qc, "invalidateQueries");
    const write = renderHook(() => useUpdateSiteLimits(), { wrapper: wrapper(qc) });
    await write.result.current.mutateAsync({ set: { rateEdit: 10 } });
    expect(calls.at(-1)).toEqual({ method: "PATCH", url: "/api/admin/limits", body: { set: { rateEdit: 10 } } });
    expect(qc.getQueryData(SITE_LIMITS_QUERY_KEY)).toEqual(dto(10, 10));
    expect(spy).toHaveBeenCalledWith({ queryKey: AUTH_CONFIG_QUERY_KEY });
  });
});
