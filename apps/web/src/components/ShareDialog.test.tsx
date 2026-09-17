import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  lastEdited: null,
};

const SHARE: ShareDto = {
  userId: "22222222-2222-2222-2222-222222222222",
  email: "bob@example.com",
  displayName: "Bob",
  role: "viewer",
};

const SHARES_URL = `/api/notes/${NOTE.id}/shares`;

function renderDialog(note: NoteDto = NOTE) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 每次都建新的 element（不能重用同一個物件——element identity 相同時 React 會
  // 直接 bail out，根本不會 re-render，測不到「re-render 時發生什麼」）。
  // rerender 可吃新 note——模擬 NotePage 常駐層更新後把新 DTO 傳下來。
  const tree = (current: NoteDto) => (
    <QueryClientProvider client={queryClient}>
      <ShareDialog note={current} />
      <Toaster />
    </QueryClientProvider>
  );
  const view = render(tree(note));
  return Object.assign(queryClient, { rerender: (next: NoteDto = note) => view.rerender(tree(next)) });
}

async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  // 「限定成員」情境面板只在 selection==="members" 時才掛載，不能再拿它當開啟訊號
  // （改版前 SharesSection 平級常駐、"People with access" 一開就在）。"Access" 是
  // ShareGroup 的標題，三態都無條件渲染，開啟即在。
  await waitFor(() => expect(screen.getByText("Access")).toBeInTheDocument());
}

/** 切到「限定成員」層級，讓掛在它底下的情境面板（成員名單／加人表單）出現。
 * 新資訊架構下這是進入該面板前必經的一步（Willie 2026-09-17 產品決定）。radio 要等
 * latch 完成才會可按（`disabled={!latched || busy}`），所以先等它解除禁用再點。 */
