import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import * as Y from "yjs";
import { EMPTY_YDOC_UPDATE_B64, YDOC_FRAGMENT } from "@knotebook/shared";
import i18n from "@/i18n";
import { stubLayoutTier } from "@/test/layout-tier";
import { OUTLINE_PINNED_STORAGE_KEY } from "@/components/outline/outline-pin";
import { ARTICLE_COLUMN_MAX, articleColumn } from "@/components/ui/article-column";
import { ThemeProvider } from "@/theme";
import PublicNotePage from "./PublicNotePage";

// 比照 NotePage.test.tsx 的最小替身慣例：BlockNote 需要一整套 jsdom 沒有的 DOM/Range
// API，這裡只驗「頁面把正確的 doc/publicRef 交給唯讀編輯器」——選項本身的契約
// （fragment 名、resolveFileUrl 映射…）守在 collab/editor-options.test.ts。
// data-ref 序列化成 kind:值——別只吐 kind（那樣「傳錯篇的 ref」測不出來）。
// 替身也像真的一樣把「編輯器」交給 onEditor：一份只有一個 H2 的文件，標題大綱才有東西可列。
const FAKE_EDITOR = vi.hoisted(() => ({
  document: [{ id: "h-intro", type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Intro" }] }],
  onChange: () => () => {},
}));
vi.mock("@/components/PublicNoteEditor", async () => {
  const { useEffect } = await import("react");
  return {
    PublicNoteEditor: ({
      doc,
      publicRef,
      links,
      onEditor,
    }: {
      doc: Y.Doc;
      publicRef: import("@/lib/public-note-ref").PublicNoteRef;
      links: unknown[];
      onEditor?: (editor: typeof FAKE_EDITOR | null) => void;
    }) => {
      useEffect(() => {
        onEditor?.(FAKE_EDITOR);
        return () => onEditor?.(null);
      }, [onEditor]);
      return (
        <div
          data-testid="public-note-editor"
          data-ref={publicRef.kind === "token" ? `token:${publicRef.token}` : `path:${publicRef.handle}/${publicRef.slug}`}
          data-fragment-length={String(doc.getXmlFragment(YDOC_FRAGMENT).length)}
          data-links={JSON.stringify(links)}
        />
      );
    },
  };
});
// 簡報層本身另有測試（`PublicNotePage.present.test.tsx`）；這裡只要它掛得上。
vi.mock("@/present/lazy", () => ({ LazyPresentation: () => <div data-testid="presentation-stub" /> }));
// 大綱本身另有測試；這裡只驗它掛在哪、拿到什麼。
const outlineProps = vi.hoisted(() => [] as Array<import("@/components/outline/NoteOutline").NoteOutlineProps>);
vi.mock("@/components/outline/NoteOutline", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/outline/NoteOutline")>();
  return {
    ...original,
    NoteOutline: (props: import("@/components/outline/NoteOutline").NoteOutlineProps) => {
      outlineProps.push(props);
      return <div data-testid="outline-stub" />;
    },
  };
});
// 手機的泡泡與底部面板本身另有測試；這裡記下拿到什麼。泡泡替身是一顆按了就呼叫 onOpen 的鈕（同點一下）。
const phoneStubs = vi.hoisted(() => ({
  bubble: [] as Array<import("@/components/outline/OutlineScrollBubble").OutlineScrollBubbleProps>,
  sheet: [] as Array<import("@/components/outline/OutlineSheet").OutlineSheetProps>,
}));
vi.mock("@/components/outline/OutlineScrollBubble", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/outline/OutlineScrollBubble")>();
  return {
    ...original,
    OutlineScrollBubble: (props: import("@/components/outline/OutlineScrollBubble").OutlineScrollBubbleProps) => {
      phoneStubs.bubble.push(props);
      return <button type="button" data-testid="bubble-stub" onClick={(e) => props.onOpen(e.currentTarget)} />;
    },
  };
});
vi.mock("@/components/outline/OutlineSheet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/outline/OutlineSheet")>()),
  OutlineSheet: (props: import("@/components/outline/OutlineSheet").OutlineSheetProps) => {
    phoneStubs.sheet.push(props);
    return <div data-testid="sheet-stub" data-open={String(props.open)} />;
  },
}));
// jsdom 沒有版面：容器寬度由測試指定（同真的 hook，兩個元素都掛上才有值）。
const outlineBox = vi.hoisted(() => ({ value: { width: 1072, height: 700, firstLineTop: null } }));
vi.mock("@/components/outline/use-outline-box", () => ({
  useOutlineBox: (scrollEl: HTMLElement | null, columnEl: HTMLElement | null) => (scrollEl !== null && columnEl !== null ? outlineBox.value : null),
}));

