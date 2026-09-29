import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { NoteDto, ShareDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { useNote } from "@/api/notes";
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
  group: null,
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
      <MemoryRouter initialEntries={[`/notes/${current.id}`]}>
        <ShareDialog note={current} />
        <Toaster />
      </MemoryRouter>
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
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) })); // #103 PR3：所屬群組列
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
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) })); // #103 PR3：所屬群組列
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
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) })); // #103 PR3：所屬群組列
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
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) })); // #103 PR3：所屬群組列
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
    if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) })); // #103 PR3：所屬群組列
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

// ---- 群組筆記（#103 PR2 Task 6，spec §8.3）----

const GROUP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GROUP_NOTE: NoteDto = { ...NOTE, group: { id: GROUP_ID, name: "Workshop A", role: "editor" } };
const MY_GROUP_ADMIN = { id: GROUP_ID, name: "Workshop A", myRole: "admin", createdAt: "2026-09-01T00:00:00.000Z" };
const MY_GROUP_MEMBER = { ...MY_GROUP_ADMIN, myRole: "member" };
const MEMBERS = [
  { userId: "u1", email: "tester@example.com", displayName: "Tester", role: "admin" },
  { userId: "u2", email: "bob@example.com", displayName: "Bob", role: "member" },
];
const GROUPS_URL = "/api/groups";
const MEMBERS_URL = `/api/groups/${GROUP_ID}/members`;

/** 群組筆記的 fetch 分派：shares 恆 []（S5）、public-link 可變、groups／members 依參數。 */
function stubGroupFetch(opts: { groups: unknown[]; members?: unknown[]; link?: { token: string | null; slug: string | null } }) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let link = opts.link ?? { token: null, slug: null };
  let members = opts.members ?? MEMBERS;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      if (url === SHARES_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      if (url === PUBLIC_LINK_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(link) }));
      if (url === PUBLIC_LINK_URL && method === "PUT") { link = { token: "tok-1", slug: null }; return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(link) })); }
      if (url === PUBLIC_LINK_URL && method === "DELETE") { link = { token: null, slug: null }; return Promise.resolve(fakeResponse({ ok: true, status: 204 })); }
      if (url === GROUPS_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(opts.groups) }));
      if (url === MEMBERS_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(members) }));
      if (url === MEMBERS_URL && method === "PUT") {
        const added = { userId: "u3", email: body.email, displayName: "New", role: "member" };
        members = [...members, added];
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(added) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return calls;
}

describe("群組筆記（#103）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("只有「群組內可見」與「公開連結」兩個 radio、沒有私人、沒有逐人分享區；觸發鈕圖示 users、title 含群組名", async () => {
    stubGroupFetch({ groups: [MY_GROUP_MEMBER] });
    renderDialog(GROUP_NOTE);
    await waitFor(() => expect(screen.getByRole("button", { name: "Share" })).toHaveAttribute("title", 'Members of "Workshop A" have access'));
    expect(screen.getByRole("button", { name: "Share" }).querySelector("svg")).toHaveAttribute("data-icon", "users");

    await openDialog();
    const radios = await screen.findAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label") ?? r.closest("label")?.textContent)).toHaveLength(2);
    expect(screen.getByRole("radio", { name: /Group members/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Public link/ })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Private/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Members only/ })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Group members/ })).toBeChecked());
    expect(screen.queryByText("Who you invited")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Role for new share")).not.toBeInTheDocument();
  });

  it("成員區：顯示 displayName、email（A8）、角色；我是 admin → 有 email 輸入＋「Add to group」，送 PUT /api/groups/:id/members {email}，名單更新", async () => {
    const calls = stubGroupFetch({ groups: [MY_GROUP_ADMIN] });
    renderDialog(GROUP_NOTE);
    await openDialog();
    expect(await screen.findByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    expect(screen.getAllByText("Member")).not.toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "carol@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to group" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url === MEMBERS_URL && JSON.stringify(c.body) === JSON.stringify({ email: "carol@example.com" }))).toBe(true));
    expect(await screen.findByText("carol@example.com")).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toHaveValue("");
  });

  it("成員區：我不是 admin → 提示文案＋通往 /settings/groups/:id 的連結，點連結關閉分享面板", async () => {
    stubGroupFetch({ groups: [MY_GROUP_MEMBER] });
    renderDialog(GROUP_NOTE);
    await openDialog();
    expect(await screen.findByText("To invite a collaborator, ask a group admin to add them to the group.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Group settings" });
    expect(link).toHaveAttribute("href", `/settings/groups/${GROUP_ID}`);
    fireEvent.click(link);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Share note" })).not.toBeInTheDocument());
  });

  it("非 owner 的群組 admin 也沒有分享鈕、零 fetch（§11.2）", () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("should not fetch")));
    vi.stubGlobal("fetch", fetchMock);
    renderDialog({ ...GROUP_NOTE, role: "editor" });
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("公開態的群組筆記仍顯示成員區（admin 可加人，不必先撤連結）", async () => {
    stubGroupFetch({ groups: [MY_GROUP_ADMIN], link: { token: "tok-1", slug: null } });
    renderDialog(GROUP_NOTE);
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());
    expect(await screen.findByText("Bob")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to group" })).toBeInTheDocument();
  });

  it("RF2 分享面板：owner 已不是成員 → 只顯示「你已不是此群組的成員」，不打 GET members；radio 仍兩態", async () => {
    const calls = stubGroupFetch({ groups: [] });
    renderDialog(GROUP_NOTE);
    await openDialog();
    expect(await screen.findByText("You're no longer a member of this group.")).toBeInTheDocument();
    expect(calls.some((c) => c.url === MEMBERS_URL)).toBe(false);
    expect(screen.getByRole("radio", { name: /Group members/ })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Private/ })).not.toBeInTheDocument();
  });

  it("選公開 → PUT public-link、PublicLinkPanel 出現；選回群組內可見 → DELETE public-link、不需確認", async () => {
    const calls = stubGroupFetch({ groups: [MY_GROUP_MEMBER] });
    renderDialog(GROUP_NOTE);
    await openDialog();
    const publicRadio = await screen.findByRole("radio", { name: /Public link/ });
    await waitFor(() => expect(publicRadio).not.toBeDisabled());
    fireEvent.click(publicRadio);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url === PUBLIC_LINK_URL)).toBe(true));
    expect(await screen.findByLabelText("Public link URL")).toBeInTheDocument(); // 只有 PublicLinkPanel 才有這個欄位
    fireEvent.click(screen.getByRole("radio", { name: /Group members/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === PUBLIC_LINK_URL)).toBe(true));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // 沒有確認列
  });

  it("開著面板時個人筆記變成群組筆記（note 先到、public-link 快取仍是舊 token）→ AccessSection 重新 latch，radio 顯示群組內可見、連結面板消失", async () => {
    // 個人筆記、已公開
    let link: { token: string | null; slug: string | null } = { token: "tok-old", slug: null };
    const groups = [MY_GROUP_MEMBER];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === SHARES_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        if (url === PUBLIC_LINK_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(link) }));
        if (url === GROUPS_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(groups) }));
        if (url === MEMBERS_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(MEMBERS) }));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    const client = renderDialog(NOTE);
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());
    expect(await screen.findByLabelText("Public link URL")).toBeInTheDocument(); // 個人筆記公開態：連結面板在

    // server 端已搬進群組（token 已清），note 回應先到、public-link 快取還是 tok-old
    link = { token: null, slug: null };
    client.rerender(GROUP_NOTE);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Group members/ })).toBeChecked());
    expect(screen.queryByRole("radio", { name: /Private/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Public link URL")).not.toBeInTheDocument(); // 是 aria-label，不是文字
  });
});