async function selectMembers() {
  const radio = await screen.findByRole("radio", { name: /Members only/ });
  await waitFor(() => expect(radio).not.toBeDisabled());
  fireEvent.click(radio);
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

  it("新增分享送出 PUT {email, role}", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === PUBLIC_LINK_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null, slug: null }) }));
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
    // 加人表單掛在「限定成員」情境面板底下（新 IA，Willie 2026-09-17 產品決定）。
    await selectMembers();

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
      if (url === PUBLIC_LINK_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null, slug: null }) }));
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
    await selectMembers();

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
      if (url === PUBLIC_LINK_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null, slug: null }) }));
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
    // 有既有成員（shares.length>0）：latch 自動 derive 到「限定成員」，情境面板
    // 自己就會掛載，不必再手動點 radio。
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());

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
      if (url === PUBLIC_LINK_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null, slug: null }) }));
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
    // 既有成員 → 自動 derive 到「限定成員」，見上一條測試的說明。
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());

    await waitFor(() => expect(screen.getByText(SHARE.email)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(`Role for ${SHARE.email}`), { target: { value: "editor" } });

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
      expect(call).toBeDefined();
      const [, init] = call as [RequestInfo, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ email: SHARE.email, role: "editor" });
    });
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
  /** 公開別名（#122 PR3）：與 token 同屬可變狀態（PUT/DELETE …/slug 會改它）。 */
  slug?: string | null;
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
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: opts.token ?? null, slug: opts.slug ?? null }) }));
    }
    if (url === PUBLIC_LINK_URL && method === "PUT") {
      opts.token = TOKEN;
      // 重生不動別名＋回全形（server 契約，public-share.test 釘住）
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: TOKEN, slug: opts.slug ?? null }) }));
    }
    if (url === PUBLIC_LINK_URL && method === "DELETE") {
      opts.token = null;
      opts.slug = null; // server 同一支 UPDATE 清兩者
      return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
    }
    if (url === `${PUBLIC_LINK_URL}/slug` && method === "PUT") {
      const slug = (JSON.parse(String(init?.body)) as { slug: string }).slug;
      opts.slug = slug;
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: opts.token ?? null, slug }) }));
    }
    if (url === `${PUBLIC_LINK_URL}/slug` && method === "DELETE") {
      opts.slug = null;
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
    // 連結顯示完整 /p/ 網址（匿名 ON 態＝純文字顯示，不是可編輯輸入框）
    // 匿名態的網址拆成「前綴 `/p/` ＋ 唯讀輸入框放 token」（兩態同形，見元件註解），
    // 所以斷 token 落在輸入框的 value，不是找一整串文字。
    expect(screen.getByRole("textbox")).toHaveValue(TOKEN);
  });

  it("情境面板閘門：預設「私人」態（零成員零連結）不渲染成員名單／加人表單——只有選了「限定成員」才出現", async () => {
    stubRoutedFetch({ shares: [], token: null });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());

    // 這條專守「情境面板只在 selection === 'members' 時才掛載」這個閘門本身——
    // latch 完成、確定停在「私人」的狀態下，加人表單／名單標題都不該出現。
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
    expect(screen.queryByText("No one else has access yet.")).not.toBeInTheDocument();
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

  // 改版前加人表單在「私人」態也常駐可見，這條原本測「私人態加人不把 radio 重算成
  // 限定成員」。新 IA 下加人表單只掛在「限定成員」情境面板底下（selectMembers()
  // 才看得到），「私人態加人」這個操作序列本身已不可達——改測同一族不變量在新
  // 前提下仍成立的那一半：選了限定成員、加人成功，radio 不被資料變動重算掉。
  it("sticky：「限定成員」態用加人表單成功加人後 radio 仍停在限定成員（刻意——radio 是動作觸發器）", async () => {
    stubRoutedFetch({ shares: [], token: null });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());

    await selectMembers();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());

    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "bob@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    // 先等成員真的出現（stub 的 PUT 會把 SHARE 推進可變名單、refetch 拿得到），
    // 「加人後 radio 被重算掉」的退化形才真的可能發生——再斷 radio 沒動。
    await screen.findByText("Bob");
    expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked();
  });

  it("選「公開」（token null）→ PUT 一次、顯示連結＋Copy public link＋Regenerate；Regenerate 再 PUT", async () => {
    const stub = stubRoutedFetch({ shares: [], token: null });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Public link/ }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(TOKEN));
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

  // 改版前「限定成員」的名單與「存取權」平級常駐，這條原本測「同面板兩公分外的
  // 移除鈕」在確認流懸掛時把名單清空。新 IA 下情境面板只在 selection==="members"
  // 才掛載——確認流懸掛時 selection 已經是 "private"，同一個 dialog 裡沒有
  // Remove 鈕可點，這條路徑不再能用同分頁的按鈕操作出來。effect 本身守的是
  // 「名單被清空到零」這件事、不論成因，所以改用可變 shares 陣列＋手動
  // invalidateQueries 模擬外部變動（例如另一分頁移除了最後一位成員）觸發 refetch。
  it("確認流懸掛中（外部）名單被清空到零 → 撤連結由 effect 補完、確認列收起（動作不蒸發）", async () => {
    const shares = [SHARE];
    const stub = stubRoutedFetch({ shares, token: TOKEN });
    const queryClient = renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Private/ }));
    await screen.findByRole("button", { name: /make private/ });

    shares.length = 0;
    await queryClient.invalidateQueries({ queryKey: ["shares", NOTE.id] });

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

// ──────────────── 公開連結面板：匿名 toggle（Willie 2026-09-17 產品決定） ────────────────
// 取代舊「token 唯讀連結」＋「公開別名欄位」兩區塊：一個匿名 toggle＋一條連結＋最多
// 三顆鈕。模式由既有資料推導（slug null＝匿名 ON、slug 有值＝匿名 OFF），不是另開
// 一份 state——見 ShareDialog.tsx `PublicLinkPanel` 頂端 JSDoc。

const HEX16_RE = /^[0-9a-f]{16}$/;

