import { StrictMode, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation, useNavigate, type InitialEntry } from "react-router";
import * as Y from "yjs";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import type { CollabState } from "@/collab/connection";
import { OWNER_PERMS } from "@/test/fixtures";
import { installFakeFullscreen, type FakeFullscreen } from "@/test/fake-fullscreen";
import { enterPresentationFullscreen } from "@/present/fullscreen";

vi.mock("@/components/NoteEditor", () => ({
  NoteEditor: ({ editable, headerSlot, footerSlot }: { editable: boolean; headerSlot?: ReactNode; footerSlot?: ReactNode }) => (
    <div data-testid="note-editor" data-editable={String(editable)}>
      {headerSlot}
      {footerSlot}
    </div>
  ),
}));

const nav = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("react-router", async (importOriginal) => {
  const mod = await importOriginal<typeof import("react-router")>();
  return {
    ...mod,
    useNavigate: () => {
      const real = mod.useNavigate();
      return ((...args: Parameters<typeof real>) => {
        nav.fn(...args);
        return real(...args);
      }) as typeof real;
    },
  };
});

function createStubProvider() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    synced: true,
    on(event: string, fn: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
    },
  };
}

const collab = vi.hoisted(() => ({
  state: { phase: "connected", role: "owner" } as CollabState,
  onUnauthorized: undefined as (() => void) | undefined,
  doc: undefined as unknown as Y.Doc,
  provider: undefined as unknown as ReturnType<typeof createStubProvider>,
}));
vi.mock("@/collab/useCollab", () => ({
  useCollab: ({ onUnauthorized }: { onUnauthorized: () => void }) => {
    collab.onUnauthorized = onUnauthorized;
    return { state: collab.state, doc: collab.doc, provider: collab.provider, synced: collab.provider.synced };
  },
}));

/** lazy 簡報層的替身：stub＝立刻宣告就緒並模擬 reveal 的 keyboard[27]；pending／fail＝chunk 載入中／失敗；fatal＝呼叫 onFatal。 */
const stub = vi.hoisted(() => ({
  mode: "stub" as "stub" | "pending" | "fail",
  fatal: null as string | null,
  mounts: 0,
  /** overlay 卸載（layout cleanup）當下頁面上的網址——外殼被閘門拿掉的那一 render，router 的 location 是什麼。 */
  shellGoneLoc: null as string | null,
}));
vi.mock("@/present/lazy", async () => {
  const { lazy, useEffect: useEffectInMock, useLayoutEffect: useLayoutEffectInMock } = await import("react");
  const { usePresentationShell } = await import("@/present/PresentationShell");
  function StubOverlay({ variant, title }: { variant: string; title: string }) {
    const shell = usePresentationShell();
    useLayoutEffectInMock(
      () => () => {
        stub.shellGoneLoc = document.querySelector("[data-testid=loc]")?.textContent ?? null;
      },
      [],
    );
    useEffectInMock(() => {
      stub.mounts += 1;
      if (stub.fatal) {
        shell.onFatal(stub.fatal);
        return;
      }
      shell.onRevealReady(true);
      const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") shell.onEsc();
      };
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("keydown", onKey);
        shell.onRevealReady(false);
      };
    }, [shell]);
    return <div data-testid="present-overlay" data-variant={variant} data-title={title} />;
  }
  const Pending = lazy(() => new Promise<{ default: () => null }>(() => {}));
  const Failing = lazy(() =>
    Promise.reject<{ default: () => null }>(new TypeError("Failed to fetch dynamically imported module: /assets/PresentationOverlay-x.js")),
  );
  function LazyPresentation(props: { variant: string; title: string }) {
    if (stub.mode === "pending") return <Pending />;
    if (stub.mode === "fail") return <Failing />;
    return <StubOverlay {...props} />;
  }
  return { LazyPresentation };
});

const { default: NotePage } = await import("./NotePage");

const USER: UserDto = { id: "u1", email: "a@example.com", handle: "tester", displayName: "Ann", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true };
const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111", title: "My Note", ownerId: "u1", role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", slug: "my-note", slugIsCustom: true,
  prevSlug: null, ownerHandle: "tester", lastEdited: null, group: null, groupId: null, permissions: OWNER_PERMS,
};

function respond(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response;
}