// ---- 所屬群組列（#103 PR3，spec §8.3）----

const GROUP_B_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const MY_GROUP_B = { id: GROUP_B_ID, name: "Workshop B", myRole: "member", createdAt: "2026-09-02T00:00:00.000Z" };
const NOTE_GROUP_URL = `/api/notes/${NOTE.id}/group`;
const NOTE_URL = `/api/notes/${NOTE.id}`;
const CAROL: ShareDto = { userId: "33333333-3333-3333-3333-333333333333", email: "carol@example.com", displayName: "Carol", role: "viewer" };

/**
 * 模擬 NotePage：`ShareDialog` 的 `note` 取自 `['note', id]` 快取（常駐層），所以 mutation 的
 * `setQueryData(['note', id], …)` 會真的流回 prop。預設 `enabled: false`（只讀快取、不打 GET）；
 * `live` 時用真的 `useNote`（會 `GET /api/notes/:id`、會被 invalidate 重抓）——失敗後對帳的案要它。
 */
function NoteFromCache({ id, live }: { id: string; live: boolean }) {
  const cached = useQuery<NoteDto>({ queryKey: ["note", id], queryFn: () => Promise.reject(new Error("unused")), enabled: false });
  const fetched = useNote(live ? id : "");
  const data = live ? fetched.data : cached.data;
  return data ? <ShareDialog note={data} /> : null;
}

