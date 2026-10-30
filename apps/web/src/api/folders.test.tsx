import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { FolderDeleteResultDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { folderDto, groupFolder } from "@/test/folder-fixtures";
import { ApiFail } from "./client";
import {
  createFolderRequest,
  FOLDERS_QUERY_KEY,
  folderErrorMessage,
  renameFolderRequest,
  useCreateFolder,
  useDeleteFolder,
  useFolders,
  useRenameFolder,
} from "./folders";

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as unknown as Response;
}

/** 記錄每次呼叫的 method/url/raw body，依表分派回應；未列的 throw（慣例）。 */
function stubFetch(routes: Record<string, () => Response>) {
  const calls: Array<{ method: string; url: string; body: string | undefined }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: typeof init?.body === "string" ? init.body : undefined });
      const handler = routes[`${method} ${url}`];
      if (!handler) throw new Error(`unexpected fetch: ${method} ${url}`);
      return Promise.resolve(handler());
    }),
  );
  return calls;
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const keysOf = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([arg]) => JSON.stringify((arg as { queryKey?: unknown } | undefined)?.queryKey));

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);
const FAIL = () => fakeResponse(409, { error: { code: "folder_name_taken", message: "taken" } });

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
});

describe("api/folders", () => {
  it("FA1 useFolders 打 GET /api/folders、回 .folders，key 是 ['folders']", async () => {
    const folders = [folderDto({ id: "f1", name: "A" })];
    const calls = stubFetch({ "GET /api/folders": () => fakeResponse(200, { folders }) });
    const queryClient = client();
    const { result } = renderHook(() => useFolders(), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(result.current.data).toEqual(folders));
    expect(calls).toEqual([{ method: "GET", url: "/api/folders", body: undefined }]);
    expect(queryClient.getQueryData(FOLDERS_QUERY_KEY)).toEqual(folders);
  });

  it("FA2 createFolderRequest：根層帶 space、子資料夾帶 parentId，body 逐字", async () => {
    const created = groupFolder({ id: "gf", name: "Reports", groupId: "g1" });
    const calls = stubFetch({ "POST /api/folders": () => fakeResponse(201, created) });
    await expect(createFolderRequest({ name: "Reports", space: { kind: "group", groupId: "g1" } })).resolves.toEqual(created);
    await createFolderRequest({ name: "Weekly", parentId: "gf" });
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ name: "Reports", space: { kind: "group", groupId: "g1" } });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ name: "Weekly", parentId: "gf" });
  });

  it("FA3 renameFolderRequest(\"f1\", \"B\") → PATCH /api/folders/f1 body {\"name\":\"B\"}", async () => {
    const calls = stubFetch({ "PATCH /api/folders/f1": () => fakeResponse(200, folderDto({ id: "f1", name: "B" })) });
    await renameFolderRequest("f1", "B");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe("/api/folders/f1");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ name: "B" });
  });

  it("FA4 useCreateFolder 成功後失效 ['folders']、['notes']，不失效 ['trash']", async () => {
    stubFetch({ "POST /api/folders": () => fakeResponse(201, folderDto({ id: "f1", name: "A" })) });
    const queryClient = client();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useCreateFolder(), { wrapper: wrapper(queryClient) });
    await result.current.mutateAsync({ name: "A", space: { kind: "personal" } });
    const keys = keysOf(spy);
    expect(keys).toContain('["folders"]');
    expect(keys).toContain('["notes"]');
    expect(keys).not.toContain('["trash"]');
  });

  it("FA5 useRenameFolder／useDeleteFolder 成功與失敗後都失效 ['folders']、['notes']、['trash']", async () => {
    const deleted: FolderDeleteResultDto = { trashedNoteIds: [], deletedFolderIds: ["ok"] };
    stubFetch({
      "PATCH /api/folders/ok": () => fakeResponse(200, folderDto({ id: "ok", name: "B" })),
      "PATCH /api/folders/bad": FAIL,
      "DELETE /api/folders/ok": () => fakeResponse(200, deleted),
      "DELETE /api/folders/bad": FAIL,
    });
    const expectAll = (keys: string[]) => {
      expect(keys).toContain('["folders"]');
      expect(keys).toContain('["notes"]');
      expect(keys).toContain('["trash"]');
    };
    const cases: Array<[string, (qc: QueryClient) => Promise<unknown>]> = [
      ["rename ok", (qc) => renderHook(() => useRenameFolder(), { wrapper: wrapper(qc) }).result.current.mutateAsync({ id: "ok", name: "B" })],
      ["rename bad", (qc) => renderHook(() => useRenameFolder(), { wrapper: wrapper(qc) }).result.current.mutateAsync({ id: "bad", name: "B" })],
      ["delete ok", (qc) => renderHook(() => useDeleteFolder(), { wrapper: wrapper(qc) }).result.current.mutateAsync("ok")],
      ["delete bad", (qc) => renderHook(() => useDeleteFolder(), { wrapper: wrapper(qc) }).result.current.mutateAsync("bad")],
    ];
    for (const [name, run] of cases) {
      const queryClient = client();
      const spy = vi.spyOn(queryClient, "invalidateQueries");
      await run(queryClient).catch(() => undefined);
      await waitFor(() => expect(keysOf(spy), name).toContain('["trash"]'));
      expectAll(keysOf(spy));
    }
  });

  it("FA6 useDeleteFolder 成功後失效每個 trashedNoteIds 的 ['note', id] 與 ['backlinks']", async () => {
    const deleted: FolderDeleteResultDto = { trashedNoteIds: ["n1", "n2"], deletedFolderIds: ["f1", "f2"] };
    stubFetch({ "DELETE /api/folders/f1": () => fakeResponse(200, deleted) });
    const queryClient = client();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useDeleteFolder(), { wrapper: wrapper(queryClient) });
    await expect(result.current.mutateAsync("f1")).resolves.toEqual(deleted);
    const keys = keysOf(spy);
    expect(keys).toContain('["note","n1"]');
    expect(keys).toContain('["note","n2"]');
    expect(keys).toContain('["backlinks"]');
  });

  it("FA7 folderErrorMessage：folder_too_deep 帶 max（不含 {{max}}）、zh；folder_not_found 逐字；非 ApiFail → fallback", async () => {
    expect(folderErrorMessage(t, new ApiFail(409, "folder_too_deep", ""))).toBe("Folders can be at most 5 levels deep.");
    expect(folderErrorMessage(t, new ApiFail(404, "folder_not_found", ""))).toBe("Folder not found.");
    expect(folderErrorMessage(t, new Error("network"))).toBe("An unexpected error occurred.");
    // ApiFail 帶沒有翻譯的 code → fallback（defaultValue）
    expect(folderErrorMessage(t, new ApiFail(500, "weird_unknown_code", ""))).toBe("An unexpected error occurred.");
    await i18n.changeLanguage("zh-TW");
    expect(folderErrorMessage(t, new ApiFail(409, "folder_too_deep", ""))).toBe("資料夾最多 5 層。");
  });
});