/** 假 server：`notes` 可以是一篇、或某支端點回錯；`list` 是側欄清單。 */
function stubFetch({ note = NOTE as NoteDto | { status: number; code: string }, list = [NOTE] as NoteDto[] } = {}) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/groups") return Promise.resolve(respond(200, []));
    if (url === "/api/auth/me") return Promise.resolve(respond(200, USER));
    if (url === "/api/notes" && method === "GET") return Promise.resolve(respond(200, list));
    if (url.endsWith("/backlinks")) return Promise.resolve(respond(200, { backlinks: [] }));
    if (url.endsWith("/links") && method === "POST") return Promise.resolve(respond(204, null));
    if (url.startsWith("/api/notes/") && method === "GET") {
      return Promise.resolve("status" in note ? respond(note.status, { error: { code: note.code, message: "x" } }) : respond(200, note));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{`${location.pathname}${location.search}${location.hash}`}</div>;
}

function Routed() {
  return (
    <ActiveNoteProvider>
      <LocationProbe />
      <Routes>
        <Route path="/notes/:ref" element={<NotePage />} />
        <Route path="/n/:handle/:slug" element={<NotePage />} />
        <Route path="/login" element={<div>login page</div>} />
        <Route path="/" element={<div>home landing</div>} />
      </Routes>
    </ActiveNoteProvider>
  );
}

function renderPresent(entries: InitialEntry[], { strict = false, browser = false }: { strict?: boolean; browser?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = browser ? <BrowserRouter><Routed /></BrowserRouter> : <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}><Routed /></MemoryRouter>;
  const tree = (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        {router}
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  );
  return { ...render(strict ? <StrictMode>{tree}</StrictMode> : tree), queryClient };
}

const loc = () => screen.getByTestId("loc").textContent;
const dialog = () => screen.getByRole("dialog", { name: "My Note — presentation" });

