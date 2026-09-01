import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteDto, ShareDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { ShareDialog } from "./ShareDialog";

// 同一套約定：mock 全域 fetch，讓真正的 useShares/usePutShare/useDeleteShare/useUpdateNote
// （react-query）打到假回應，不 mock hook 本身——見 NoteList.test.tsx/TitleInput.test.tsx 的說明。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "My Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
};

const SHARE: ShareDto = {
  userId: "22222222-2222-2222-2222-222222222222",
  email: "bob@example.com",
  displayName: "Bob",
  role: "viewer",
};

const SHARES_URL = `/api/notes/${NOTE.id}/shares`;

function renderDialog(note: NoteDto = NOTE, cacheRef = NOTE.id) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 每次都建新的 element（不能重用同一個物件——element identity 相同時 React 會
  // 直接 bail out，根本不會 re-render，測不到「re-render 時發生什麼」）。
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <ShareDialog note={note} cacheRef={cacheRef} />
      <Toaster />
    </QueryClientProvider>
  );
  const view = render(tree());
  return Object.assign(queryClient, { rerender: () => view.rerender(tree()) });
}

async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  await waitFor(() => expect(screen.getByText("People with access")).toBeInTheDocument());
}

describe("ShareDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.history.replaceState(null, "", `/notes/${NOTE.id}`);
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("非 owner（editor/viewer）不渲染分享鈕與 dialog", () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("should not fetch")));
    vi.stubGlobal("fetch", fetchMock);

    renderDialog({ ...NOTE, role: "editor" });

    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("owner 看得到分享鈕，點開後渲染 dialog", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) })),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    // PR3：分享 icon 鈕跟主題色（N7——class 必須落在 Button 本身，不是掛在 icon 上）。
    expect(screen.getByRole("button", { name: "Share" })).toHaveClass("text-brand", "hover:text-brand");

    await openDialog();
    expect(screen.getByRole("heading", { name: "Share note" })).toBeInTheDocument();
  });

  it("輸入保留字 'New' → 立即顯示保留字錯誤（shared validateSlug，不打網路）", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();

    const slugInput = screen.getByRole("textbox", { name: "Custom link" });
    fireEvent.change(slugInput, { target: { value: "New" } });

    await waitFor(() =>
      expect(screen.getByText("This word is reserved and can't be used.")).toBeInTheDocument(),
    );
    // 開 dialog 的兩次 GET（shares＋public-link，#72 起）；驗證錯誤純本地計算，沒有因輸入多打任何請求。
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Save 鈕在本地驗證失敗時應被停用，點了也不該送出。
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("PATCH 回 409 slug_taken → 顯示對應文案", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === `/api/notes/${NOTE.id}` && method === "PATCH") {
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: 409,
            json: () => Promise.resolve({ error: { code: "slug_taken", message: "taken" } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();

    const slugInput = screen.getByRole("textbox", { name: "Custom link" });
    fireEvent.change(slugInput, { target: { value: "taken-slug" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("That URL is already taken.")).toBeInTheDocument());
  });

  it("PATCH 回 429 too_many_requests → 顯示稍後再試文案", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === `/api/notes/${NOTE.id}` && method === "PATCH") {
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: 429,
            json: () => Promise.resolve({ error: { code: "too_many_requests", message: "slow down" } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();

    const slugInput = screen.getByRole("textbox", { name: "Custom link" });
    fireEvent.change(slugInput, { target: { value: "some-slug" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("Too many requests. Please slow down.")).toBeInTheDocument());
  });

  it("成功變更 slug → 寫回本頁 ['note', id] 快取，且**不自己動網址**（A3：收斂交 NotePage effect）", async () => {
    const updated: NoteDto = { ...NOTE, slug: "brand-new", slugIsCustom: true };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === `/api/notes/${NOTE.id}` && method === "PATCH") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(updated) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = renderDialog();
    await openDialog();

    const slugInput = screen.getByRole("textbox", { name: "Custom link" });
    const before = window.location.pathname;
    fireEvent.change(slugInput, { target: { value: "brand-new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(queryClient.getQueryData<NoteDto>(["note", NOTE.id])?.slug).toBe("brand-new"));
    // 單一寫網址點（A3）：本元件不 replaceState——覆蓋移轉至 NotePage 收斂 effect 測試
    expect(window.location.pathname).toBe(before);

    const [, patchInit] = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    ) as [RequestInfo, RequestInit];
    expect(JSON.parse(String(patchInit.body))).toEqual({ slug: "brand-new" });
  });

  it("清除按鈕送出 slug:null", async () => {
    const noteWithSlug: NoteDto = { ...NOTE, slug: "existing-slug", slugIsCustom: true };
    // #122：清除＝回 auto 形（server 以現行 title 重算），不再是 null
    const cleared: NoteDto = { ...noteWithSlug, slug: "my-note", slugIsCustom: false };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === `/api/notes/${NOTE.id}` && method === "PATCH") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(cleared) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog(noteWithSlug);
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
      expect(call).toBeDefined();
      const [, init] = call as [RequestInfo, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ slug: null });
    });
  });

  it("新增分享送出 PUT {email, role}", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === SHARES_URL && method === "PUT") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ...SHARE, role: "editor" }) }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();

    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "bob@example.com" } });
    fireEvent.change(screen.getByLabelText("Role for new share"), { target: { value: "editor" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
      expect(call).toBeDefined();
      const [url, init] = call as [RequestInfo, RequestInit];
      expect(String(url)).toBe(SHARES_URL);
      expect(JSON.parse(String(init.body))).toEqual({ email: "bob@example.com", role: "editor" });
    });
  });

  it("新增分享失敗（user_not_found）→ 顯示對應文案", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === SHARES_URL && method === "PUT") {
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ error: { code: "user_not_found", message: "nope" } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();

    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "ghost@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.getByText("We couldn't find that user.")).toBeInTheDocument());
  });

  it("移除分享送出 DELETE /shares/:userId", async () => {
    let listed = [SHARE];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(listed) }));
      }
      if (url === `${SHARES_URL}/${SHARE.userId}` && method === "DELETE") {
        listed = [];
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();

    await waitFor(() => expect(screen.getByText(SHARE.email)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: `Remove ${SHARE.email}` }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");
      expect(call).toBeDefined();
      expect(String((call as [RequestInfo, RequestInit])[0])).toBe(`${SHARES_URL}/${SHARE.userId}`);
    });
    await waitFor(() => expect(screen.getByText("No one else has access yet.")).toBeInTheDocument());
  });

  it("改角色送出 PUT {email, role} 至同一支端點", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([SHARE]) }));
      }
      if (url === SHARES_URL && method === "PUT") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ...SHARE, role: "editor" }) }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();

    await waitFor(() => expect(screen.getByText(SHARE.email)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(`Role for ${SHARE.email}`), { target: { value: "editor" } });

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
      expect(call).toBeDefined();
      const [, init] = call as [RequestInfo, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ email: SHARE.email, role: "editor" });
    });
  });

  it("複製連結：呼叫 navigator.clipboard.writeText 並 toast 確認", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    renderDialog();
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Copy internal link" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/notes/my-note`),
    );
    await waitFor(() => expect(screen.getByText("Link copied to clipboard.")).toBeInTheDocument());
  });

  it("非 secure context 且 execCommand 也不可用 → toast 把網址攤出來讓使用者自己複製", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) })),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", {}); // 明文 http 的區網位址：整支 clipboard API 不存在
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => false), configurable: true, writable: true });

    renderDialog();
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Copy internal link" }));

    // 退路必須是「可以選取起來複製」的東西。toast 不行：Radix 的 toast root 帶
    // 行內 `userSelect: "none"`，而且橫向拖曳會被 swipe-to-dismiss 手勢吃掉。
    const manual = await screen.findByLabelText(
      "Couldn't copy automatically — select the link below and copy it yourself.",
    );
    // #122：slug 恆為字串 → canonicalNotePath 走 /notes/<slug> 形（Task 5b 改 /n/ 形）
    expect(manual).toHaveValue(`${window.location.origin}/notes/my-note`);
    expect(manual).toHaveAttribute("readonly");
  });

  /**
   * 手動複製欄出現時要自動選取一次方便複製，但**只有那一次**。`select()` 會把焦點
   * 移到該元素，所以若每次 re-render 都重跑（例如寫成 inline 的 `ref={n => n?.select()}`——
   * 每次 render 都是新的 callback identity，React 會重新掛載它），使用者在同一個 dialog
   * 裡打字時焦點會被搶進這個唯讀欄位，後續按鍵全部落空。這與本分支修的 #10 是同一類缺陷。
   */
  it("手動複製欄只在出現時自動選取一次，之後的 re-render 不搶焦點", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) })),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", {});
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => false), configurable: true, writable: true });

    const view = renderDialog();
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Copy internal link" }));

    const manual = await screen.findByLabelText(
      "Couldn't copy automatically — select the link below and copy it yourself.",
    );
    const selectSpy = vi.spyOn(manual as HTMLInputElement, "select");

    // 使用者接著去填共用對象的 email——焦點在那個欄位上。
    const email = screen.getByLabelText("Email address");
    email.focus();
    expect(document.activeElement).toBe(email);

    view.rerender();
    view.rerender();

    expect(selectSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(email);
  });
});