// 浮動層的內部行為由 ImageZoomLayer.test.tsx 守；這裡只看頁面把它放進有放大功能的欄裡、且唯讀。
vi.mock("@/components/media-zoom/ImageZoomLayer", async () => {
  const { useMediaZoom } = await import("@/components/media-zoom/context");
  return {
    ImageZoomLayer: ({ container, editable }: { container: HTMLElement | null; editable: boolean }) => (
      <div
        data-testid="image-zoom-layer"
        data-has-zoom={String(useMediaZoom() !== null)}
        data-editable={String(editable)}
        data-in-column={String(container?.dataset.testid === "article-column")}
      />
    ),
  };
});

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
  links?: Array<{ id: string; title: string; path: string }>;
  /** #297：故意放寬成 string——P3 要送 server 不認得的值。 */
  width?: string;
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
  // 刻意**不**在測試端關 retry（會遮蔽的形）：頁面自己的 `retry: false`
  // 必須承重——它一被拿掉，404/429 案就會重試三次，錯誤畫面要等第四次失敗才出現。
  // 守法是**計次**：404、429 兩案都在錯誤畫面出現後斷言公開端點恰被打一次（重試的話已是 4 次）。
  // 不靠 waitFor 時限：react-query 預設退避 1+2+4≈7 秒，塞得進全域 asyncUtilTimeout（test/setup.ts）。
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