describe("NotePage × 簡報（spec §6.1、§6.5、§13.2）", () => {
  let fake: FakeFullscreen | null = null;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    collab.state = { phase: "connected", role: "owner" };
    collab.doc = new Y.Doc();
    collab.provider = createStubProvider();
    collab.onUnauthorized = undefined;
    stub.mode = "stub";
    stub.fatal = null;
    stub.mounts = 0;
    stub.shellGoneLoc = null;
    nav.fn.mockClear();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/n/tester/my-note?present");
    dismissAllToasts();
  });

  afterEach(async () => {
    await fake?.uninstall();
    fake = null;
    collab.doc.destroy();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("test 1：?present → 外殼與 overlay 掛上、AppShell 帶 inert；沒有 ?present → 都沒有", async () => {
    stubFetch();
    const first = renderPresent(["/n/tester/my-note?present"]);
    expect(await screen.findByTestId("present-overlay")).toHaveAttribute("data-variant", "member");
    expect(screen.getByTestId("present-overlay")).toHaveAttribute("data-title", "My Note");
    expect(screen.getByTestId("note-editor").closest("[inert]")).not.toBeNull();
    first.unmount();
    renderPresent(["/n/tester/my-note"]);
    await screen.findByTestId("note-editor");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("note-editor").closest("[inert]")).toBeNull();
  });

  it("test 21：外殼與 overlay 的任何祖先都沒有 inert", async () => {
    stubFetch();
    renderPresent(["/n/tester/my-note?present"]);
    const overlay = await screen.findByTestId("present-overlay");
    expect(overlay.closest("[inert]")).toBeNull();
    expect(dialog().closest("[inert]")).toBeNull();
  });

  it("test 1／2：Esc 一次 → 回筆記（拿掉 ?present）、navigate 恰一次、編輯器同一實例", async () => {
    stubFetch();
    renderPresent(["/n/tester/my-note?present"]);
    await screen.findByTestId("present-overlay");
    const editor = screen.getByTestId("note-editor");
    nav.fn.mockClear();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(loc()).toBe("/n/tester/my-note"));
    expect(nav.fn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("note-editor")).toBe(editor);
  });

  it("test 5：播放中 Ctrl+K 讓路（寬：不聚焦搜尋框；窄：不開抽屜）", async () => {
    stubFetch();
    renderPresent(["/n/tester/my-note?present"]);
    await screen.findByTestId("present-overlay");
    const search = screen.getAllByLabelText("Search notes")[0];
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).not.toBe(search);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.querySelector("[data-sidebar-drawer]")).toBeNull();
  });

  /** 退全螢幕早於導往 target 的那次 navigate。 */
  function expectExitBeforeNavigate(target: string) {
    const navIndex = nav.fn.mock.calls.findIndex((call) => call[0] === target);
    expect(navIndex).toBeGreaterThanOrEqual(0);
    expect(fake!.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(fake!.exitFullscreen.mock.invocationCallOrder[0]).toBeLessThan(nav.fn.mock.invocationCallOrder[navIndex]);
  }

  it("test 4：401 出口在 navigate('/login') 之前退出我們的全螢幕", async () => {
    stubFetch();
    fake = installFakeFullscreen();
    renderPresent(["/n/tester/my-note?present"]);
    await screen.findByTestId("present-overlay");
    enterPresentationFullscreen();
    await act(async () => fake!.grantEventFirst());
    nav.fn.mockClear();
    act(() => collab.onUnauthorized!());
    await waitFor(() => expect(loc()).toBe("/login"));
    expectExitBeforeNavigate("/login");
  });

  it("test 4／8：共編終態（kicked）出口在 navigate('/') 之前退出我們的全螢幕", async () => {
    // 比照 NotePage.test.tsx「kicked 終態」案：終態在 render 前設好。
    stubFetch();
    fake = installFakeFullscreen();
    enterPresentationFullscreen();
    await act(async () => fake!.grantEventFirst());
    collab.state = { phase: "kicked" } as CollabState;
    renderPresent(["/n/tester/my-note?present"]);
    await waitFor(() => expect(loc()).toBe("/"));
    expectExitBeforeNavigate("/");
  });

  it("test 14：解析 404（linkInvalid，例如側欄別篇）→ 先退全螢幕、toast note.linkInvalid、導 /", async () => {
    stubFetch({ note: { status: 404, code: "not_found" } });
    fake = installFakeFullscreen();
    enterPresentationFullscreen();
    await act(async () => fake!.grantEventFirst());
    renderPresent(["/notes/missing?present"]);
    await waitFor(() => expect(loc()).toBe("/"));
    expect(await screen.findByText("This link is invalid or the note doesn't exist.")).toBeInTheDocument();
    expect(fake.exitFullscreen).toHaveBeenCalledTimes(1);
    const navIndex = nav.fn.mock.calls.findIndex((call) => call[0] === "/");
    expect(fake.exitFullscreen.mock.invocationCallOrder[0]).toBeLessThan(nav.fn.mock.invocationCallOrder[navIndex]);
  });

  it("常駐層 404（noteGone）→ 先退全螢幕再導 /", async () => {
    const fetchFn = stubFetch();
    fake = installFakeFullscreen();
    const { queryClient } = renderPresent(["/n/tester/my-note?present"]);
    await screen.findByTestId("present-overlay");
    enterPresentationFullscreen();
    await act(async () => fake!.grantEventFirst());
    fetchFn.mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(String(input).startsWith(`/api/notes/${NOTE.id}`) ? respond(404, { error: { code: "not_found", message: "x" } }) : respond(200, [])),
    );
    await act(async () => queryClient.invalidateQueries({ queryKey: ["note", NOTE.id] }));
    await waitFor(() => expect(loc()).toBe("/"));
    expectExitBeforeNavigate("/");
    // 外殼被 `!leavingRef.current` 閘門拿掉的那一 render，router 的 location 仍是 ?present（react-router 以 startTransition 更新 location，
    // noteGone 出口的 setActiveNoteId(null) 先提交一次 render）——拿掉閘門，外殼要多活到 location 變成 "/" 才卸載。
    expect(stub.shellGoneLoc).toBe("/n/tester/my-note?present");
  });

  it("test 4（K 案）：<StrictMode> 下以 ?present 掛載、已在我們的全螢幕 → 假卸載不退全螢幕", async () => {
    stubFetch();
    fake = installFakeFullscreen();
    enterPresentationFullscreen();
    await act(async () => fake!.grantEventFirst());
    renderPresent(["/n/tester/my-note?present"], { strict: true });
    await screen.findByTestId("present-overlay");
    expect(fake.exitFullscreen).not.toHaveBeenCalled();
  });

  it("test 20：解析回 500 → 外殼錯誤態＋×；× 離開", async () => {
    stubFetch({ note: { status: 500, code: "internal" } });
    renderPresent(["/notes/x?present"]);
    // 頁面本體的錯誤卡也帶 role=alert（且在 inert 內仍查得到），所以限定在簡報 dialog 內查外殼自己的錯誤態。
    const shellDialog = await screen.findByRole("dialog");
    expect(await within(shellDialog).findByRole("alert")).toHaveTextContent("Something went wrong. Please try again.");
    fireEvent.click(screen.getByRole("button", { name: "Exit presentation" }));
    await waitFor(() => expect(loc()).toBe("/notes/x"));
  });

  it("test 20：chunk 載入失敗（額度已用）→ 錯誤卡在外殼內；Esc 一樣離開", async () => {
    stubFetch();
    stub.mode = "fail";
    sessionStorage.setItem("knotebook:chunk-reload:present", "1");
    renderPresent(["/n/tester/my-note?present"]);
    expect(await screen.findByText(/Couldn't load this page/)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(loc()).toBe("/n/tester/my-note"));
  });

  it("test 20：chunk 載入中 → DOM 恰一個 [role=dialog]；Esc 一次 → navigate 恰一次", async () => {
    stubFetch();
    stub.mode = "pending";
    renderPresent(["/n/tester/my-note?present"]);
    await screen.findByTestId("note-editor");
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    nav.fn.mockClear();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(loc()).toBe("/n/tester/my-note"));
    expect(nav.fn).toHaveBeenCalledTimes(1);
  });

  it("test 20：overlay 回報 configRefused → 外殼顯示文案、overlay 卸載；Esc 一次 → navigate 恰一次", async () => {
    stubFetch();
    stub.fatal = "present.configRefused";
    renderPresent(["/n/tester/my-note?present"]);
    expect(await screen.findByText("Presentation settings were unexpected, so playback stopped")).toBeInTheDocument();
    expect(screen.queryByTestId("present-overlay")).toBeNull();
    nav.fn.mockClear();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(nav.fn).toHaveBeenCalledTimes(1));
  });

  it("共編首次 synced 之前不掛 overlay（m9）：外殼是載入態", async () => {
    stubFetch();
    collab.provider.synced = false;
    renderPresent(["/n/tester/my-note?present"]);
    await screen.findByTestId("note-editor");
    expect(dialog()).toHaveTextContent("Loading…");
    expect(screen.queryByTestId("present-overlay")).toBeNull();
  });
});