// ───────────────────────────── #72：分享三態 ─────────────────────────────

const PUBLIC_LINK_URL = `/api/notes/${NOTE.id}/public-link`;
const TOKEN = "T".repeat(43);

/** 可路由、可逐 URL 延遲的 fetch stub。`pending` 內的 URL 回傳懸置 promise，
 * 由測試手動 resolve——latch 案要它來釘「query 齊備前不選任何 radio」。
 * `shares` 與 `token` 都是**可變狀態**：DELETE /shares/:userId 成功即從名單移除、
 * PUT /shares 成功即加入；DELETE public-link 置 null、PUT 置回 TOKEN——refetch
 * 才會拿到動作後的狀態（靜態 stub 是「模擬的形狀不是真實形狀」的假綠種子）。 */
function stubRoutedFetch(opts: {
  shares?: ShareDto[];
  token?: string | null;
  pending?: string[];
  onCall?: (method: string, url: string) => Response | undefined;
}) {
  const calls: Array<{ method: string; url: string }> = [];
  const resolvers = new Map<string, (r: Response) => void>();
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    const overridden = opts.onCall?.(method, url);
    if (overridden) return Promise.resolve(overridden);
    if (opts.pending?.includes(url) && method === "GET") {
      return new Promise<Response>((resolve) => resolvers.set(url, resolve));
    }
    if (url === SHARES_URL && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([...(opts.shares ?? [])]) }));
    }
    if (url === PUBLIC_LINK_URL && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: opts.token ?? null }) }));
    }
    if (url === PUBLIC_LINK_URL && method === "PUT") {
      opts.token = TOKEN;
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: TOKEN }) }));
    }
    if (url === PUBLIC_LINK_URL && method === "DELETE") {
      opts.token = null;
      return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
    }
    if (url.startsWith(`${SHARES_URL}/`) && method === "DELETE") {
      const userId = url.slice(`${SHARES_URL}/`.length);
      const idx = opts.shares?.findIndex((sh) => sh.userId === userId) ?? -1;
      if (opts.shares && idx >= 0) opts.shares.splice(idx, 1); // -1 會誤刪最後一位（假綠種子）
      return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
    }
    if (url === SHARES_URL && method === "PUT") {
      opts.shares?.push(SHARE);
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(SHARE) }));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    fetchMock,
    resolve(url: string, response: Response) {
      resolvers.get(url)?.(response);
    },
  };
}

