import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UserDto } from "@knotebook/shared";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { AvatarDisplayFiller } from "./AvatarDisplayFiller";
import { enqueueFill, registerCropOpen, resetFiller } from "./display-filler";

vi.mock("./encode", () => ({
  decodeImage: async () => ({ width: 600, height: 400, close: () => undefined }),
  renderDisplay: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }),
}));

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function user(avatar: UserDto["avatar"]): UserDto {
  return {
    id: "u-alice",
    email: "alice@example.com",
    handle: "alice",
    displayName: "Alice",
    isAdmin: false,
    mustChangePassword: false,
    hasPassword: true,
    autoVersions: true,
    avatar,
  };
}

interface Call {
  method: string;
  url: string;
}

function setup(avatar: UserDto["avatar"], putResponse?: (url: string) => Response | undefined, userId = "u-alice") {
  const calls: Call[] = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { method: (init?.method ?? "GET").toUpperCase(), url: String(input) };
      calls.push(call);
      if (call.url === `/api/auth/avatars/${ID}/original`) {
        return new Response(new Uint8Array([9, 9]), { status: 200, headers: { "content-type": "image/png" } });
      }
      const custom = call.method === "PUT" ? putResponse?.(call.url) : undefined;
      if (custom) return custom;
      if (call.url.endsWith("/original")) {
        return new Response(new Uint8Array([9, 9]), { status: 200, headers: { "content-type": "image/png" } });
      }
      if (call.url.endsWith("/display") && call.method === "PUT") {
        return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(queryClient.getQueryData(SESSION_QUERY_KEY) ?? user(avatar)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  queryClient.setQueryData(SESSION_QUERY_KEY, { ...user(avatar), id: userId });
  const ui = (
    <QueryClientProvider client={queryClient}>
      <AvatarDisplayFiller />
    </QueryClientProvider>
  );
  return { calls, ui, queryClient };
}

const originals = (calls: Call[]) => calls.filter(c => c.url.endsWith("/original"));
const puts = (calls: Call[]) => calls.filter(c => c.method === "PUT");
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 80));

describe("AvatarDisplayFiller", () => {
  beforeEach(() => resetFiller());
  afterEach(() => {
    cleanup();
    resetFiller();
    vi.unstubAllGlobals();
  });

  it("不渲染任何節點", () => {
    const { ui } = setup(null);
    const { container } = render(ui);
    expect(container).toBeEmptyDOMElement();
  });

  it("目前頭貼待補（pending）→ 讀原圖並帶版本把顯示圖送回", async () => {
    const { calls, ui } = setup({ id: ID, v: 4, pending: true });
    render(ui);
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(originals(calls)).toHaveLength(1);
  });

  it.each([
    ["pending 為 false", { id: ID, v: 4, pending: false }],
    ["沒有頭貼（null）", null],
  ] as const)("%s → 什麼都不做", async (_name, avatar) => {
    const { calls, ui } = setup(avatar);
    render(ui);
    await settle();
    expect(originals(calls)).toHaveLength(0);
    expect(puts(calls)).toHaveLength(0);
  });

  it("換頁重掛（卸載再掛載）後，同一版不再重送", async () => {
    const { calls, ui } = setup({ id: ID, v: 4, pending: true });
    const first = render(ui);
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    first.unmount();
    render(ui);
    await settle();
    expect(originals(calls)).toHaveLength(1);
    expect(puts(calls)).toHaveLength(1);
  });

  it("換了使用者（同一分頁）：前一位的處理記憶作廢，同一組 (id, v) 對新使用者重新處理", async () => {
    const { calls, ui, queryClient } = setup({ id: ID, v: 4, pending: true });
    render(ui);
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    await settle();
    // 寫入成功後失效的重抓先落地，免得它蓋掉下面換人的資料。
    await act(async () => {
      queryClient.setQueryData(SESSION_QUERY_KEY, { ...user(null), id: "u-bob" });
      await settle(); // react-query 的通知排在下一個 tick，等畫面與 effect 跟上
    });
    // 記憶已清：同一組 (id, v) 可以再排（新使用者不會繼承前一位的「已處理」）。
    enqueueFill({ id: ID, v: 4 });
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
  });

  it("同一個使用者重新載入（id 不變）不清記憶", async () => {
    const { calls, ui, queryClient } = setup({ id: ID, v: 4, pending: true });
    render(ui);
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    act(() => {
      queryClient.setQueryData(SESSION_QUERY_KEY, { ...user({ id: ID, v: 4, pending: true }), displayName: "Alice B" });
    });
    await settle();
    expect(puts(calls)).toHaveLength(1);
  });

  it("版本過期（409 avatar_outdated）只重抓、不當成寫入：因空間不足失敗的項目不被重排", async () => {
    const OTHER = "1a2b3c4d-d9cb-469f-a165-70867728950f";
    const { calls, ui, queryClient } = setup(null, url =>
      url.includes(ID)
        ? new Response(JSON.stringify({ error: { code: "storage_quota_exceeded", message: "full" } }), { status: 409, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { code: "avatar_outdated", message: "old" } }), { status: 409, headers: { "content-type": "application/json" } }),
    );
    render(ui);
    (await import("./filler-runtime")).configureForClient(queryClient);
    enqueueFill({ id: ID, v: 1 });
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    enqueueFill({ id: OTHER, v: 1 });
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    await settle();
    expect(originals(calls).filter(c => c.url.includes(ID))).toHaveLength(1);
    expect(puts(calls)).toHaveLength(2);
  });

  it("登出（外殼卸載）後另一位登入：前一位排隊中的項目不會被處理", async () => {
    const alice = setup(null);
    const first = render(alice.ui);
    await settle();
    (await import("./filler-runtime")).configureForClient(alice.queryClient); // 補產已載入、可以處理
    const release = registerCropOpen(ID); // 讓 alice 的項目停在佇列裡
    enqueueFill({ id: ID, v: 1 });
    first.unmount();
    const bob = setup(null, undefined, "u-bob");
    render(bob.ui);
    await settle();
    release();
    await settle();
    expect(originals(alice.calls)).toHaveLength(0);
    expect(originals(bob.calls)).toHaveLength(0);
  });
});
