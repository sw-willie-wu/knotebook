import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import * as Y from "yjs";
import { EMPTY_YDOC_UPDATE_B64, YDOC_FRAGMENT } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import PublicNotePage from "./PublicNotePage";

// 比照 NotePage.test.tsx 的最小替身慣例：BlockNote 需要一整套 jsdom 沒有的 DOM/Range
// API，這裡只驗「頁面把正確的 doc/publicRef 交給唯讀編輯器」——選項本身的契約
// （fragment 名、resolveFileUrl 映射…）守在 collab/editor-options.test.ts。
// data-ref 序列化成 kind:值——別只吐 kind（那樣「傳錯篇的 ref」測不出來）。
vi.mock("@/components/PublicNoteEditor", () => ({
  PublicNoteEditor: ({ doc, publicRef }: { doc: Y.Doc; publicRef: import("@/lib/public-note-ref").PublicNoteRef }) => (
    <div
      data-testid="public-note-editor"
      data-ref={publicRef.kind === "token" ? `token:${publicRef.token}` : `path:${publicRef.handle}/${publicRef.slug}`}
      data-fragment-length={String(doc.getXmlFragment(YDOC_FRAGMENT).length)}
    />
  ),
}));

const TOKEN = "abcDEF123_-".repeat(4).slice(0, 43);

function ydocBase64(build: (fragment: Y.XmlFragment) => void): string {
  const doc = new Y.Doc();
  doc.transact(() => build(doc.getXmlFragment(YDOC_FRAGMENT)));
  const bytes = Y.encodeStateAsUpdate(doc);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

interface PublicNoteBody {
  title: string;
  ydoc: string;
}

/** 只回應公開端點；**任何**其他請求（尤其 /api/auth/me）都直接炸——匿名頁不得打到需要登入的東西。 */
function mockFetch(handler: (url: string) => { status: number; body: unknown } | null) {
  const calls: string[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);
    const matched = method === "GET" ? handler(url) : null;
    if (!matched) throw new Error(`unexpected fetch: ${method} ${url}`);
    return Promise.resolve({
      ok: matched.status >= 200 && matched.status < 300,
      status: matched.status,
      json: () => Promise.resolve(matched.body),
    } as unknown as Response);
  });
  return { fn, calls };
}