describe("ShareDialog 公開連結面板：匿名 toggle", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openPublicDialog(opts: Parameters<typeof stubRoutedFetch>[0]) {
    const stub = stubRoutedFetch(opts);
    const queryClient = renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /^Public link/ })).toBeChecked());
    return { stub, queryClient };
  }

  it("1. 已公開且無別名 → toggle 呈現匿名開啟、連結是 /p/<token>、無可編輯輸入框、只有兩顆鈕", async () => {
    await openPublicDialog({ shares: [], token: TOKEN });

    expect(screen.getByRole("switch", { name: /Anonymous/ })).toBeChecked();
    // 匿名態的網址拆成「前綴 `/p/` ＋ 唯讀輸入框放 token」（兩態同形，見元件註解），
    // 所以斷 token 落在輸入框的 value，不是找一整串文字。
    expect(screen.getByRole("textbox")).toHaveValue(TOKEN);
    // 沒有可編輯輸入框（連結是純文字顯示，不是 Input）
    // 匿名態仍是輸入框（兩態同形、可選取複製），但**唯讀**——不可自訂是這一態的
    // 承重性質，用 readOnly 斷言而不是「沒有輸入框」。
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    expect(screen.queryByLabelText("Custom public link")).not.toBeInTheDocument();
    // 只有兩顆鈕：複製＋重新產生，沒有「儲存」（掃描整個面板 group，不是全域猜）
    const panel = screen.getByRole("group", { name: "Public link" });
    expect(within(panel).getAllByRole("button")).toHaveLength(2);
    expect(within(panel).getByRole("button", { name: "Copy public link" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Regenerate link" })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Save custom URL" })).not.toBeInTheDocument();
  });

  it("2. 關掉匿名 → 送出一次 set-slug（16 位 hex）、連結變成 /p/<handle>/<slug>、多一顆儲存＋可猜警語", async () => {
    const { stub } = await openPublicDialog({ shares: [], token: TOKEN });

    fireEvent.click(screen.getByRole("switch", { name: /Anonymous/ }));

    await waitFor(() =>
      expect(stub.calls.filter((c) => c.method === "PUT" && c.url === `${PUBLIC_LINK_URL}/slug`)).toHaveLength(1),
    );
    const putCall = stub.calls.find((c) => c.method === "PUT" && c.url === `${PUBLIC_LINK_URL}/slug`);
    expect(putCall).toBeDefined();

    await waitFor(() => expect(screen.getByRole("switch", { name: /Anonymous/ })).not.toBeChecked());
    const input = screen.getByLabelText("Custom public link") as HTMLInputElement;
    expect(input.value).toMatch(HEX16_RE);
    // 連結＝前綴（/p/<handle>/）＋輸入框裡的隨機 slug，兩者合起來才是完整網址
    expect(screen.getByText(`/p/${NOTE.ownerHandle}/`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save custom URL" })).toBeInTheDocument();
    expect(screen.getByText(/can be guessed/)).toBeInTheDocument();
  });

  it("3. OFF 態改成自訂名並儲存 → 送出 normalize 後的值、連結跟著變", async () => {
    const { stub, queryClient } = await openPublicDialog({ shares: [], token: TOKEN, slug: "old-alias" });

    fireEvent.change(screen.getByLabelText("Custom public link"), { target: { value: "My-Custom" } });
    fireEvent.click(screen.getByRole("button", { name: "Save custom URL" }));

    await waitFor(() =>
      expect(stub.calls).toContainEqual({ method: "PUT", url: `${PUBLIC_LINK_URL}/slug` }),
    );
    // 送出的是 normalize 後（小寫）的值
    const putCall = stub.fetchMock.mock.calls.find(
      ([input, init]) => String(input) === `${PUBLIC_LINK_URL}/slug` && (init as RequestInit)?.method === "PUT",
    );
    expect(JSON.parse(String((putCall as [unknown, RequestInit])[1].body))).toEqual({ slug: "my-custom" });
    expect(queryClient.getQueryData(["public-link", NOTE.id])).toEqual({ token: TOKEN, slug: "my-custom" });
  });

  it("4. OFF 態按「重新產生」→ 送出新的隨機 slug（與前一個不同）", async () => {
    const { stub } = await openPublicDialog({ shares: [], token: TOKEN, slug: "old-alias" });

    fireEvent.click(screen.getByRole("button", { name: "Regenerate link" }));
    await waitFor(() =>
      expect(stub.calls.filter((c) => c.method === "PUT" && c.url === `${PUBLIC_LINK_URL}/slug`)).toHaveLength(1),
    );
    const firstValue = (screen.getByLabelText("Custom public link") as HTMLInputElement).value;
    expect(firstValue).toMatch(HEX16_RE);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate link" }));
    await waitFor(() =>
      expect(stub.calls.filter((c) => c.method === "PUT" && c.url === `${PUBLIC_LINK_URL}/slug`)).toHaveLength(2),
    );
    const secondValue = (screen.getByLabelText("Custom public link") as HTMLInputElement).value;
    expect(secondValue).toMatch(HEX16_RE);
    expect(secondValue).not.toBe(firstValue);
  });

  // B1（審查修正，2026-09-17）：OFF 態按「重新產生」以前只換 slug、沒換 token——
  // 使用者設了自訂公開網址之後，外洩的 /p/<token> 連結就再也沒有輪替的入口，
  // 而按鈕明明寫著「重新產生」。修正後兩者要**同時**換：先 PUT public-link（換
  // token）再 PUT slug（換 slug），且新 slug 不等於舊 slug。
  it("B1：OFF 態按「重新產生」→ 同時 PUT public-link（換 token）與 PUT slug（換 slug），新 slug ≠ 舊 slug", async () => {
    const { stub } = await openPublicDialog({ shares: [], token: TOKEN, slug: "old-alias" });

    fireEvent.click(screen.getByRole("button", { name: "Regenerate link" }));

    await waitFor(() => {
      expect(stub.calls.filter((c) => c.method === "PUT" && c.url === PUBLIC_LINK_URL)).toHaveLength(1);
      expect(stub.calls.filter((c) => c.method === "PUT" && c.url === `${PUBLIC_LINK_URL}/slug`)).toHaveLength(1);
    });
    // token 的 PUT 要先於 slug 的 PUT（先換 token 才不會用舊 token 硬換出一個新 slug）。
    const tokenCallIndex = stub.calls.findIndex((c) => c.method === "PUT" && c.url === PUBLIC_LINK_URL);
    const slugCallIndex = stub.calls.findIndex((c) => c.method === "PUT" && c.url === `${PUBLIC_LINK_URL}/slug`);
    expect(tokenCallIndex).toBeGreaterThanOrEqual(0);
    expect(slugCallIndex).toBeGreaterThan(tokenCallIndex);

    const newValue = (screen.getByLabelText("Custom public link") as HTMLInputElement).value;
    expect(newValue).toMatch(HEX16_RE);
    expect(newValue).not.toBe("old-alias");
  });

  it("5. 失敗復原：set-slug 回錯誤 → toggle 彈回原狀、顯示錯誤、畫面不得宣稱已切換", async () => {
    const { stub } = await openPublicDialog({
      shares: [],
      token: TOKEN,
      onCall: (method, url) =>
        method === "PUT" && url === `${PUBLIC_LINK_URL}/slug`
          ? fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) })
          : undefined,
    });

    fireEvent.click(screen.getByRole("switch", { name: /Anonymous/ }));

    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    // toggle 彈回：仍是匿名 ON，畫面沒有長出 OFF 態的可編輯輸入框
    expect(screen.getByRole("switch", { name: /Anonymous/ })).toBeChecked();
    expect(screen.queryByLabelText("Custom public link")).not.toBeInTheDocument();
    // 匿名態的網址拆成「前綴 `/p/` ＋ 唯讀輸入框放 token」（兩態同形，見元件註解），
    // 所以斷 token 落在輸入框的 value，不是找一整串文字。
    expect(screen.getByRole("textbox")).toHaveValue(TOKEN);
    expect(stub.calls.filter((c) => c.method === "PUT" && c.url === `${PUBLIC_LINK_URL}/slug`)).toHaveLength(1);
  });

  it("6. 打開匿名 → 送出 clear-slug、連結回到 /p/<token>", async () => {
    const { stub } = await openPublicDialog({ shares: [], token: TOKEN, slug: "old-alias" });
    expect(screen.getByRole("switch", { name: /Anonymous/ })).not.toBeChecked();

    fireEvent.click(screen.getByRole("switch", { name: /Anonymous/ }));

    await waitFor(() =>
      expect(stub.calls).toContainEqual({ method: "DELETE", url: `${PUBLIC_LINK_URL}/slug` }),
    );
    await waitFor(() => expect(screen.getByRole("switch", { name: /Anonymous/ })).toBeChecked());
    // 匿名態的網址拆成「前綴 `/p/` ＋ 唯讀輸入框放 token」（兩態同形，見元件註解），
    // 所以斷 token 落在輸入框的 value，不是找一整串文字。
    expect(screen.getByRole("textbox")).toHaveValue(TOKEN);
    expect(screen.queryByLabelText("Custom public link")).not.toBeInTheDocument();
  });

  it("私人態不渲染公開連結面板", async () => {
    stubRoutedFetch({ shares: [], token: null });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());
    expect(screen.queryByRole("switch", { name: /Anonymous/ })).not.toBeInTheDocument();
  });

  it("409 public_slug_taken → 顯示對應文案；輸入值保留（讓使用者改字重試）", async () => {
    await openPublicDialog({
      shares: [],
      token: TOKEN,
      slug: "old-alias",
      onCall: (method, url) =>
        method === "PUT" && url === `${PUBLIC_LINK_URL}/slug`
          ? fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "public_slug_taken", message: "x" } }) })
          : undefined,
    });
    fireEvent.change(screen.getByLabelText("Custom public link"), { target: { value: "taken" } });
    fireEvent.click(screen.getByRole("button", { name: "Save custom URL" }));

    expect(await screen.findByText("That public URL is already used by another of your notes.")).toBeInTheDocument();
    expect(screen.getByLabelText("Custom public link")).toHaveValue("taken");
  });

  it("client 端驗證同源：非法字元就地擋、不打 API", async () => {
    const { stub } = await openPublicDialog({ shares: [], token: TOKEN, slug: "old-alias" });
    fireEvent.change(screen.getByLabelText("Custom public link"), { target: { value: "bad_alias" } });
    expect(screen.getByText("Only letters, numbers, and hyphens are allowed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save custom URL" })).toBeDisabled();
    expect(stub.calls.filter((c) => c.url.endsWith("/slug") && c.method === "PUT")).toHaveLength(0);
  });

  // ──────────── N8：下架 CopyLinkButton 時掉的兩條，在 PublicCopyButton 補回 ────────────
  // 這兩條原本守著 `CopyLinkButton`（#9／後續修正），下架時被刪掉，但退路 UI
  // （`copyText` 兩條路都失敗→`ManualCopyField`）仍活在 `PublicCopyButton` 這條路徑上
  // ——只是換了個呼叫端，行為本身沒有變，見 `lib/clipboard.ts`／`ManualCopyField.tsx`。

  it("N8：非 secure context 且 execCommand 也不可用 → 攤出網址讓使用者自己複製", async () => {
    await openPublicDialog({ shares: [], token: TOKEN });
    vi.stubGlobal("navigator", {}); // 明文 http 的區網位址：整支 clipboard API 不存在
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => false), configurable: true, writable: true });

    fireEvent.click(screen.getByRole("button", { name: "Copy public link" }));

    // 退路必須是「可以選取起來複製」的東西——不是 toast（Radix toast root 帶
    // `userSelect: none`，橫向拖曳也會被 swipe-to-dismiss 手勢吃掉）。
    const manual = await screen.findByLabelText(
      "Couldn't copy automatically — select the link below and copy it yourself.",
    );
    expect(manual).toHaveValue(`${window.location.origin}/p/${TOKEN}`);
    expect(manual).toHaveAttribute("readonly");
  });

  it("N8：手動複製欄只在出現時自動選取一次，之後的 re-render 不搶焦點", async () => {
    const { queryClient } = await openPublicDialog({ shares: [], token: TOKEN });
    vi.stubGlobal("navigator", {});
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => false), configurable: true, writable: true });

    fireEvent.click(screen.getByRole("button", { name: "Copy public link" }));

    const manual = await screen.findByLabelText(
      "Couldn't copy automatically — select the link below and copy it yourself.",
    );
    const selectSpy = vi.spyOn(manual as HTMLInputElement, "select");

    // 觸發跟這個欄位無關的 re-render（比照上面 renderDialog 的 rerender 慣例——
    // element identity 換新，React 才會真的重新走一次 render，不會 bail out）。
    queryClient.rerender();
    queryClient.rerender();

    expect(selectSpy).not.toHaveBeenCalled();
  });
});

