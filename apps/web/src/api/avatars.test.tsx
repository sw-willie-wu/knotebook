import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AvatarCandidateDto, AvatarListDto, UserDto } from "@knotebook/shared";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { ApiFail } from "./client";
import { STORAGE_USAGE_QUERY_KEY } from "./storage";
import {
  AVATARS_QUERY_KEY,
  fetchAvatarOriginal,
  useAvatars,
  useDeleteAvatar,
  useSelectAvatar,
  useUpdateAvatarDisplay,
  useUploadAvatar,
} from "./avatars";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function candidate(over: Partial<AvatarCandidateDto> = {}): AvatarCandidateDto {
  return {
    id: ID,
    source: "upload",
    providerName: null,
    avatar: { id: ID, v: 1 },
    pending: false,
    current: false,
    crop: { x: 0, y: 0, size: 100 },
    originalWidth: 100,
    originalHeight: 100,
    originalSize: 10,
    displaySize: 5,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function user(over: Partial<UserDto> = {}): UserDto {
  return { id: "u1", displayName: "alice", avatar: null, ...over } as UserDto;
}

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
}

interface Call {
  method: string;
  url: string;
  body: BodyInit | null | undefined;
  credentials: RequestCredentials | undefined;
}

function stubFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: (init?.method ?? "GET").toUpperCase(),
        url: String(input),
        body: init?.body,
        credentials: init?.credentials,
      };
      calls.push(call);
      return Promise.resolve(respond(call));
    }),
  );
  return calls;
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
  return { qc, invalidate, wrapper };
}

function invalidatedKeys(spy: ReturnType<typeof setup>["invalidate"]): unknown[] {
  return spy.mock.calls.map(c => (c[0] as { queryKey?: unknown }).queryKey);
}

const CROP = { x: 4, y: 8, size: 64 };
const DISPLAY = new Blob(["d"], { type: "image/webp" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useAvatars", () => {
  it("GET /api/auth/avatars，快取鍵是 AVATARS_QUERY_KEY", async () => {
    const list: AvatarListDto = { candidates: [candidate()], auto: true, refreshable: [] };
    const calls = stubFetch(() => json(200, list));
    const { qc, wrapper } = setup();
    const { result } = renderHook(() => useAvatars(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(list));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: "/api/auth/avatars" });
    expect(AVATARS_QUERY_KEY).toEqual(["avatars"]);
    expect(qc.getQueryData(AVATARS_QUERY_KEY)).toEqual(list);
  });
});

describe("useUploadAvatar", () => {
  it("POST /api/auth/avatars：FormData 的 original、display（display.webp）、crop（JSON 字串），不補 Content-Type", async () => {
    const calls = stubFetch(() => json(201, candidate()));
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useUploadAvatar(), { wrapper });
    const original = new File(["orig"], "me.png", { type: "image/png" });
    let created: AvatarCandidateDto | undefined;
    await act(async () => {
      created = await result.current.mutateAsync({ original, display: DISPLAY, crop: CROP });
    });
    expect(created).toEqual(candidate());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/auth/avatars", credentials: "include" });
    const form = calls[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect([...form.keys()].sort()).toEqual(["crop", "display", "original"]);
    expect((form.get("original") as File).name).toBe("me.png");
    expect(form.get("original")).toBeInstanceOf(Blob);
    expect((form.get("display") as File).name).toBe("display.webp");
    expect((form.get("display") as File).type).toBe("image/webp");
    expect(JSON.parse(form.get("crop") as string)).toEqual(CROP);
    expect(invalidatedKeys(invalidate)).toEqual(expect.arrayContaining([AVATARS_QUERY_KEY, SESSION_QUERY_KEY, STORAGE_USAGE_QUERY_KEY]));
  });

  it("顯示圖是 JPEG 時檔名用 display.jpg", async () => {
    const calls = stubFetch(() => json(201, candidate()));
    const { wrapper } = setup();
    const { result } = renderHook(() => useUploadAvatar(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        original: new Blob(["o"], { type: "image/png" }),
        display: new Blob(["d"], { type: "image/jpeg" }),
        crop: CROP,
      });
    });
    const form = calls[0]!.body as FormData;
    expect((form.get("display") as File).name).toBe("display.jpg");
  });

  it("失敗丟 ApiFail，code 是 server 給的，且不失效任何鍵", async () => {
    stubFetch(() => json(409, { error: { code: "storage_quota_exceeded", message: "full" }, storage: { incomingBytes: 5 } }));
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useUploadAvatar(), { wrapper });
    let caught: unknown;
    await act(async () => {
      caught = await result.current.mutateAsync({ original: new Blob(["o"]), display: DISPLAY, crop: CROP }).catch(e => e);
    });
    expect(caught).toBeInstanceOf(ApiFail);
    expect(caught).toMatchObject({ status: 409, code: "storage_quota_exceeded" });
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("useUpdateAvatarDisplay", () => {
  it("PUT /api/auth/avatars/:id/display：display、crop、version 三欄", async () => {
    const calls = stubFetch(() => json(200, candidate({ avatar: { id: ID, v: 2 } })));
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useUpdateAvatarDisplay(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: ID, display: DISPLAY, crop: CROP, version: 7 });
    });
    expect(calls[0]).toMatchObject({ method: "PUT", url: `/api/auth/avatars/${ID}/display` });
    const form = calls[0]!.body as FormData;
    expect([...form.keys()].sort()).toEqual(["crop", "display", "version"]);
    expect(form.get("version")).toBe("7");
    expect(JSON.parse(form.get("crop") as string)).toEqual(CROP);
    expect((form.get("display") as File).name).toBe("display.webp");
    expect(invalidatedKeys(invalidate)).toEqual(expect.arrayContaining([AVATARS_QUERY_KEY, SESSION_QUERY_KEY, STORAGE_USAGE_QUERY_KEY]));
  });

  it("avatar_outdated 丟 ApiFail 並帶 code", async () => {
    stubFetch(() => json(409, { error: { code: "avatar_outdated", message: "old" } }));
    const { wrapper } = setup();
    const { result } = renderHook(() => useUpdateAvatarDisplay(), { wrapper });
    let caught: unknown;
    await act(async () => {
      caught = await result.current.mutateAsync({ id: ID, display: DISPLAY, crop: CROP, version: 1 }).catch(e => e);
    });
    expect(caught).toMatchObject({ status: 409, code: "avatar_outdated" });
  });
});