function renderPage(entry = `/p/${TOKEN}`) {
  // 刻意**不**在測試端關 retry（突變審查抓到的遮蔽形）：頁面自己的 `retry: false`
  // 必須承重——它一被拿掉，404/429 案就會重試三次，下面的呼叫次數斷言與
  // waitFor 時限（預設 1 秒 < 首次重試退避後的總時長）都會紅。
  // 路由樹帶兩形（與 App.tsx 同構）：形的判別在頁內 useParams。
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/p/:token" element={<PublicNotePage />} />
            <Route path="/p/:handle/:slug" element={<PublicNotePage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PublicNotePage（#72 /p/:token＋#122 PR3 /p/:handle/:slug 免登入唯讀頁）", () => {
  it("200：標題＋唯讀徽章＋Knotebook 連回 /，doc 解碼後交給唯讀編輯器（token 一併帶到）", async () => {
    const body: PublicNoteBody = {
      title: "公開的筆記",
      ydoc: ydocBase64((fragment) => {
        const paragraph = new Y.XmlElement("paragraph");
        paragraph.insert(0, [new Y.XmlText("hello")]);
        fragment.insert(0, [paragraph]);
      }),
    };
    const { fn, calls } = mockFetch((url) =>
      url === `/api/public/notes/${TOKEN}` ? { status: 200, body } : null,
    );
    vi.stubGlobal("fetch", fn);

    renderPage();

    const editor = await screen.findByTestId("public-note-editor");
    expect(editor.dataset.ref).toBe(`token:${TOKEN}`);
    expect(editor.dataset.fragmentLength).toBe("1");
    expect(screen.getByRole("heading", { name: "公開的筆記" })).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    // Knotebook 字樣連回首頁（匿名者點了會被 RequireAuth 導去 /login，那是預期行為）
    expect(screen.getByRole("link", { name: /Knotebook/ })).toHaveAttribute("href", "/");
    // 整頁只打過公開端點——尤其不得打 /api/auth/me（匿名頁零 auth 相依）
    expect(calls).toEqual([`GET /api/public/notes/${TOKEN}`]);
  });

  it("別名形 /p/<handle>/<slug>（#122 PR3）：打 by-path 端點、path 形 ref 交給編輯器、零 auth fetch", async () => {
    const body: PublicNoteBody = {
      title: "別名的筆記",
      ydoc: ydocBase64((fragment) => {
        const paragraph = new Y.XmlElement("paragraph");
        paragraph.insert(0, [new Y.XmlText("hi")]);
        fragment.insert(0, [paragraph]);
      }),
    };
    const { fn, calls } = mockFetch((url) =>
      url === "/api/public/notes/alice/my-doc" ? { status: 200, body } : null,
    );
    vi.stubGlobal("fetch", fn);

    const queryClient = renderPage("/p/alice/my-doc");

    const editor = await screen.findByTestId("public-note-editor");
    expect(editor.dataset.ref).toBe("path:alice/my-doc"); // token 形誤判會在這裡現形
    expect(screen.getByRole("heading", { name: "別名的筆記" })).toBeInTheDocument();
    expect(calls).toEqual(["GET /api/public/notes/alice/my-doc"]);
    // 快取真的落在 by-path key（突變審 L1）：queryKey 若寫死 token 形，URL 與畫面
    // 全對、只有快取格錯——所有別名頁共用一格，換頁會先渲染前一篇。fetch 斷言
    // 看不到這件事，必須直接驗 key。
    expect(queryClient.getQueryState(["public-note-by-path", "alice", "my-doc"])?.status).toBe("success");
  });

  it("別名形 404（改名／清別名後的舊連結）→ 同一張失效卡；恰打一次（retry:false 在別名形也承重）", async () => {
    const { fn, calls } = mockFetch((url) =>
      url === "/api/public/notes/alice/gone" ? { status: 404, body: { error: { code: "not_found" } } } : null,
    );
    vi.stubGlobal("fetch", fn);
    renderPage("/p/alice/gone");
    // 逐字（比照 token 404 案）：塌到泛用分支會渲染 errors.fallback，非本文案
    expect(await screen.findByRole("alert")).toHaveTextContent("This link doesn't exist or is no longer active.");
    expect(screen.queryByTestId("public-note-editor")).not.toBeInTheDocument();
    expect(calls).toEqual(["GET /api/public/notes/alice/gone"]);
  });

  it("空文件 payload（AAA=）→ 正常渲染空文件，不 throw、不顯示錯誤卡", async () => {
    const { fn } = mockFetch((url) =>
      url === `/api/public/notes/${TOKEN}`
        ? { status: 200, body: { title: "空筆記", ydoc: EMPTY_YDOC_UPDATE_B64 } satisfies PublicNoteBody }
        : null,
    );
    vi.stubGlobal("fetch", fn);

    renderPage();

    const editor = await screen.findByTestId("public-note-editor");
    expect(editor.dataset.fragmentLength).toBe("0");
    expect(screen.queryByText("This link doesn't exist or is no longer active.")).not.toBeInTheDocument();
  });

  it("404（撤銷／token 錯）→ 失效卡，不掛編輯器；恰打一次（頁面 retry: false 承重——404 是常見合法結果，重試只啃節流額度）", async () => {
    const { fn, calls } = mockFetch((url) =>
      url === `/api/public/notes/${TOKEN}`
        ? { status: 404, body: { error: { code: "not_found", message: "連結不存在或已失效" } } }
        : null,
    );
    vi.stubGlobal("fetch", fn);

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("This link doesn't exist or is no longer active.")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("public-note-editor")).not.toBeInTheDocument();
    expect(calls).toEqual([`GET /api/public/notes/${TOKEN}`]);
  });

  it("非 404 的失敗（429 節流）→ 顯示 errors.<code> 文案而非失效卡（連結可能還活著，不能誤告使用者「已失效」）", async () => {
    const { fn } = mockFetch((url) =>
      url === `/api/public/notes/${TOKEN}`
        ? { status: 429, body: { error: { code: "too_many_requests", message: "請求過於頻繁" } } }
        : null,
    );
    vi.stubGlobal("fetch", fn);

    renderPage();

    // 逐字斷 errors.too_many_requests 的文案（不是 errors.fallback）——非 404 分支
    // 塌縮成一律 fallback 的突變要在這裡紅。
    await waitFor(() => expect(screen.getByText("Too many requests. Please slow down.")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("This link doesn't exist or is no longer active.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("public-note-editor")).not.toBeInTheDocument();
  });

  // 背景 refetch（react-query 預設 focus/reconnect 會重抓）的兩條呈現規則（讀碼審查
  // Minor 1）：非 404 失敗不得把看到一半的內容翻成錯誤卡；404 則必須翻成失效卡
  //（撤銷的即時傳播）。
  const CONTENT_BODY: PublicNoteBody = {
    title: "公開的筆記",
    ydoc: ydocBase64((fragment) => {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText("hello")]);
      fragment.insert(0, [paragraph]);
    }),
  };

  it("背景 refetch 非 404 失敗（500）→ 既有內容續渲，不翻錯誤卡（一時的網路失敗，下次成功自癒）", async () => {
    let respond: { status: number; body: unknown } = { status: 200, body: CONTENT_BODY };
    const { fn } = mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? respond : null));
    vi.stubGlobal("fetch", fn);

    const queryClient = renderPage();
    await screen.findByTestId("public-note-editor");

    respond = { status: 500, body: { error: { code: "internal", message: "boom" } } };
    await act(async () => {
      await queryClient.refetchQueries();
    });

    // 先等 query 真的進 error 態再斷 DOM——不然「內容還在」可能只是翻卡尚未發生的
    // 假綠（404 那案實測狀態更新晚一拍）。
    await waitFor(() => expect(queryClient.getQueryState(["public-note", TOKEN])?.status).toBe("error"));
    expect(screen.getByTestId("public-note-editor")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("背景 refetch 撞 404（連結被撤銷）→ 翻成失效卡（正在看的人要知道連結死了，不是繼續掛著舊快照）", async () => {
    let respond: { status: number; body: unknown } = { status: 200, body: CONTENT_BODY };
    const { fn } = mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? respond : null));
    vi.stubGlobal("fetch", fn);

    const queryClient = renderPage();
    await screen.findByTestId("public-note-editor");

    respond = { status: 404, body: { error: { code: "not_found", message: "連結不存在或已失效" } } };
    await act(async () => {
      await queryClient.refetchQueries();
    });

    await waitFor(() =>
      expect(screen.getByText("This link doesn't exist or is no longer active.")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("public-note-editor")).not.toBeInTheDocument();
  });
});