describe("PublicNotePage（#72 /p/:token＋#122 /p/:handle/:slug 免登入唯讀頁）", () => {
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
    expect(screen.getByTestId("public-note-editor")).toHaveAttribute("data-links", "[]");
    expect(screen.getByRole("heading", { name: "公開的筆記" })).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    // Knotebook 字樣連回首頁（匿名者點了會被 RequireAuth 導去 /login，那是預期行為）
    expect(screen.getByRole("link", { name: /Knotebook/ })).toHaveAttribute("href", "/");
    // 整頁只打過公開端點——尤其不得打 /api/auth/me（匿名頁零 auth 相依）
    expect(calls).toEqual([`GET /api/public/notes/${TOKEN}`]);
  });

  it("手機頁首：簡報鈕只剩圖示（可及名稱不變）、唯讀徽章收成一個點（文字只給螢幕閱讀器）", async () => {
    const body: PublicNoteBody = { title: "公開的筆記", ydoc: EMPTY_YDOC_UPDATE_B64 };
    vi.stubGlobal("fetch", mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? { status: 200, body } : null)).fn);
    renderPage();
    const present = await screen.findByRole("button", { name: "Present" });
    expect(present).toHaveClass("pointer-coarse:after:-inset-y-1.5");
    const label = within(present).getByText("Present");
    expect(label).toHaveClass("max-sm:sr-only");
    const readonly = screen.getByText("Read-only");
    expect(readonly).toHaveClass("max-sm:sr-only");
    const badge = readonly.parentElement!;
    expect(badge).toHaveClass("sm:border");
    expect(badge).not.toHaveClass("border");
    const dot = badge.querySelector("[data-readonly-dot]");
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(dot).toHaveClass("sm:hidden");
  });

  it("#462：文章欄裡有放大功能與唯讀的圖片浮動層（浮動層掛在文章欄上）", async () => {
    const body: PublicNoteBody = { title: "公開的筆記", ydoc: EMPTY_YDOC_UPDATE_B64 };
    vi.stubGlobal("fetch", mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? { status: 200, body } : null)).fn);
    renderPage();
    const layer = await screen.findByTestId("image-zoom-layer");
    expect(layer).toHaveAttribute("data-has-zoom", "true");
    expect(layer).toHaveAttribute("data-editable", "false");
    await waitFor(() => expect(layer).toHaveAttribute("data-in-column", "true"));
    expect(screen.getByTestId("article-column")).toContainElement(layer);
  });

  it("公開頁沒有最愛星號，也不打最愛清單（#334）", async () => {
    const body: PublicNoteBody = { title: "公開的筆記", ydoc: ydocBase64(() => {}) };
    const { fn, calls } = mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? { status: 200, body } : null));
    vi.stubGlobal("fetch", fn);

    renderPage();

    await screen.findByTestId("public-note-editor");
    expect(screen.queryByRole("button", { name: "Favorite" })).toBeNull();
    expect(calls.some((c) => c.includes("/api/favorites"))).toBe(false);
  });

  it("別名形 /p/<handle>/<slug>（#122）：打 by-path 端點、path 形 ref 交給編輯器、零 auth fetch", async () => {
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
    // 快取真的落在 by-path key（突變驗證）：queryKey 若寫死 token 形，URL 與畫面
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
        ? { status: 404, body: { error: { code: "not_found", message: "This link doesn't exist or no longer works." } } }
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
    const { fn, calls } = mockFetch((url) =>
      url === `/api/public/notes/${TOKEN}`
        ? { status: 429, body: { error: { code: "too_many_requests", message: "請求過於頻繁" } } }
        : null,
    );
    vi.stubGlobal("fetch", fn);

    renderPage();

    // 逐字斷 errors.too_many_requests 的文案（不是 errors.fallback）——非 404 分支
    // 塌縮成一律 fallback 的突變要在這裡紅。
    await waitFor(() => expect(screen.getByText("Too many requests. Please slow down.")).toBeInTheDocument());
    // 頁面的 `retry: false` 守門（見 renderPage 註解）：節流後還重試三次只會更糟。
    expect(calls).toEqual([`GET /api/public/notes/${TOKEN}`]);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("This link doesn't exist or is no longer active.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("public-note-editor")).not.toBeInTheDocument();
  });

  // 背景 refetch（react-query 預設 focus/reconnect 會重抓）的兩條呈現規則（
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

    respond = { status: 404, body: { error: { code: "not_found", message: "This link doesn't exist or no longer works." } } };
    await act(async () => {
      await queryClient.refetchQueries();
    });

    await waitFor(() =>
      expect(screen.getByText("This link doesn't exist or is no longer active.")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("public-note-editor")).not.toBeInTheDocument();
  });

  it("#269：payload 的 links 交給唯讀編輯器；舊 server（沒有 links）當成 []", async () => {
    const links = [{ id: "11111111-1111-4111-8111-111111111111", title: "T", path: "/p/a/b" }];
    const { fn } = mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? { status: 200, body: { title: "N", ydoc: EMPTY_YDOC_UPDATE_B64, links } } : null));
    vi.stubGlobal("fetch", fn);
    renderPage();
    expect(await screen.findByTestId("public-note-editor")).toHaveAttribute("data-links", JSON.stringify(links));
  });

  describe("#297 公開頁寬度（payload 的 width）", () => {
    const STANDARD_MAX = "max-w-[clamp(42.5rem,85%,66rem)]";
    async function columnFor(body: PublicNoteBody): Promise<HTMLElement> {
      const { fn } = mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? { status: 200, body } : null));
      vi.stubGlobal("fetch", fn);
      renderPage();
      await screen.findByTestId("public-note-editor");
      return screen.getByTestId("article-column");
    }

    it("P1 width: full → 全寬，沒有標準的 max-w", async () => {
      const column = await columnFor({ title: "N", ydoc: EMPTY_YDOC_UPDATE_B64, width: "full" });
      expect(column).toHaveClass("mx-auto", "w-full", "max-w-none");
      expect(column).not.toHaveClass(STANDARD_MAX);
    });

    it("P2 缺 width（舊 server）→ 標準", async () => {
      const column = await columnFor({ title: "N", ydoc: EMPTY_YDOC_UPDATE_B64 });
      expect(column).toHaveClass("mx-auto", "w-full", STANDARD_MAX);
    });

    it("P3 不認得的 width → 標準", async () => {
      const column = await columnFor({ title: "N", ydoc: EMPTY_YDOC_UPDATE_B64, width: "bogus" });
      expect(column).toHaveClass("mx-auto", "w-full", STANDARD_MAX);
    });
  });

  describe("#465 右側標題大綱", () => {
    beforeEach(() => {
      window.localStorage.clear();
    });
    afterEach(() => {
      window.localStorage.clear();
    });

    async function renderWithHeadings(entry?: string, width?: string) {
      outlineProps.length = 0;
      const body: PublicNoteBody = { title: "N", ydoc: EMPTY_YDOC_UPDATE_B64, ...(width !== undefined ? { width } : {}) };
      const { fn } = mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? { status: 200, body } : null));
      vi.stubGlobal("fetch", fn);
      renderPage(entry);
      await screen.findByTestId("public-note-editor");
    }

    it("桌機：掛在頁首之後、捲動容器之前（不在捲動容器裡）；拿到捲動容器與標題，沒有泡泡；沒有偏好時可以釘但沒釘", async () => {
      stubLayoutTier("docked");
      await renderWithHeadings();
      const stub = await screen.findByTestId("outline-stub");
      const header = screen.getByRole("banner");
      const column = screen.getByTestId("article-column");
      const scroll = column.parentElement!;
      expect(scroll).toHaveClass("overflow-y-auto");
      expect(header.compareDocumentPosition(stub) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(stub.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(scroll.contains(stub)).toBe(false);
      const props = outlineProps[outlineProps.length - 1]!;
      expect(props.scrollEl).toBe(scroll);
      expect(props.headings).toEqual([{ id: "h-intro", level: 2, text: "Intro" }]);
      expect(props.bubbleShown).toBe(false);
      expect(props.pinned).toBe(false);
      expect(props.pinAvailable).toBe(true);
      await waitFor(() => expect(column).toHaveClass(...articleColumn("standard", { pinMotion: true }).split(" ")));
    });

    it("標準寬＋釘住偏好 → 欄一出現就是釘住寬度、那一次沒有過場；一個畫格後才有過場；大綱拿到 pinned", async () => {
      window.localStorage.setItem(OUTLINE_PINNED_STORAGE_KEY, "1");
      stubLayoutTier("docked");
      // 欄每一次 class 的值（屬性變動紀錄的舊值，加上最後的現值）。
      const records: MutationRecord[] = [];
      const observer = new MutationObserver((list) => records.push(...list));
      observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
      await renderWithHeadings(undefined, "standard");
      await screen.findByTestId("outline-stub");
      const column = screen.getByTestId("article-column");
      await waitFor(() => expect(column).toHaveClass(...articleColumn("standard-pinned", { pinMotion: true }).split(" ")));
      records.push(...observer.takeRecords());
      observer.disconnect();
      const values = [...records.filter((r) => r.target === column).map((r) => r.oldValue ?? ""), column.className];
      const pinnedMax = ARTICLE_COLUMN_MAX["standard-pinned"].split(" ")[0]!;
      const firstPinned = values.find((c) => c.split(" ").includes(pinnedMax));
      expect(firstPinned, values.join("\n")).toBeDefined();
      expect(firstPinned!.split(" ")).not.toContain("transition-[max-width,left]");
      const props = outlineProps[outlineProps.length - 1]!;
      expect(props.pinned).toBe(true);
      expect(props.pinAvailable).toBe(true);
    });

    it("捲動容器固定保留捲軸位置（捲軸出現與否不改寬度，能不能釘不會在門檻附近來回切）", async () => {
      stubLayoutTier("docked");
      await renderWithHeadings();
      expect(screen.getByTestId("article-column").parentElement).toHaveClass("sm:[scrollbar-gutter:stable]");
    });

    it("全寬＋釘住偏好 → 欄是全寬、不能釘（只有細線）", async () => {
      window.localStorage.setItem(OUTLINE_PINNED_STORAGE_KEY, "1");
      stubLayoutTier("docked");
      await renderWithHeadings(undefined, "full");
      await screen.findByTestId("outline-stub");
      const column = screen.getByTestId("article-column");
      expect(column).toHaveClass(...articleColumn("full").split(" "));
      expect(column).not.toHaveClass("left-0");
      for (const c of ARTICLE_COLUMN_MAX["standard-pinned"].split(" ")) expect(column).not.toHaveClass(c);
      const props = outlineProps[outlineProps.length - 1]!;
      expect(props.pinned).toBe(false);
      expect(props.pinAvailable).toBe(false);
      expect(window.localStorage.getItem(OUTLINE_PINNED_STORAGE_KEY)).toBe("1");
    });

    it("640-767：同樣是手機形（泡泡、底部面板），沒有細線；768 以上才是細線", async () => {
      stubLayoutTier("compact");
      phoneStubs.bubble = [];
      await renderWithHeadings();
      await screen.findByTestId("bubble-stub");
      expect(outlineProps).toHaveLength(0);
      expect(phoneStubs.bubble[phoneStubs.bubble.length - 1]!.scrollTarget).toBe(screen.getByTestId("article-column").parentElement!);
    });

    it("手機：沒有細線；位置泡泡在捲動容器之外的零高度錨點裡、聽捲動容器的捲動，有底部面板；頁面沒有 ⋮", async () => {
      stubLayoutTier("phone");
      phoneStubs.bubble = [];
      phoneStubs.sheet = [];
      await renderWithHeadings();
      const bubble = await screen.findByTestId("bubble-stub");
      expect(screen.queryByTestId("outline-stub")).not.toBeInTheDocument();
      expect(outlineProps).toHaveLength(0);
      const scroll = screen.getByTestId("article-column").parentElement!;
      const props = phoneStubs.bubble[phoneStubs.bubble.length - 1]!;
      expect(props.placement).toBe("anchor");
      expect(props.scrollTarget).toBe(scroll);
      expect(props.headings).toEqual([{ id: "h-intro", level: 2, text: "Intro" }]);
      expect(scroll.contains(bubble)).toBe(false);
      expect(bubble.closest("[data-outline-anchor]")).not.toBeNull();
      expect(screen.getByTestId("sheet-stub")).toHaveAttribute("data-open", "false");
      // 唯讀頁：沒有編輯區要避讓。
      expect(props.inputRoot ?? null).toBeNull();
      expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
      act(() => bubble.click());
      expect(screen.getByTestId("sheet-stub")).toHaveAttribute("data-open", "true");
      // 面板關閉時焦點回到點開它的泡泡（沒有觸發鈕，不然會掉到 body）。
      const restore = phoneStubs.sheet[phoneStubs.sheet.length - 1]!.restoreFocus;
      expect(restore).toEqual(expect.any(Function));
      act(() => restore!());
      expect(document.activeElement).toBe(bubble);
    });

    it("桌機：沒有泡泡與底部面板", async () => {
      stubLayoutTier("docked");
      phoneStubs.bubble = [];
      phoneStubs.sheet = [];
      await renderWithHeadings();
      await screen.findByTestId("outline-stub");
      expect(screen.queryByTestId("bubble-stub")).not.toBeInTheDocument();
      expect(phoneStubs.sheet).toHaveLength(0);
    });

    it("簡報中（?present）：桌機也不掛", async () => {
      stubLayoutTier("docked");
      await renderWithHeadings(`/p/${TOKEN}?present`);
      expect(await screen.findByTestId("presentation-stub")).toBeInTheDocument();
      await act(async () => {});
      expect(screen.queryByTestId("outline-stub")).not.toBeInTheDocument();
      expect(outlineProps).toHaveLength(0);
    });
  });
});