const SHARE2: ShareDto = {
  userId: "33333333-3333-3333-3333-333333333333",
  email: "carol@example.com",
  displayName: "Carol",
  role: "editor",
};

describe("ShareDialog 三態（#72）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("latch：兩個 query 首次都拿到資料才 derive——public-link 未回來前不選任何 radio，回來後（token 存在）落在「公開」；且 token 已存在**不打 PUT**", async () => {
    const stub = stubRoutedFetch({ shares: [], token: TOKEN, pending: [PUBLIC_LINK_URL] });
    renderDialog();
    await openDialog();

    // shares 已回、public-link 仍懸置：任何 radio 都不得選中（jsdom 單階段 mock 會
    // 假綠的正是這裡——spec B4 指名的兩階段要求）。
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).not.toBeChecked();
    }

    stub.resolve(PUBLIC_LINK_URL, fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: TOKEN }) }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());
    // 已公開的筆記開面板**不重生**：無任何 PUT。
    expect(stub.calls.filter((c) => c.method === "PUT" && c.url === PUBLIC_LINK_URL)).toHaveLength(0);
    // 連結顯示完整 /p/ 網址
    expect(screen.getByDisplayValue(`${window.location.origin}/p/${TOKEN}`)).toBeInTheDocument();
  });

  it("sticky：零成員選「限定成員」不彈回（refetch 後 derive=私人也不覆寫選擇）", async () => {
    stubRoutedFetch({ shares: [], token: TOKEN });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Members only/ }));
    // DELETE public-link 已發（hook 走 setQueryData 直寫快取，不 invalidate 重抓；
    // token=null、shares=0 → derive 會算出「私人」）——sticky 規則下 radio 必須
    // 留在「限定成員」。
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());
    expect(screen.getByRole("radio", { name: /Private/ })).not.toBeChecked();
  });

  it("sticky：「限定成員」態移除最後一位成員不彈回（e2e 03 的操作序列）", async () => {
    stubRoutedFetch({ shares: [SHARE], token: null });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());

    fireEvent.click(screen.getByRole("button", { name: `Remove ${SHARE.email}` }));
    await waitFor(() => expect(screen.queryByText("Bob")).not.toBeInTheDocument());
    expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked();
  });

  it("sticky：「私人」態用加人表單成功加人後 radio 仍停在私人（刻意——radio 是動作觸發器）", async () => {
    stubRoutedFetch({ shares: [], token: null });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());

    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "bob@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    // 先等成員真的出現（stub 的 PUT 會把 SHARE 推進可變名單、refetch 拿得到），
    // 「加人後被重算成 members」的退化形才真的可能發生——再斷 radio 沒動。
    await screen.findByText("Bob");
    expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked();
  });

  it("選「公開」（token null）→ PUT 一次、顯示連結＋Copy public link＋Regenerate；Regenerate 再 PUT", async () => {
    const stub = stubRoutedFetch({ shares: [], token: null });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Public link/ }));
    await waitFor(() => expect(screen.getByDisplayValue(`${window.location.origin}/p/${TOKEN}`)).toBeInTheDocument());
    expect(stub.calls.filter((c) => c.method === "PUT" && c.url === PUBLIC_LINK_URL)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Copy public link" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate link" }));
    await waitFor(() =>
      expect(stub.calls.filter((c) => c.method === "PUT" && c.url === PUBLIC_LINK_URL)).toHaveLength(2),
    );
  });

  it("私人確認流：列出將移除成員數→確認→**先 DELETE public-link 再逐一 DELETE shares**", async () => {
    const stub = stubRoutedFetch({ shares: [SHARE, SHARE2], token: TOKEN });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Private/ }));
    // 行內確認（不疊 dialog）：含成員數
    const confirm = await screen.findByRole("button", { name: /Remove 2 members and make private/ });
    fireEvent.click(confirm);

    await waitFor(() => {
      const deletes = stub.calls.filter((c) => c.method === "DELETE");
      expect(deletes.map((c) => c.url)).toEqual([
        PUBLIC_LINK_URL,
        `${SHARES_URL}/${SHARE.userId}`,
        `${SHARES_URL}/${SHARE2.userId}`,
      ]);
    });
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());
  });

  it("私人確認流部分失敗：第一位成員 DELETE 500 → 中止（第二位不打）＋錯誤 toast＋radio 依 refetch 重算＋殘餘名單如實", async () => {
    const stub = stubRoutedFetch({
      shares: [SHARE, SHARE2],
      token: TOKEN,
      onCall: (method, url) => {
        if (method === "DELETE" && url === `${SHARES_URL}/${SHARE.userId}`) {
          return fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) });
        }
        // refetch 後 token 已刪、成員仍在
        if (method === "GET" && url === PUBLIC_LINK_URL && stub?.calls.some((c) => c.method === "DELETE")) {
          return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null }) });
        }
        return undefined;
      },
    });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Private/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Remove 2 members and make private/ }));

    await waitFor(() => {
      const deletes = stub.calls.filter((c) => c.method === "DELETE");
      // public-link＋第一位（失敗）＝2 發；第二位**不打**（中止）
      expect(deletes).toHaveLength(2);
    });
    // 殘餘名單如實（兩位都還在——server 端第一位其實沒刪成）
    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());
    expect(screen.getByText("Carol")).toBeInTheDocument();
    // radio 依 refetch 後資料顯式重算：token 已刪、成員仍在 → 限定成員
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());
  });


  it("選「限定成員」→ 發 DELETE public-link 且成員名單不動（plan RED 2——這條就是撤銷路徑的功能本身）", async () => {
    const stub = stubRoutedFetch({ shares: [SHARE], token: TOKEN });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Members only/ }));
    await waitFor(() =>
      expect(stub.calls.filter((c) => c.method === "DELETE" && c.url === PUBLIC_LINK_URL)).toHaveLength(1),
    );
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked();
  });

  it("撤銷失敗（DELETE 500）→ 錯誤 toast＋radio 復原回「公開」＋不打 PUT（靜默失敗＝畫面說已撤銷、連結還活著）", async () => {
    const stub = stubRoutedFetch({
      shares: [],
      token: TOKEN,
      onCall: (method, url) => {
        if (method === "DELETE" && url === PUBLIC_LINK_URL) {
          return fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) });
        }
        return undefined;
      },
    });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Members only/ }));
    // 顯式重算點①：refetch（token 仍在）→ radio 回「公開」，並有錯誤 toast。
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());
    expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument();
    expect(stub.calls.filter((c) => c.method === "PUT" && c.url === PUBLIC_LINK_URL)).toHaveLength(0);
  });

  it("確認流取消（Keep members）→ 零 DELETE、radio 回「公開」（顯式重算點②——載重，拔掉會停在假的私人態）", async () => {
    const stub = stubRoutedFetch({ shares: [SHARE], token: TOKEN });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Private/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep members" }));

    expect(stub.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked();
    expect(screen.queryByRole("button", { name: /make private/ })).not.toBeInTheDocument();
  });

  it("確認流懸掛中用名單移除最後一位成員 → 撤連結由 effect 補完、確認列收起（動作不蒸發）", async () => {
    const stub = stubRoutedFetch({ shares: [SHARE], token: TOKEN });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Private/ }));
    await screen.findByRole("button", { name: /make private/ });
    // 同面板兩公分外的移除鈕：審查探針實測的蒸發路徑
    fireEvent.click(screen.getByRole("button", { name: `Remove ${SHARE.email}` }));

    await waitFor(() =>
      expect(stub.calls.filter((c) => c.method === "DELETE" && c.url === PUBLIC_LINK_URL)).toHaveLength(1),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: /make private/ })).not.toBeInTheDocument());
    expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked();
  });

  it("關閉重開 dialog → selection 重置、依新資料重新 latch（「選擇活到 dialog 關閉為止」的另一半）", async () => {
    stubRoutedFetch({ shares: [], token: TOKEN });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    // 選限定成員（撤銷成功——stub 的 token 是可變狀態，DELETE 後 GET 回 null）
    fireEvent.click(screen.getByRole("radio", { name: /Members only/ }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());

    // Esc 關閉 → 內容 unmount → 重開 → 重新 latch：token 已 null、零成員 → 私人
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("radio")).not.toBeInTheDocument());
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());
  });
});