describe("useSelectAvatar", () => {
  it("PUT /api/auth/avatar 送 { candidateId }；成功後 session 快取的 avatar 立刻是新值，三個鍵都失效", async () => {
    const next = user({ avatar: { id: ID, v: 3, pending: false } });
    const calls = stubFetch(() => json(200, next));
    const { qc, invalidate, wrapper } = setup();
    qc.setQueryData(SESSION_QUERY_KEY, user());
    const { result } = renderHook(() => useSelectAvatar(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(ID);
    });
    expect(calls[0]).toMatchObject({ method: "PUT", url: "/api/auth/avatar" });
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ candidateId: ID });
    expect(qc.getQueryData<UserDto>(SESSION_QUERY_KEY)?.avatar).toEqual({ id: ID, v: 3, pending: false });
    expect(invalidatedKeys(invalidate)).toEqual(expect.arrayContaining([AVATARS_QUERY_KEY, SESSION_QUERY_KEY, STORAGE_USAGE_QUERY_KEY]));
  });

  it("candidateId 為 null（不使用頭貼）送 null，session 的 avatar 變 null", async () => {
    const calls = stubFetch(() => json(200, user({ avatar: null })));
    const { qc, wrapper } = setup();
    qc.setQueryData(SESSION_QUERY_KEY, user({ avatar: { id: ID, v: 3, pending: false } }));
    const { result } = renderHook(() => useSelectAvatar(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(null);
    });
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ candidateId: null });
    expect(qc.getQueryData<UserDto>(SESSION_QUERY_KEY)?.avatar).toBeNull();
  });

  it("404 丟 ApiFail，session 快取不動", async () => {
    stubFetch(() => json(404, { error: { code: "not_found", message: "gone" } }));
    const { qc, wrapper } = setup();
    const before = user({ avatar: { id: ID, v: 1, pending: false } });
    qc.setQueryData(SESSION_QUERY_KEY, before);
    const { result } = renderHook(() => useSelectAvatar(), { wrapper });
    let caught: unknown;
    await act(async () => {
      caught = await result.current.mutateAsync(ID).catch(e => e);
    });
    expect(caught).toMatchObject({ status: 404, code: "not_found" });
    expect(qc.getQueryData(SESSION_QUERY_KEY)).toEqual(before);
  });
});

describe("useDeleteAvatar", () => {
  it("DELETE /api/auth/avatars/:id，三個鍵都失效", async () => {
    const calls = stubFetch(() => json(204));
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useDeleteAvatar(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(ID);
    });
    expect(calls[0]).toMatchObject({ method: "DELETE", url: `/api/auth/avatars/${ID}` });
    expect(invalidatedKeys(invalidate)).toEqual(expect.arrayContaining([AVATARS_QUERY_KEY, SESSION_QUERY_KEY, STORAGE_USAGE_QUERY_KEY]));
  });

  it("失敗丟 ApiFail", async () => {
    stubFetch(() => json(409, { error: { code: "server_busy", message: "busy" } }));
    const { wrapper } = setup();
    const { result } = renderHook(() => useDeleteAvatar(), { wrapper });
    let caught: unknown;
    await act(async () => {
      caught = await result.current.mutateAsync(ID).catch(e => e);
    });
    expect(caught).toMatchObject({ code: "server_busy" });
  });
});

describe("fetchAvatarOriginal", () => {
  it("GET /api/auth/avatars/:id/original 帶 cookie，回 Blob", async () => {
    const calls = stubFetch(() => new Response("png-bytes", { status: 200, headers: { "content-type": "image/png" } }));
    const blob = await fetchAvatarOriginal(ID);
    expect(calls[0]).toMatchObject({ method: "GET", url: `/api/auth/avatars/${ID}/original`, credentials: "include" });
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe("png-bytes");
  });

  it("非 2xx 丟 ApiFail，code 取自 server", async () => {
    stubFetch(() => json(404, { error: { code: "not_found", message: "gone" } }));
    await expect(fetchAvatarOriginal(ID)).rejects.toMatchObject({ name: "ApiFail", status: 404, code: "not_found" });
  });

  it("非 2xx 且 body 不是約定的錯誤形：退回 internal", async () => {
    stubFetch(() => new Response("<html>", { status: 502 }));
    const err = await fetchAvatarOriginal(ID).catch(e => e);
    expect(err).toBeInstanceOf(ApiFail);
    expect(err).toMatchObject({ status: 502, code: "internal" });
  });
});