describe("NotePage × 簡報（BrowserRouter：網址寫入點、上一頁）", () => {
  let fake: FakeFullscreen | null = null;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    collab.state = { phase: "connected", role: "owner" };
    collab.doc = new Y.Doc();
    collab.provider = createStubProvider();
    stub.mode = "stub";
    stub.fatal = null;
    nav.fn.mockClear();
  });

  afterEach(async () => {
    await fake?.uninstall();
    fake = null;
    collab.doc.destroy();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it.each([
    [`/notes/${"11111111-1111-1111-1111-111111111111"}?present#/x`, "/n/tester/my-note?present#/x"],
    [`/notes/${"11111111-1111-1111-1111-111111111111"}?present&hash=true#/x`, "/n/tester/my-note?present#/x"],
  ])("test 18：%s → 最終 %s（正規化與收斂兩個寫入點不互相覆蓋）", async (start, expected) => {
    stubFetch();
    window.history.replaceState(null, "", start);
    renderPresent([], { browser: true });
    await waitFor(() => expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(expected));
    await screen.findByTestId("present-overlay");
  });

  it("RF4：播放中（已全螢幕）按瀏覽器上一頁 → 退出全螢幕、回筆記頁、編輯器同一實例", async () => {
    stubFetch();
    fake = installFakeFullscreen();
    window.history.replaceState(null, "", "/n/tester/my-note");
    let go: ((to: { pathname: string; search: string }, state: unknown) => void) | null = null;
    function Pusher() {
      const navigate = useNavigate();
      useEffect(() => {
        go = (to, state) => void navigate(to, { state });
      }, [navigate]);
      return null;
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <BrowserRouter>
            <Pusher />
            <Routed />
          </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const editor = await screen.findByTestId("note-editor");
    enterPresentationFullscreen();
    await act(async () => fake!.grantEventFirst());
    act(() => go!({ pathname: "/n/tester/my-note", search: "?present" }, { knotebookPresentPushed: true }));
    await screen.findByTestId("present-overlay");
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(window.location.search).toBe(""));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("note-editor")).toBe(editor);
  });

  it("S9（§6.3-4【推】）：帶旗標進入 → 播放中改名 → Esc → navigate(-1) 回到舊網址那筆 → 留在同一篇、收斂到新網址、編輯器不重掛", async () => {
    stubFetch();
    window.history.replaceState(null, "", "/n/tester/my-note");
    let go: ((to: { pathname: string; search: string }, state: unknown) => void) | null = null;
    function Pusher() {
      const navigate = useNavigate();
      useEffect(() => {
        go = (to, state) => void navigate(to, { state });
      }, [navigate]);
      return null;
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <BrowserRouter>
            <Pusher />
            <Routed />
          </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const editor = await screen.findByTestId("note-editor");
    act(() => go!({ pathname: "/n/tester/my-note", search: "?present" }, { knotebookPresentPushed: true }));
    await screen.findByTestId("present-overlay");
    await act(async () => {
      queryClient.setQueryData(["note", NOTE.id], { ...NOTE, title: "Renamed", slug: "renamed" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(window.location.pathname).toBe("/n/tester/renamed"));
    expect(window.location.search).toBe("?present");
    nav.fn.mockClear();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(`${window.location.pathname}${window.location.search}`).toBe("/n/tester/renamed"));
    // 走的是 navigate(-1)（帶旗標進入），不是 replace：Esc 那一下的 navigate 恰一次且為 -1。
    expect(nav.fn.mock.calls.filter((call) => call[0] === -1)).toHaveLength(1);
    expect(screen.getByTestId("note-editor")).toBe(editor);
  });
});

describe("NotePage × ⋮ 進入簡報", () => {
  let fake: FakeFullscreen | null = null;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    collab.state = { phase: "connected", role: "owner" };
    collab.doc = new Y.Doc();
    collab.provider = createStubProvider();
    stub.mode = "stub";
    stub.fatal = null;
    nav.fn.mockClear();
    fake = installFakeFullscreen();
    dismissAllToasts();
  });

  afterEach(async () => {
    await fake?.uninstall();
    fake = null;
    collab.doc.destroy();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("test 16：從頁首 ⋮ 進入 → 選單關閉後焦點在簡報層根（Radix 不把焦點還給 inert 背景裡的觸發鈕）", async () => {
    stubFetch();
    window.history.replaceState(null, "", "/n/tester/my-note");
    renderPresent(["/n/tester/my-note"]);
    await screen.findByTestId("note-editor");
    fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Present" }));
    const shell = await screen.findByRole("dialog", { name: "My Note — presentation" });
    await waitFor(() => expect(document.activeElement).toBe(shell));
    await new Promise((resolve) => setTimeout(resolve, 30)); // Radix FocusScope 的卸載回焦在 setTimeout(0)
    expect(document.activeElement).toBe(shell);
  });

  it("test 4（K 案，從選單）：<StrictMode>＋BrowserRouter 從 ⋮ 進入 → 全螢幕 resolve 後 exitFullscreen 未被呼叫", async () => {
    stubFetch();
    window.history.replaceState(null, "", "/n/tester/my-note");
    renderPresent([], { strict: true, browser: true });
    await screen.findByTestId("note-editor");
    fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Present" }));
    await screen.findByTestId("present-overlay");
    await act(async () => fake!.grantEventFirst());
    expect(fake!.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(fake!.exitFullscreen).not.toHaveBeenCalled();
  });

  it("test 14：側欄 ⋮ 到別篇、該篇解析 404 → exitFullscreen 被呼叫、toast note.linkInvalid、導 /", async () => {
    const OTHER: NoteDto = { ...NOTE, id: "22222222-2222-2222-2222-222222222222", title: "Other", slug: "other" };
    const fetchFn = stubFetch({ list: [NOTE, OTHER] });
    const base = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/notes/by-path/tester/other"
        ? Promise.resolve(respond(404, { error: { code: "not_found", message: "x" } }))
        : base(input, init),
    );
    window.history.replaceState(null, "", "/n/tester/my-note");
    renderPresent(["/n/tester/my-note"]);
    await screen.findByTestId("note-editor");
    const section = await screen.findByTestId("notegroup-myNotes");
    fireEvent.pointerDown(await within(section).findByRole("button", { name: "Note actions for Other" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Present" }));
    expect(fake!.requestFullscreen).toHaveBeenCalledTimes(1);
    await act(async () => fake!.grantEventFirst());
    await waitFor(() => expect(loc()).toBe("/"));
    expect(await screen.findByText("This link is invalid or the note doesn't exist.")).toBeInTheDocument();
    expect(fake!.exitFullscreen).toHaveBeenCalledTimes(1);
  });
});