function renderLive(note: NoteDto, opts: { live?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["note", note.id], note);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/notes/${note.id}`]}>
        <NoteFromCache id={note.id} live={opts.live ?? false} />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

/**
 * 可變的 server：`PUT …/group` 換群組時照 server 語意清光 shares 與公開連結（同群組只改 role）、
 * `DELETE …/group` 只把 group 設 null（A10：連結不動；筆記不在群組 → 409 `conflict`，同 server）。
 * `fail` 讓某個 `method url` 回錯誤（`failRoute` 可在中途追加）；`hangLinkAfterMove` 讓搬家之後的 `GET public-link` 永不回應；
 * `sharesDelayMs` 讓 `GET shares` 晚一點回來；`sharesDelayAfterWriteMs` 只讓**寫入之後**的 `GET shares` 晚回來；
 * 回傳值的 `materializeGroupDeletion(shares, remainingGroups?)` 模擬「別人刪了群組」（D8：筆記回個人、成員
 * 物化成逐人分享；給了 `remainingGroups` 就連 `GET /api/groups` 一起換掉——群組真的沒了）；
 * `materializeBeforeWrite` 讓同一件事發生在「送出前檢查之後、寫入之前」（TOCTOU 窗口）。
 */
function stubMoveFetch(opts: {
  note: NoteDto;
  groups: unknown[];
  shares?: ShareDto[];
  link?: { token: string | null; slug: string | null };
  fail?: Record<string, { status: number; code: string }>;
  hangLinkAfterMove?: boolean;
  /** `GET shares` 延遲回應（毫秒）：讓「note 重抓比 shares 重抓先回來」的交錯可重現。 */
  sharesDelayMs?: number;
  sharesDelayAfterWriteMs?: number;
  materializeBeforeWrite?: ShareDto[];
}) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let note = opts.note;
  let shares = opts.shares ?? [];
  let link = opts.link ?? { token: null, slug: null };
  let moved = false;
  let wrote = false;
  let serverGroups = opts.groups;
  const fail: Record<string, { status: number; code: string }> = { ...opts.fail };
  const groupName = (id: string) => (serverGroups as Array<{ id: string; name: string }>).find((g) => g.id === id)?.name ?? "Gone";
  const ok = (body?: unknown) =>
    Promise.resolve(fakeResponse({ ok: true, status: body === undefined ? 204 : 200, json: () => Promise.resolve(body) }));
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      if (url === NOTE_GROUP_URL) {
        wrote = true;
        if (opts.materializeBeforeWrite) {
          note = { ...note, group: null };
          shares = opts.materializeBeforeWrite;
        }
      }
      const failure = fail[`${method} ${url}`];
      if (failure) {
        return Promise.resolve(
          fakeResponse({ ok: false, status: failure.status, json: () => Promise.resolve({ error: { code: failure.code, message: "x" } }) }),
        );
      }
      if (url === NOTE_URL && method === "GET") return ok(note);
      if (url === SHARES_URL && method === "GET") {
        const snapshot = [...shares];
        const delay = wrote && opts.sharesDelayAfterWriteMs ? opts.sharesDelayAfterWriteMs : opts.sharesDelayMs;
        if (!delay) return ok(snapshot);
        return new Promise<Response>((resolve) =>
          setTimeout(() => resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(snapshot) })), delay),
        );
      }
      if (url === PUBLIC_LINK_URL && method === "GET") {
        if (moved && opts.hangLinkAfterMove) return new Promise<Response>(() => {});
        return ok(link);
      }
      if (url === PUBLIC_LINK_URL && method === "PUT") {
        link = { token: TOKEN, slug: null };
        return ok(link);
      }
      if (url === PUBLIC_LINK_URL && method === "DELETE") {
        link = { token: null, slug: null };
        return ok();
      }
      if (url === "/api/groups" && method === "GET") return ok(serverGroups);
      if (url.startsWith("/api/groups/") && url.endsWith("/members") && method === "GET") return ok(MEMBERS);
      if (url === NOTE_GROUP_URL && method === "PUT") {
        const { groupId, role } = body as { groupId: string; role: "editor" | "viewer" };
        if (note.group?.id !== groupId) {
          shares = [];
          link = { token: null, slug: null };
          moved = true;
        }
        note = { ...note, group: { id: groupId, name: groupName(groupId), role } };
        return ok(note);
      }
      if (url === NOTE_GROUP_URL && method === "DELETE") {
        if (note.group === null) {
          return Promise.resolve(
            fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "conflict", message: "x" } }) }),
          );
        }
        note = { ...note, group: null };
        return ok(note);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return Object.assign(calls, {
    materializeGroupDeletion(asShares: ShareDto[], remainingGroups?: unknown[]) {
      note = { ...note, group: null };
      shares = asShares;
      if (remainingGroups) serverGroups = remainingGroups;
    },
    setServerNote(next: NoteDto) {
      note = next;
    },
    /** 之後的 `method url` 改回這個錯誤（fix r1：讓「先載入成功、之後重抓失敗」可重現）。 */
    failRoute(key: string, failure: { status: number; code: string }) {
      fail[key] = failure;
    },
  });
}

const groupSelect = () => screen.getByRole("combobox", { name: "Group this note belongs to" });

/** 群組下拉要等 groups、shares、public-link 三支 query 都到齊才啟用（I2）。 */
async function readyGroupSelect(): Promise<HTMLElement> {
  return waitFor(() => {
    const select = groupSelect();
    expect(select).toBeEnabled();
    return select;
  });
}

describe("所屬群組列（#103 PR3）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("個人筆記（有逐人分享＋公開連結）→ 選群組 → D16 確認列出 Carol 與撤銷連結 → PUT {groupId, role:'editor'} → 兩態 radio、連結面板消失、觸發鈕變群組、焦點回下拉且下拉沒被重掛", async () => {
    const calls = stubMoveFetch({ note: NOTE, groups: [MY_GROUP_ADMIN], shares: [CAROL], link: { token: TOKEN, slug: null } });
    renderLive(NOTE);
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());
    const select = await readyGroupSelect();
    expect(select).toHaveValue("");

    fireEvent.change(select, { target: { value: GROUP_ID } });
    const lead = await screen.findByText('Every member of "Workshop A" will be able to open and edit this note.');
    const box = lead.closest('[role="alert"]') as HTMLElement;
    expect(within(box).getByText('1 person you invited loses their individual invite — they keep access only if they\'re also a member of "Workshop A":')).toBeInTheDocument();
    expect(within(box).getByText("carol@example.com")).toBeInTheDocument();
    expect(within(box).getByText("The public link will be turned off (including its custom public URL).")).toBeInTheDocument();
    expect(within(box).getByRole("button", { name: "Move to group" })).toHaveClass("bg-destructive");
    expect(calls.some((c) => c.url === NOTE_GROUP_URL)).toBe(false); // 確認前不送

    fireEvent.click(within(box).getByRole("button", { name: "Move to group" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Group members/ })).toBeChecked());
    expect(calls.filter((c) => c.url === NOTE_GROUP_URL)).toEqual([
      { method: "PUT", url: NOTE_GROUP_URL, body: { groupId: GROUP_ID, role: "editor" } },
    ]);
    expect(screen.queryByRole("radio", { name: /Private/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Public link URL")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share", hidden: true })).toHaveAttribute("title", 'Members of "Workshop A" have access');
    expect(groupSelect()).toBe(select); // 所屬群組列不帶 key：搬家前後是同一個 DOM 節點
    expect(select).toHaveValue(GROUP_ID);
    await waitFor(() => expect(document.activeElement).toBe(select));
  });

  it("搬家後 public-link 重抓懸置 → 觸發鈕仍立即顯示群組態（連結快取的寫入在 UI 層承重，gate r1 M2）", async () => {
    stubMoveFetch({ note: NOTE, groups: [MY_GROUP_ADMIN], link: { token: TOKEN, slug: null }, hangLinkAfterMove: true });
    renderLive(NOTE);
    await openDialog();
    fireEvent.change(await readyGroupSelect(), { target: { value: GROUP_ID } });
    fireEvent.click(await screen.findByRole("button", { name: "Move to group" }));
    // 確認列收起＝mutation 已結束（onSuccess 已寫完快取）；此時 GET public-link 還懸著。
    await waitFor(() => expect(screen.queryByRole("button", { name: "Move to group" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Share", hidden: true })).toHaveAttribute("title", 'Members of "Workshop A" have access');
  });

  it("D16 確認列按「Cancel」→ 零 PUT、下拉回「None」、焦點回下拉", async () => {
    const calls = stubMoveFetch({ note: NOTE, groups: [MY_GROUP_ADMIN] });
    renderLive(NOTE);
    await openDialog();
    const select = await readyGroupSelect();
    fireEvent.change(select, { target: { value: GROUP_ID } });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Move to group" })).not.toBeInTheDocument();
    expect(select).toHaveValue("");
    expect(calls.some((c) => c.url === NOTE_GROUP_URL)).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(select));
  });

  it("零分享零連結的個人筆記：確認只有一句、不提撤銷；提交鈕不是 destructive", async () => {
    stubMoveFetch({ note: NOTE, groups: [MY_GROUP_ADMIN] });
    renderLive(NOTE);
    await openDialog();
    fireEvent.change(await readyGroupSelect(), { target: { value: GROUP_ID } });
    const lead = await screen.findByText('Every member of "Workshop A" will be able to open and edit this note.');
    const box = lead.closest('[role="alert"]') as HTMLElement;
    // 確認框裡只有導言那一段（fix r1 Minor 1：舊寫法 `/will lose access/` 對不上 confirmRevokeShares 的英文，永不命中）
    expect(box.querySelectorAll("p")).toHaveLength(1);
    expect(within(box).queryByText(/individual invite/)).not.toBeInTheDocument();
    expect(within(box).queryByText(/public link/)).not.toBeInTheDocument();
    expect(within(box).getByRole("button", { name: "Move to group" })).not.toHaveClass("bg-destructive");
  });

  it("分享名單查不到（GET shares 500）→ 群組下拉停用，改值也不出確認列、不送 PUT（gate r1 I2）", async () => {
    const calls = stubMoveFetch({
      note: NOTE,
      groups: [MY_GROUP_ADMIN],
      shares: [CAROL],
      fail: { [`GET ${SHARES_URL}`]: { status: 500, code: "internal" } },
    });
    renderLive(NOTE);
    await openDialog();
    await waitFor(() => expect(calls.some((c) => c.method === "GET" && c.url === SHARES_URL)).toBe(true));
    const select = await waitFor(() => groupSelect());
    await waitFor(() => expect(calls.some((c) => c.method === "GET" && c.url === PUBLIC_LINK_URL)).toBe(true));
    expect(select).toBeDisabled();
    fireEvent.change(select, { target: { value: GROUP_ID } });
    expect(screen.queryByRole("button", { name: "Move to group" })).not.toBeInTheDocument();
    expect(calls.some((c) => c.url === NOTE_GROUP_URL)).toBe(false);
  });

  it("群組筆記（我是成員、已公開）選「None」→ D15 確認 → DELETE → 回三態、公開連結仍在（A10）", async () => {
    const calls = stubMoveFetch({ note: GROUP_NOTE, groups: [MY_GROUP_MEMBER], link: { token: TOKEN, slug: null } });
    renderLive(GROUP_NOTE);
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());
    fireEvent.change(await readyGroupSelect(), { target: { value: "" } });
    const lead = await screen.findByText('Members of "Workshop A" will lose access to this note. The public link, if there is one, stays on.');
    const box = lead.closest('[role="alert"]') as HTMLElement;
    expect(within(box).getByRole("button", { name: "Remove from group" })).toHaveClass("bg-destructive");
    fireEvent.click(within(box).getByRole("button", { name: "Remove from group" }));

    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeInTheDocument());
    expect(calls.filter((c) => c.url === NOTE_GROUP_URL)).toEqual([{ method: "DELETE", url: NOTE_GROUP_URL, body: undefined }]);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());
    expect(screen.getByLabelText("Public link URL")).toHaveValue(TOKEN);
  });

  it("DELETE 409（送出前檢查通過之後、寫入之前群組被別人刪掉，成員已物化成逐人分享）→ 先重抓分享再重抓 note，回個人筆記時 radio 落在「Members only」而不是「Private」（gate r1 M1）", async () => {
    // shares 晚 50ms 回來：若失效 note 不等 shares 重抓，note 會先到、AccessSection 以舊的 [] latch 成「Private」。
    // `materializeBeforeWrite`：送出前檢查讀到的還是群組筆記，DELETE 抵達時才物化（檢查擋不住的 TOCTOU 窗口）。
    stubMoveFetch({ note: GROUP_NOTE, groups: [MY_GROUP_MEMBER], sharesDelayMs: 50, materializeBeforeWrite: [CAROL] });
    renderLive(GROUP_NOTE, { live: true });
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Group members/ })).toBeChecked());
    fireEvent.change(await readyGroupSelect(), { target: { value: "" } });
    const lead = await screen.findByText(/will lose access to this note/);
    fireEvent.click(within(lead.closest('[role="alert"]') as HTMLElement).getByRole("button", { name: "Remove from group" }));

    expect(await screen.findByText("Something changed while you were doing that. Reload and try again.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());
    expect(screen.getByRole("radio", { name: /Private/ })).not.toBeChecked();
  });

  it("群組筆記改「Read-only」→ 同群組 PUT {role:'viewer'}、不確認；公開連結不被清（server 同群組只改 role）；成功後焦點回權限下拉（final review Minor 1）", async () => {
    const calls = stubMoveFetch({ note: GROUP_NOTE, groups: [MY_GROUP_MEMBER], link: { token: TOKEN, slug: null } });
    renderLive(GROUP_NOTE);
    await openDialog();
    const publicRadio = screen.getByRole("radio", { name: /Public link/ });
    await waitFor(() => expect(publicRadio).toBeChecked());
    const roleSelect = await screen.findByRole("combobox", { name: "What group members can do" });
    expect(roleSelect).toHaveValue("editor");
    // 焦點先在別處：jsdom 不會在 disabled 時把焦點移走，也不會因 change 事件把焦點帶到權限下拉，
    // 所以「成功後焦點在權限下拉」只能來自元件自己的還原。
    publicRadio.focus();
    expect(document.activeElement).toBe(publicRadio);

    fireEvent.change(roleSelect, { target: { value: "viewer" } });
    await waitFor(() => expect(roleSelect).toHaveValue("viewer"));
    await waitFor(() => expect(document.activeElement).toBe(roleSelect));
    expect(calls.filter((c) => c.url === NOTE_GROUP_URL)).toEqual([
      { method: "PUT", url: NOTE_GROUP_URL, body: { groupId: GROUP_ID, role: "viewer" } },
    ]);
    expect(screen.queryByRole("button", { name: "Move to group" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked();
    expect(screen.getByLabelText("Public link URL")).toHaveValue(TOKEN);
    expect(screen.getByRole("button", { name: "Share", hidden: true })).toHaveAttribute("title", "Public — anyone with the link can view");
  });

  it("群組筆記改權限 PUT 500 → 錯誤出現、焦點回權限下拉、值仍是 editor（gate r4 M2）", async () => {
    stubMoveFetch({ note: GROUP_NOTE, groups: [MY_GROUP_MEMBER], fail: { [`PUT ${NOTE_GROUP_URL}`]: { status: 500, code: "internal" } } });
    renderLive(GROUP_NOTE);
    await openDialog();
    const radio = await screen.findByRole("radio", { name: /Group members/ });
    await waitFor(() => expect(radio).toBeChecked());
    const roleSelect = await screen.findByRole("combobox", { name: "What group members can do" });
    radio.focus(); // 焦點先在別處：改權限用的是 change 事件，不會把焦點帶到權限下拉
    expect(document.activeElement).toBe(radio);

    fireEvent.change(roleSelect, { target: { value: "viewer" } });
    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(roleSelect));
    expect(roleSelect).toHaveValue("editor");
  });

  it("群組→群組（原本唯讀、已公開）：確認多一句「原群組成員失去存取」與撤銷連結（A10）、提交鈕 destructive；PUT 新群組、權限重設為 editor（群組→群組一律送 editor，Willie 2026-09-27 裁決）", async () => {
    const readOnly: NoteDto = { ...GROUP_NOTE, group: { id: GROUP_ID, name: "Workshop A", role: "viewer" } };
    const calls = stubMoveFetch({ note: readOnly, groups: [MY_GROUP_MEMBER, MY_GROUP_B], link: { token: TOKEN, slug: null } });
    renderLive(readOnly);
    await openDialog();
    fireEvent.change(await readyGroupSelect(), { target: { value: GROUP_B_ID } });
    const lead = await screen.findByText('Members of "Workshop A" will lose access unless they\'re also in "Workshop B".');
    const box = lead.closest('[role="alert"]') as HTMLElement;
    expect(within(box).getByText("The public link will be turned off (including its custom public URL).")).toBeInTheDocument();
    expect(within(box).getByRole("button", { name: "Move to group" })).toHaveClass("bg-destructive");
    fireEvent.click(within(box).getByRole("button", { name: "Move to group" }));
    await waitFor(() => expect(groupSelect()).toHaveValue(GROUP_B_ID));
    expect(calls.filter((c) => c.url === NOTE_GROUP_URL)).toEqual([
      { method: "PUT", url: NOTE_GROUP_URL, body: { groupId: GROUP_B_ID, role: "editor" } },
    ]);
  });

  it("A1：我已不是該群組成員（但在另一個群組）→ 群組名稱唯讀、沒有群組下拉；權限下拉＋「Remove from group…」→ D15 → DELETE → 焦點落在新出現的群組下拉", async () => {
    const calls = stubMoveFetch({ note: GROUP_NOTE, groups: [MY_GROUP_B] });
    renderLive(GROUP_NOTE);
    await openDialog();
    expect(await screen.findByText('In "Workshop A"')).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Group this note belongs to" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "What group members can do" })).toHaveValue("editor");
    fireEvent.click(screen.getByRole("button", { name: "Remove from group…" }));
    const lead = await screen.findByText(/will lose access to this note/);
    const box = lead.closest('[role="alert"]') as HTMLElement;
    fireEvent.click(within(box).getByRole("button", { name: "Remove from group" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeInTheDocument());
    expect(calls.filter((c) => c.url === NOTE_GROUP_URL)).toEqual([{ method: "DELETE", url: NOTE_GROUP_URL, body: undefined }]);
    expect(groupSelect()).toHaveValue(""); // 回個人筆記：群組下拉出現
    await waitFor(() => expect(document.activeElement).toBe(groupSelect()));
  });

  it("A1 確認列按「Cancel」→ 焦點回外層「Remove from group…」（gate r1 I1）", async () => {
    stubMoveFetch({ note: GROUP_NOTE, groups: [] });
    renderLive(GROUP_NOTE);
    await openDialog();
    const outer = await screen.findByRole("button", { name: "Remove from group…" });
    fireEvent.click(outer);
    expect(outer).toBeEnabled(); // 確認懸掛期間不 disabled
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(outer));
  });

  it("PUT 失敗（404 group_not_found）→ 顯示錯誤、確認列收起、下拉回「None」且焦點回下拉、面板仍是個人三態", async () => {
    stubMoveFetch({ note: NOTE, groups: [MY_GROUP_ADMIN], fail: { [`PUT ${NOTE_GROUP_URL}`]: { status: 404, code: "group_not_found" } } });
    renderLive(NOTE);
    await openDialog();
    const select = await readyGroupSelect();
    fireEvent.change(select, { target: { value: GROUP_ID } });
    const submit = await screen.findByRole("button", { name: "Move to group" });
    submit.focus();
    fireEvent.click(submit);
    expect(await screen.findByText("We couldn't find that group.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move to group" })).not.toBeInTheDocument();
    expect(select).toHaveValue("");
    expect(screen.getByRole("radio", { name: /Private/ })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(select));
  });

  it("個人筆記、我不在任何群組 → 整列不渲染（Willie 2026-09-27 裁決 N4）", async () => {
    const calls = stubMoveFetch({ note: NOTE, groups: [] });
    renderLive(NOTE);
    await openDialog();
    await waitFor(() => expect(calls.some((c) => c.method === "GET" && c.url === "/api/groups")).toBe(true));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked()); // 面板其餘部分已渲染完
    expect(screen.queryByRole("heading", { name: "Group" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Group this note belongs to" })).not.toBeInTheDocument();
  });

  it("個人筆記、群組清單還在載入 → 不渲染（不先閃出一列 Loading…）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === SHARES_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        if (url === PUBLIC_LINK_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null, slug: null }) }));
        if (url === "/api/groups" && method === "GET") return new Promise<Response>(() => {});
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    renderLive(NOTE);
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());
    expect(screen.queryByRole("heading", { name: "Group" })).not.toBeInTheDocument();
    expect(screen.queryAllByText("Loading…")).toHaveLength(0);
  });

  it("個人筆記、群組清單錯誤 → 不渲染", async () => {
    const calls = stubMoveFetch({ note: NOTE, groups: [MY_GROUP_ADMIN], fail: { "GET /api/groups": { status: 500, code: "internal" } } });
    renderLive(NOTE);
    await openDialog();
    await waitFor(() => expect(calls.some((c) => c.method === "GET" && c.url === "/api/groups")).toBe(true));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());
    expect(screen.queryByRole("heading", { name: "Group" })).not.toBeInTheDocument();
  });

  it("送出前檢查：面板顯示舊群組、筆記其實已被刪群組物化成個人筆記 → 改權限不送 PUT、顯示提示、面板對齊（radio 落在 Members only）（Willie 裁決 M3）", async () => {
    const calls = stubMoveFetch({ note: GROUP_NOTE, groups: [MY_GROUP_MEMBER], sharesDelayMs: 50 });
    renderLive(GROUP_NOTE);
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Group members/ })).toBeChecked());
    const roleSelect = await screen.findByRole("combobox", { name: "What group members can do" });
    calls.materializeGroupDeletion([CAROL]); // 別的分頁：群組被刪，本面板不知道
    fireEvent.change(roleSelect, { target: { value: "viewer" } });

    expect(
      await screen.findByText("This note's group was changed somewhere else, so this panel has been reloaded. Check it and try again."),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.url === NOTE_GROUP_URL)).toBe(false);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());
    expect(groupSelect()).toHaveValue("");
    expect(screen.queryByRole("combobox", { name: "What group members can do" })).not.toBeInTheDocument();
    // 權限下拉已卸載 → 焦點退到群組下拉（gate r3 N2）
    await waitFor(() => expect(document.activeElement).toBe(groupSelect()));
  });

  it("送出前檢查不過、而群組已被刪且我沒有別的群組 → 整列隱藏時提示仍在（改權限；gate r3 I1）", async () => {
    const calls = stubMoveFetch({ note: GROUP_NOTE, groups: [MY_GROUP_MEMBER] });
    renderLive(GROUP_NOTE);
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Group members/ })).toBeChecked());
    const roleSelect = await screen.findByRole("combobox", { name: "What group members can do" });
    const groupGets = () => calls.filter((c) => c.method === "GET" && c.url === "/api/groups").length;
    const before = groupGets();
    calls.materializeGroupDeletion([CAROL], []); // 群組真的沒了：GET /api/groups 之後回 []
    fireEvent.change(roleSelect, { target: { value: "viewer" } });

    await waitFor(() => expect(groupGets()).toBeGreaterThan(before)); // 對齊時失效了 ['groups']
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Group" })).not.toBeInTheDocument());
    expect(
      screen.getByText("This note's group was changed somewhere else, so this panel has been reloaded. Check it and try again."),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.url === NOTE_GROUP_URL)).toBe(false);
  });

  it("同上，走「選 None → Remove from group」確認列 → 提示仍在、不送 DELETE（gate r3 I1 的 PX2 形）", async () => {
    const calls = stubMoveFetch({ note: GROUP_NOTE, groups: [MY_GROUP_MEMBER] });
    renderLive(GROUP_NOTE);
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Group members/ })).toBeChecked());
    fireEvent.change(await readyGroupSelect(), { target: { value: "" } });
    const lead = await screen.findByText(/will lose access to this note/);
    const groupGets = () => calls.filter((c) => c.method === "GET" && c.url === "/api/groups").length;
    const before = groupGets();
    calls.materializeGroupDeletion([CAROL], []);
    fireEvent.click(within(lead.closest('[role="alert"]') as HTMLElement).getByRole("button", { name: "Remove from group" }));

    await waitFor(() => expect(groupGets()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Group" })).not.toBeInTheDocument());
    expect(
      screen.getByText("This note's group was changed somewhere else, so this panel has been reloaded. Check it and try again."),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.url === NOTE_GROUP_URL)).toBe(false);
  });

  it("送出前檢查：個人筆記在別處已被搬進 Workshop B → 選 Workshop A 並確認時不送 PUT、顯示提示、下拉顯示 Workshop B", async () => {
    const inB: NoteDto = { ...NOTE, group: { id: GROUP_B_ID, name: "Workshop B", role: "editor" } };
    const calls = stubMoveFetch({ note: NOTE, groups: [MY_GROUP_ADMIN, MY_GROUP_B] });
    const client = renderLive(NOTE);
    await openDialog();
    fireEvent.change(await readyGroupSelect(), { target: { value: GROUP_ID } });
    const submit = await screen.findByRole("button", { name: "Move to group" });
    calls.setServerNote(inB); // 別的分頁已把它搬進 B（server 端），本面板不知道
    fireEvent.click(submit);

    expect(
      await screen.findByText("This note's group was changed somewhere else, so this panel has been reloaded. Check it and try again."),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.url === NOTE_GROUP_URL)).toBe(false);
    expect(client.getQueryData<NoteDto>(["note", NOTE.id])?.group?.id).toBe(GROUP_B_ID);
    await waitFor(() => expect(groupSelect()).toHaveValue(GROUP_B_ID));
  });

  it("確認列懸掛期間筆記已在別處搬進同一個目標（唯讀），且焦點重抓已把面板對齊 → 按「Move to group」不送 PUT（否則會把唯讀覆寫成 editor）、顯示提示、焦點回下拉（final review Minor 2）", async () => {
    const inBReadOnly: NoteDto = { ...NOTE, group: { id: GROUP_B_ID, name: "Workshop B", role: "viewer" } };
    const calls = stubMoveFetch({ note: NOTE, groups: [MY_GROUP_ADMIN, MY_GROUP_B] });
    const client = renderLive(NOTE);
    await openDialog();
    fireEvent.change(await readyGroupSelect(), { target: { value: GROUP_B_ID } });
    const submit = await screen.findByRole("button", { name: "Move to group" });
    // 別的分頁已把它搬進 B、設成唯讀；本面板的 note 由焦點重抓對齊（`current` 變成 B），確認列仍懸掛。
    calls.setServerNote(inBReadOnly);
    act(() => {
      client.setQueryData(["note", NOTE.id], inBReadOnly);
    });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "What group members can do" })).toHaveValue("viewer"));
    fireEvent.click(submit);

    expect(
      await screen.findByText("This note's group was changed somewhere else, so this panel has been reloaded. Check it and try again."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move to group" })).not.toBeInTheDocument();
    expect(calls.some((c) => c.url === NOTE_GROUP_URL)).toBe(false);
    expect(screen.getByRole("combobox", { name: "What group members can do" })).toHaveValue("viewer");
    expect(groupSelect()).toHaveValue(GROUP_B_ID);
    await waitFor(() => expect(document.activeElement).toBe(groupSelect()));
  });

  it("同上的移出形：確認列懸掛期間筆記已在別處移出、面板已對齊成個人筆記 → 按「Remove from group」不送 DELETE（否則 409）、顯示提示（final review Minor 2）", async () => {
    const personal: NoteDto = { ...GROUP_NOTE, group: null };
    const calls = stubMoveFetch({ note: GROUP_NOTE, groups: [MY_GROUP_MEMBER] });
    const client = renderLive(GROUP_NOTE);
    await openDialog();
    fireEvent.change(await readyGroupSelect(), { target: { value: "" } });
    const submit = await screen.findByRole("button", { name: "Remove from group" });
    calls.setServerNote(personal);
    act(() => {
      client.setQueryData(["note", NOTE.id], personal);
    });
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "What group members can do" })).not.toBeInTheDocument());
    fireEvent.click(submit);

    expect(
      await screen.findByText("This note's group was changed somewhere else, so this panel has been reloaded. Check it and try again."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove from group" })).not.toBeInTheDocument();
    expect(calls.some((c) => c.url === NOTE_GROUP_URL)).toBe(false);
    expect(screen.queryByText("Something went wrong. Please try again.")).not.toBeInTheDocument();
    expect(groupSelect()).toHaveValue("");
  });

  it("PUT 500 → 錯誤訊息在失敗對帳的重抓結束**之前**就出現（onError 不得 await 重抓，gate r2 M1）", async () => {
    stubMoveFetch({
      note: NOTE,
      groups: [MY_GROUP_ADMIN],
      fail: { [`PUT ${NOTE_GROUP_URL}`]: { status: 500, code: "internal" } },
      sharesDelayAfterWriteMs: 2000,
    });
    renderLive(NOTE);
    await openDialog();
    fireEvent.change(await readyGroupSelect(), { target: { value: GROUP_ID } });
    fireEvent.click(await screen.findByRole("button", { name: "Move to group" }));
    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
  });

  it("群組筆記、['groups'] 重抓失敗（手上已有資料）→ 送出前檢查的提示仍在、整列照常（fix r1 Minor 2）", async () => {
    const inB: NoteDto = { ...GROUP_NOTE, group: { id: GROUP_B_ID, name: "Workshop B", role: "editor" } };
    const calls = stubMoveFetch({ note: GROUP_NOTE, groups: [MY_GROUP_MEMBER, MY_GROUP_B] });
    const client = renderLive(GROUP_NOTE);
    await openDialog();
    await readyGroupSelect();
    const roleSelect = screen.getByRole("combobox", { name: "What group members can do" });
    calls.setServerNote(inB); // 別的分頁已把它搬進 B
    calls.failRoute("GET /api/groups", { status: 500, code: "internal" }); // 之後 ['groups'] 重抓失敗
    fireEvent.change(roleSelect, { target: { value: "viewer" } });

    await waitFor(() => {
      expect(client.getQueryState(["groups"])?.status).toBe("error");
      expect(
        screen.getByText("This note's group was changed somewhere else, so this panel has been reloaded. Check it and try again."),
      ).toBeInTheDocument();
    });
    expect(groupSelect()).toHaveValue(GROUP_B_ID);
    expect(screen.getByRole("combobox", { name: "What group members can do" })).toBeInTheDocument();
    expect(calls.some((c) => c.url === NOTE_GROUP_URL)).toBe(false);
  });

  it("個人筆記、['groups'] 重抓失敗（手上已有非空資料）→ 整列照常、不隱藏（fix r1 Minor 2）", async () => {
    const calls = stubMoveFetch({ note: NOTE, groups: [MY_GROUP_ADMIN] });
    const client = renderLive(NOTE);
    await openDialog();
    const select = await readyGroupSelect();
    calls.failRoute("GET /api/groups", { status: 500, code: "internal" });
    await act(() => client.invalidateQueries({ queryKey: ["groups"] }));

    await waitFor(() => expect(client.getQueryState(["groups"])?.status).toBe("error"));
    expect(screen.getByRole("heading", { name: "Group" })).toBeInTheDocument();
    expect(groupSelect()).toBe(select);
  });

  it("提示從完整列移到只剩訊息的那一段時，role=\"status\" 節點不重建（key=\"messages\"，gate r4 N1）", async () => {
    const calls = stubMoveFetch({ note: GROUP_NOTE, groups: [MY_GROUP_MEMBER] });
    renderLive(GROUP_NOTE);
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Group members/ })).toBeChecked());
    const roleSelect = await screen.findByRole("combobox", { name: "What group members can do" });
    const notice = "This note's group was changed somewhere else, so this panel has been reloaded. Check it and try again.";
    const seen: Array<{ node: Element; withHeading: boolean }> = [];
    const observer = new MutationObserver(() => {
      for (const node of Array.from(document.querySelectorAll('[role="status"]'))) {
        if (node.textContent !== notice || seen.some((entry) => entry.node === node)) continue;
        seen.push({ node, withHeading: screen.queryByRole("heading", { name: "Group" }) !== null });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    try {
      calls.materializeGroupDeletion([CAROL], []); // 群組真的沒了：整列最後會隱藏、只剩訊息
      fireEvent.change(roleSelect, { target: { value: "viewer" } });
      await waitFor(() => expect(screen.queryByRole("heading", { name: "Group" })).not.toBeInTheDocument());
      await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    } finally {
      observer.disconnect();
    }
    // 前提：提示先出現在完整列（有標題）裡、之後整列才隱藏——不成立的話本案沒有鑑別力。
    expect(seen[0]?.withHeading).toBe(true);
    expect(seen).toHaveLength(1);
    expect(screen.getByText(notice)).toBe(seen[0]?.node);
  });
});