// A2（突變審）＋plan「confirmHint 文案」：token 在場的私人確認列必須提到公開連結
// （含自訂公開網址）——這句是 #122 PR3 的交付物，砍掉 token 分支塌回 confirmHint
// 的突變在這裡紅。
describe("私人確認流文案（#122 PR3 擴字）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("有 token 時確認列用 confirmHintWithLink（提及 custom public URL）", async () => {
    stubRoutedFetch({ shares: [SHARE], token: TOKEN });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /^Public link/ })).toBeChecked());
    fireEvent.click(screen.getByRole("radio", { name: /Private/ }));
    expect(
      await screen.findByText(/turns off the public link \(including its custom public URL\)/),
    ).toBeInTheDocument();
  });
});

// ──────────── 觸發鈕圖示跟著分享狀態變（私人=鎖／限定成員=分享／公開=地球） ────────────
// UI 改版設計裡本來就該有的多狀態，只是出貨時只做了單一狀態，多狀態留給 #72——
// #72 做完公開態之後這件事掉了，這裡補上。狀態用 `title` 傳達，`aria-label` 固定不變
// （e2e `03-share-revoke.spec.ts` 靠 accessible name "Share" 找按鈕）。
describe("ShareDialog 觸發鈕圖示（依分享狀態，#72 UI 收尾）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function triggerButton() {
    // 字串 name 預設就是精確比對，不必也不能加 `exact`（ByRoleOptions 型別
    // 不收這個鍵——tsc 才抓得到，vitest 走 esbuild 剝型別測不出來）。
    return screen.getByRole("button", { name: "Share" });
  }

  it("私人（無 token、零成員）→ title 是私人狀態；載入中不猜狀態、可及名稱仍是 Share", async () => {
    const stub = stubRoutedFetch({ shares: [], token: null, pending: [SHARES_URL, PUBLIC_LINK_URL] });
    renderDialog();

    // 兩階段的第一階段：query 都還懸置，不得顯示任何狀態文案（不閃爍、不猜）。
    expect(triggerButton()).not.toHaveAttribute("title");
    expect(triggerButton()).toHaveAccessibleName("Share");

    stub.resolve(SHARES_URL, fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    stub.resolve(
      PUBLIC_LINK_URL,
      fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null, slug: null }) }),
    );

    await waitFor(() => expect(triggerButton()).toHaveAttribute("title", "Private — only you have access"));
    expect(triggerButton()).toHaveAccessibleName("Share");
    // I2：title／可及名稱只斷「有沒有變」，斷不到「變成哪一個」——把 TriggerIcon
    // 退化成固定 Share 也會全綠。實際斷圖示本身（data-icon，見 ui/icons.tsx）。
    expect(triggerButton().querySelector("svg")).toHaveAttribute("data-icon", "lock");
  });

  it("限定成員（無 token、有成員）→ title 是成員狀態；可及名稱仍是 Share", async () => {
    const stub = stubRoutedFetch({ shares: [SHARE], token: null, pending: [SHARES_URL, PUBLIC_LINK_URL] });
    renderDialog();

    expect(triggerButton()).not.toHaveAttribute("title");

    stub.resolve(SHARES_URL, fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([SHARE]) }));
    stub.resolve(
      PUBLIC_LINK_URL,
      fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null, slug: null }) }),
    );

    await waitFor(() => expect(triggerButton()).toHaveAttribute("title", "Shared with members you invited"));
    expect(triggerButton()).toHaveAccessibleName("Share");
    expect(triggerButton().querySelector("svg")).toHaveAttribute("data-icon", "share");
  });

  it("公開（有 token）→ title 是公開狀態；可及名稱仍是 Share", async () => {
    const stub = stubRoutedFetch({ shares: [], token: TOKEN, pending: [SHARES_URL, PUBLIC_LINK_URL] });
    renderDialog();

    expect(triggerButton()).not.toHaveAttribute("title");

    stub.resolve(SHARES_URL, fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    stub.resolve(
      PUBLIC_LINK_URL,
      fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: TOKEN, slug: null }) }),
    );

    await waitFor(() => expect(triggerButton()).toHaveAttribute("title", "Public — anyone with the link can view"));
    expect(triggerButton()).toHaveAccessibleName("Share");
    expect(triggerButton().querySelector("svg")).toHaveAttribute("data-icon", "globe");
  });
});
