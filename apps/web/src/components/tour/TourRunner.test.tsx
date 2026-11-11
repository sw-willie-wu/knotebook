import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams, type NavigateFunction } from "react-router";
import { canonicalNotePath, type AiActionDto, type NoteDto, type UserDto } from "@knotebook/shared";
import type { CollabState } from "@/collab/connection";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { NARROW_QUERY } from "@/lib/sidebar-drawer";
import { SidebarQueryProvider } from "@/lib/sidebar-query";
import { getShellControls } from "@/lib/tour-bridge";
import { findDrawerButton, findTourTarget, findUserMenuTrigger, type TourTargetId } from "@/lib/tour-targets";
import { useVersionsController, VersionsProvider } from "@/lib/versions-context";
import { ThemeProvider } from "@/theme";
import { Toaster } from "@/components/ui/toast";
import { AppShell, SidebarDrawerButton } from "@/components/AppShell";
import { CornerStack } from "@/components/CornerStack";
import { NarrowTopBar } from "@/components/NarrowTopBar";
import { NoteMenu } from "@/components/NoteMenu";
import { ShareDialog } from "@/components/ShareDialog";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { HOLE_PADDING } from "./geometry";
import { TARGET_TIMEOUT_MS, waitForFrames, type TourStopEntry } from "./engine";
import type { StopDef, StopId } from "./stops";
import { TourRunner, type TourRunnerProps } from "./TourRunner";

// 測試宿主照 App 的接線：導覽住在 `<Routes>` 外面；首頁與筆記頁各自渲染一份 AppShell（換頁時側欄換新的一份）。
// 筆記頁放頁首那批元件（漢堡鈕、分享、⋮、標題框）與右下角的版本泡泡。

const USER: UserDto = {
  id: "u1",
  email: "a@example.com",
  handle: "tester",
  displayName: "Ann",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
};

function noteDto(id: string, title: string, slug: string): NoteDto {
  return {
    id,
    title,
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug,
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
  };
}

const SAMPLE = noteDto("77777777-7777-7777-7777-777777777777", "Welcome to Knotebook", "welcome-to-knotebook");
const OTHER = noteDto("88888888-8888-8888-8888-888888888888", "Groceries", "groceries");
const NOTES = [SAMPLE, OTHER];
const SAMPLE_PATH = canonicalNotePath(SAMPLE);
const OTHER_PATH = canonicalNotePath(OTHER);
const CONNECTED: CollabState = { phase: "connected", role: "owner" };
const AI_ACTION: AiActionDto = { id: "rewrite", name: "Rewrite", applyMode: "preview", kind: "quick" };

// ── 假 server ────────────────────────────────────────────────────────────────

interface FetchCall {
  method: string;
  url: string;
  /** 發出請求當下的位置。 */
  at: string;
}

let calls: FetchCall[] = [];
let aiActions: AiActionDto[] | "error" = [];
let deleteStatus = 204;
/** 設了就讓 `GET /api/ai/actions` 卡到它 resolve。 */
let aiGate: Promise<void> | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, at: currentPath });
      if (url === "/api/groups") return json([]);
      if (url === "/api/auth/me") return json(USER);
      if (url === "/api/folders") return json(FOLDER_LIST_EMPTY);
      if (url === "/api/notes" && method === "GET") return json(NOTES);
      if (url === "/api/ai/actions") await aiGate;
      if (url === "/api/ai/actions") return aiActions === "error" ? json({ error: { code: "internal", message: "x" } }, 500) : json({ actions: aiActions });
      if (url.startsWith("/api/notes/") && method === "DELETE") {
        return deleteStatus === 204 ? new Response(null, { status: 204 }) : json({ error: { code: "internal", message: "x" } }, deleteStatus);
      }
      return json({ error: { code: "not_found", message: url } }, 404);
    }),
  );
}

// ── 視窗寬窄與元素尺寸 ────────────────────────────────────────────────────────

type MediaListener = (event: { matches: boolean }) => void;
let narrowNow = false;
/** 只收 `NARROW_QUERY` 的監聽；其他查詢（例如主題的深色模式）恆不符合、不會變。 */
const mediaListeners = new Set<MediaListener>();

function stubViewport(narrow: boolean) {
  narrowNow = narrow;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      const listeners = query === NARROW_QUERY ? mediaListeners : new Set<MediaListener>();
      return {
        get matches() {
          return query === NARROW_QUERY ? narrowNow : false;
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, fn: MediaListener) => listeners.add(fn),
        removeEventListener: (_type: string, fn: MediaListener) => listeners.delete(fn),
        addListener: (fn: MediaListener) => listeners.add(fn),
        removeListener: (fn: MediaListener) => listeners.delete(fn),
        dispatchEvent: () => false,
      };
    }),
  );
}

function setNarrow(narrow: boolean) {
  narrowNow = narrow;
  act(() => {
    for (const fn of [...mediaListeners]) fn({ matches: narrow });
  });
}

const RECTS: Record<TourTargetId, [number, number, number, number]> = {
  tabs: [10, 60, 200, 30],
  newNote: [10, 600, 200, 36],
  newFolder: [180, 100, 24, 24],
  search: [10, 20, 200, 30],
  share: [900, 10, 60, 30],
  noteMenu: [970, 10, 30, 30],
  versions: [1200, 650, 40, 40],
  userMenu: [10, 650, 200, 40],
  drawerButton: [5, 5, 32, 32],
};
/** 尺寸是 0 的目標（＝畫面上看不到）。 */
let hiddenTargets = new Set<TourTargetId>();

function stubRects() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const id = this.getAttribute("data-kb-tour-target") as TourTargetId | null;
    if (id === null || hiddenTargets.has(id)) return new DOMRect(0, 0, 0, 0);
    return new DOMRect(...RECTS[id]);
  });
}

function hole(): { x: number; y: number; width: number; height: number } | null {
  const el = document.querySelector("[data-tour-hole]");
  if (el === null) return null;
  return { x: Number(el.getAttribute("x")), y: Number(el.getAttribute("y")), width: Number(el.getAttribute("width")), height: Number(el.getAttribute("height")) };
}

function padded([left, top, width, height]: [number, number, number, number]) {
  return { x: left - HOLE_PADDING, y: top - HOLE_PADDING, width: width + HOLE_PADDING * 2, height: height + HOLE_PADDING * 2 };
}

// ── 宿主 ────────────────────────────────────────────────────────────────────

let currentPath = "";
let routerNavigate: NavigateFunction | null = null;

function LocationProbe() {
  const location = useLocation();
  currentPath = location.pathname + location.search;
  routerNavigate = useNavigate();
  return null;
}

function HomeStandIn() {
  return (
    <AppShell>
      <NarrowTopBar />
    </AppShell>
  );
}

function NoteStandIn() {
  const { slug } = useParams();
  const note = NOTES.find((n) => n.slug === slug)!;
  const versions = useVersionsController({ noteId: note.id, enabled: true });
  return (
    <AppShell>
      <VersionsProvider value={versions}>
        <header data-note-id={note.id}>
          <SidebarDrawerButton />
          <input data-note-title-input="" aria-label="Note title" defaultValue={note.title} />
          <ShareDialog note={note} />
          <NoteMenu note={note} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} />
        </header>
        <CornerStack />
      </VersionsProvider>
    </AppShell>
  );
}

let queryClient: QueryClient;

function Host({ initial, runner }: { initial: string; runner: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[initial]}>
          <SidebarQueryProvider>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/" element={<HomeStandIn />} />
                <Route path="/n/:handle/:slug" element={<NoteStandIn />} />
                <Route path="/login" element={<main>Login</main>} />
              </Routes>
              {runner}
              <LocationProbe />
            </ActiveNoteProvider>
          </SidebarQueryProvider>
        </MemoryRouter>
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

/** 照開始流程的形：導到示範筆記、等它的頁面掛上才回傳。 */
async function fakePrepareSample(signal: AbortSignal): Promise<NoteDto | null> {
  act(() => void routerNavigate!(SAMPLE_PATH));
  const ready = await waitForFrames(() => (document.querySelector(`[data-note-id="${SAMPLE.id}"]`) ? true : null), signal, 5000);
  return ready === null ? null : SAMPLE;
}

/** 使用者選單入口傳的查找函式：寬視窗是側欄的帳號列、窄視窗是漢堡鈕。 */
const lookupTrigger = () => (window.matchMedia(NARROW_QUERY).matches ? findDrawerButton() : findUserMenuTrigger());

interface StartOptions {
  initial?: string;
  returnTo?: string;
  props?: Partial<TourRunnerProps>;
  strict?: boolean;
  /** 開始前在畫面上做的事（打開抽屜、打搜尋字）。 */
  before?: () => Promise<void> | void;
}

async function startTour({ initial = OTHER_PATH, returnTo = initial, props = {}, strict = false, before }: StartOptions = {}) {
  const onFinished = vi.fn();
  const prepareSample = vi.fn(fakePrepareSample);
  const onStarted = vi.fn();
  const runnerProps: TourRunnerProps = { returnTo, returnFocus: lookupTrigger, prepareSample, onStarted, onFinished, ...props };
  const wrap = (node: ReactNode) => (strict ? <StrictMode>{node}</StrictMode> : node);
  const view = render(wrap(<Host initial={initial} runner={null} />));
  await screen.findByRole("button", { name: USER.displayName });
  await before?.();
  const startedWith = { trigger: findUserMenuTrigger() };
  view.rerender(wrap(<Host initial={initial} runner={<TourRunner {...runnerProps} />} />));
  return {
    ...view,
    onStarted,
    onFinished,
    prepareSample: runnerProps.prepareSample,
    startedWith,
    unmountRunner: () => view.rerender(wrap(<Host initial={initial} runner={null} />)),
  };
}

const card = () => {
  const el = document.querySelector<HTMLElement>("[data-tour-card]");
  if (el === null) throw new Error("no tour card");
  return el;
};
const findCard = (title: string) => screen.findByRole("dialog", { name: title });
const overlay = () => document.querySelector("[data-tour-overlay]");
const progress = () => within(card()).getByText(/^\d+ \/ \d+$/).textContent;

async function next(expectTitle: string) {
  fireEvent.click(within(card()).getByRole("button", { name: "Next" }));
  await findCard(expectTitle);
}

const FULL_TITLES = ["Sidebar sections", "New note", "Folders", "Search", "Share and more", "Version history", "Forgot how something works?"];

async function goToLast() {
  await findCard(FULL_TITLES[0]!);
  for (const title of FULL_TITLES.slice(1)) await next(title);
}

/** 假站點：目標借用真元件上的屬性；`leave` 可以拿來數。 */
function fakeEntry(id: string, targetId: TourTargetId, extra: Partial<StopDef> = {}): TourStopEntry & { leave: ReturnType<typeof vi.fn> } {
  const leave = vi.fn();
  const stop: StopDef = {
    id: id as StopId,
    titleKey: `fake.${id}`,
    bodyKey: `fake.${id}.body`,
    target: () => {
      const el = findTourTarget(targetId);
      return el === null ? [] : [el];
    },
    leave,
    ...extra,
  };
  return { stop, leave };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  calls = [];
  aiActions = [];
  deleteStatus = 204;
  aiGate = null;
  hiddenTargets = new Set();
  mediaListeners.clear();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  stubFetch();
  stubViewport(false);
  stubRects();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.removeItem("sidebar.tab");
  routerNavigate = null;
});

describe("一輪完整導覽（寬視窗）", () => {
  it("從筆記頁打開：七站依序、挖洞對準每站的目標、n / N；最後〔保留示範筆記〕→ 回原頁、焦點在帳號列、不刪", async () => {
    const { onFinished } = await startTour();
    await findCard("Sidebar sections");
    expect(currentPath).toBe(SAMPLE_PATH);
    expect(progress()).toBe("1 / 7");
    expect(hole()).toEqual(padded(RECTS.tabs));

    const expected: [string, { x: number; y: number; width: number; height: number }][] = [
      ["New note", padded(RECTS.newNote)],
      ["Folders", padded(RECTS.newFolder)],
      ["Search", padded(RECTS.search)],
      // 分享鈕與 ⋮ 的聯集。
      ["Share and more", padded([900, 10, 100, 30])],
      ["Version history", padded(RECTS.versions)],
      ["Forgot how something works?", padded(RECTS.userMenu)],
    ];
    for (const [i, [title, rect]] of expected.entries()) {
      await next(title);
      expect(progress()).toBe(`${i + 2} / 7`);
      await waitFor(() => expect(hole()).toEqual(rect));
    }

    fireEvent.click(within(card()).getByRole("button", { name: "Keep sample note" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(overlay()).toBeNull();
    expect(currentPath).toBe(OTHER_PATH);
    // 焦點在帳號列，不是選單項。
    expect(document.activeElement).toBe(findUserMenuTrigger());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: USER.displayName }));
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("整輪只有一個遮罩實例（換站不重掛）；換站時報讀區讀出新的一站", async () => {
    await startTour();
    await findCard("Sidebar sections");
    const root = overlay();
    const announcement = () => document.querySelector("[data-tour-step-announcement]")?.textContent;
    expect(announcement()).toBe("");
    await next("New note");
    expect(overlay()).toBe(root);
    expect(announcement()).toContain("2 / 7");
    expect(announcement()).toContain("New note");
    await next("Folders");
    expect(overlay()).toBe(root);
    expect(document.querySelectorAll("[data-tour-overlay]")).toHaveLength(1);
  });

  it("上一步回前一站", async () => {
    await startTour();
    await findCard("Sidebar sections");
    await next("New note");
    fireEvent.click(within(card()).getByRole("button", { name: "Back" }));
    await findCard("Sidebar sections");
    expect(progress()).toBe("1 / 7");
  });
});

describe("開始流程", () => {
  it("示範筆記還沒準備好之前不蓋遮罩；prepareSample 收到中止訊號", async () => {
    let release: (note: NoteDto | null) => void = () => {};
    let received: AbortSignal | null = null;
    const prepareSample = vi.fn((signal: AbortSignal) => {
      received = signal;
      return new Promise<NoteDto | null>((resolve) => {
        release = resolve;
      });
    });
    const { unmountRunner } = await startTour({ props: { prepareSample } });
    await waitFor(() => expect(prepareSample).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(overlay()).toBeNull();
    unmountRunner();
    expect(received!.aborted).toBe(true);
    release(null);
  });

  it("prepareSample 回 null（沒辦法開始）→ 不出遮罩、onFinished 一次；AI 動作照樣只讀過一次（和準備示範筆記同時發出）", async () => {
    const prepareSample = vi.fn(async () => null);
    const { onFinished } = await startTour({ props: { prepareSample } });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(overlay()).toBeNull();
    expect(calls.filter((c) => c.url === "/api/ai/actions")).toHaveLength(1);
  });

  it("prepareSample 回 null → onStarted 不呼叫，onFinished 帶 started=false", async () => {
    const prepareSample = vi.fn(async () => null);
    const { onStarted, onFinished } = await startTour({ props: { prepareSample } });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(onFinished).toHaveBeenCalledWith({ started: false, reason: "aborted" });
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("讀 AI 動作期間離開頁面 → 第一站沒出現過：onStarted 不呼叫，onFinished 帶 started=false", async () => {
    let release: () => void = () => {};
    aiGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { onStarted, onFinished } = await startTour();
    await waitFor(() => expect(calls.some((c) => c.url === "/api/ai/actions")).toBe(true));
    act(() => void routerNavigate!("/login"));
    release();
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(onFinished).toHaveBeenCalledWith({ started: false, reason: "aborted" });
    expect(onStarted).not.toHaveBeenCalled();
    expect(overlay()).toBeNull();
    expect(currentPath).toBe("/login");
  });

  it("等第一站目標期間離開頁面 → onStarted 不呼叫，onFinished 帶 started=false", async () => {
    hiddenTargets = new Set(["tabs"]);
    const { onStarted, onFinished } = await startTour({ props: { stops: [fakeEntry("one", "tabs"), fakeEntry("two", "userMenu")] } });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/ai/actions")).toBe(true));
    await new Promise((r) => setTimeout(r, 300));
    expect(overlay()).toBeNull();
    expect(onStarted).not.toHaveBeenCalled();
    act(() => void routerNavigate!("/login"));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(onFinished).toHaveBeenCalledWith({ started: false, reason: "aborted" });
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("等第一站目標出現前不發 onStarted，目標出現後恰好一次", async () => {
    hiddenTargets = new Set(["tabs"]);
    const { onStarted } = await startTour({ props: { stops: [fakeEntry("one", "tabs"), fakeEntry("two", "userMenu")] } });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/ai/actions")).toBe(true));
    await new Promise((r) => setTimeout(r, 300));
    expect(overlay()).toBeNull();
    expect(onStarted).not.toHaveBeenCalled();
    hiddenTargets = new Set();
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 300));
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("第一站出現時 onStarted 恰好一次：換站、往回走、重繪都不再呼叫；正常結束 started=true", async () => {
    const { onStarted, onFinished } = await startTour();
    await findCard("Sidebar sections");
    expect(onStarted).toHaveBeenCalledTimes(1);
    await next("New note");
    await next("Folders");
    fireEvent.click(within(card()).getByRole("button", { name: "Back" }));
    await findCard("New note");
    fireEvent.click(within(card()).getByRole("button", { name: "Back" }));
    await findCard("Sidebar sections");
    setNarrow(true);
    await waitFor(() => expect(hole()).toEqual(padded(RECTS.drawerButton)));
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onFinished).not.toHaveBeenCalled();
  });

  it("結束的結果：〔保留示範筆記〕與〔刪除〕→ completed、✕ → closed，都是 started=true", async () => {
    for (const [name, reason] of [
      ["Keep sample note", "completed"],
      ["Delete sample note", "completed"],
      ["Close", "closed"],
    ] as const) {
      const { onStarted, onFinished, unmount } = await startTour();
      if (name === "Close") await findCard("Sidebar sections");
      else await goToLast();
      fireEvent.click(within(card()).getByRole("button", { name }));
      await waitFor(() => expect(onFinished, name).toHaveBeenCalledTimes(1));
      expect(onFinished, name).toHaveBeenCalledWith({ started: true, reason });
      expect(onStarted, name).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("進過站之後位置離開示範筆記 → started=true、reason=left", async () => {
    const { onFinished } = await startTour();
    await findCard("Sidebar sections");
    act(() => void routerNavigate!("/login"));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(onFinished).toHaveBeenCalledWith({ started: true, reason: "left" });
  });

  it("StrictMode（開發模式掛載會跑兩次 effect）：onStarted 也只呼叫一次", async () => {
    const { onStarted } = await startTour({ strict: true });
    await findCard("Sidebar sections");
    await new Promise((r) => setTimeout(r, 50));
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("StrictMode（開發模式掛載會跑兩次 effect）：示範筆記只準備一次、AI 動作只讀一次", async () => {
    const { prepareSample } = await startTour({ strict: true });
    await findCard("Sidebar sections");
    expect(prepareSample).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.url === "/api/ai/actions")).toHaveLength(1);
    expect(document.querySelectorAll("[data-tour-overlay]")).toHaveLength(1);
  });

  it("搜尋框有字：少掉 tab 列、資料夾、搜尋三站，從「新增筆記」開始、共 4 站", async () => {
    await startTour({
      before: () => {
        fireEvent.change(screen.getByRole("textbox", { name: "Search notes" }), { target: { value: "ab" } });
      },
    });
    await findCard("New note");
    expect(progress()).toBe("1 / 4");
  });
});

describe("站數讀的是開始時向 server 讀到的 AI 動作", () => {
  const aiOnly = (ctxAi: (n: number) => void) =>
    [
      fakeEntry("ai", "tabs", {
        precondition: (ctx) => {
          ctxAi(ctx.aiActions.length);
          return ctx.aiActions.length > 0;
        },
      }),
      fakeEntry("last", "userMenu"),
    ] satisfies TourStopEntry[];

  it("快取裡是空的、API 回非空 → AI 站在序列裡", async () => {
    queryClient.setQueryData(["ai-actions"], []);
    aiActions = [AI_ACTION];
    const seen: number[] = [];
    await startTour({ props: { stops: aiOnly((n) => seen.push(n)) } });
    await findCard("fake.ai");
    expect(progress()).toBe("1 / 2");
    expect(seen).toEqual([1]);
  });

  it("整輪只讀一次：在示範筆記準備好之前就發出，prepareSample 拿到的與算站點用的是同一次讀取", async () => {
    aiActions = [AI_ACTION];
    const seen: number[] = [];
    const order: string[] = [];
    let received: AiActionDto[] | null = null;
    const prepareSample = vi.fn(async (signal: AbortSignal, ai: Promise<AiActionDto[]>) => {
      const note = await fakePrepareSample(signal);
      order.push(`sample ready, ai fetched=${calls.some((c) => c.url === "/api/ai/actions")}`);
      received = await ai;
      // 之後再讀就是空的：站點若自己另讀一次，AI 站會不見。
      aiActions = [];
      return note;
    });
    await startTour({ props: { stops: aiOnly((n) => seen.push(n)), prepareSample } });
    await findCard("fake.ai");
    expect(order).toEqual(["sample ready, ai fetched=true"]);
    expect(received).toEqual([AI_ACTION]);
    expect(seen).toEqual([1]);
    expect(calls.filter((c) => c.url === "/api/ai/actions")).toHaveLength(1);
  });

  it("API 失敗 → 沒有 AI 站", async () => {
    aiActions = "error";
    await startTour({ props: { stops: aiOnly(() => {}) } });
    await findCard("fake.last");
    expect(progress()).toBe("1 / 1");
  });
});

describe("導覽中位置離開示範筆記 → 結束", () => {
  it("被導到 /login：遮罩消失、離站收拾一次、不導回原頁、onFinished", async () => {
    const first = fakeEntry("one", "tabs");
    const { onFinished } = await startTour({ props: { stops: [first, fakeEntry("two", "userMenu")] } });
    await findCard("fake.one");
    act(() => void routerNavigate!("/login"));
    await waitFor(() => expect(overlay()).toBeNull());
    expect(first.leave).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(currentPath).toBe("/login");
  });

  it("上一頁回到打開前的頁面：導覽結束、不重複導頁", async () => {
    const { onFinished } = await startTour();
    await findCard("Sidebar sections");
    act(() => void routerNavigate!(-1));
    await waitFor(() => expect(overlay()).toBeNull());
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(currentPath).toBe(OTHER_PATH);
  });

  it("同一篇只換 search（例如簡報模式的 ?present）不算離開", async () => {
    await startTour();
    await findCard("Sidebar sections");
    act(() => void routerNavigate!(`${SAMPLE_PATH}?x=1`));
    await new Promise((r) => setTimeout(r, 100));
    expect(overlay()).not.toBeNull();
  });
});

describe("鍵盤", () => {
  it("Esc：結束、回原頁、不刪示範筆記", async () => {
    const { onFinished } = await startTour();
    await findCard("Sidebar sections");
    await next("New note");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(overlay()).toBeNull();
    expect(currentPath).toBe(OTHER_PATH);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("導回原頁是取代歷史：結束後按上一頁不會回到示範筆記", async () => {
    const { onFinished } = await startTour();
    await findCard("Sidebar sections");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(currentPath).toBe(OTHER_PATH);
    act(() => void routerNavigate!(-1));
    await new Promise((r) => setTimeout(r, 50));
    expect(currentPath).toBe(OTHER_PATH);
  });

  it("✕ 與第 1 站的「跳過」也一樣：結束、回原頁、不刪", async () => {
    for (const name of ["Close", "Skip feature tour"]) {
      const { onFinished, unmount } = await startTour();
      await findCard("Sidebar sections");
      fireEvent.click(within(card()).getByRole("button", { name }));
      await waitFor(() => expect(onFinished, name).toHaveBeenCalledTimes(1));
      expect(currentPath, name).toBe(OTHER_PATH);
      unmount();
    }
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("導覽中 Ctrl+K 不聚焦搜尋框（沒有導覽時會）", async () => {
    await startTour();
    await findCard("Sidebar sections");
    const search = screen.getByRole("textbox", { name: "Search notes" });
    fireEvent.keyDown(document.activeElement!, { key: "k", ctrlKey: true });
    expect(document.activeElement).not.toBe(search);
    expect(document.activeElement).toBe(within(card()).getByRole("button", { name: "Next" }));

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(overlay()).toBeNull());
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(search);
  });

  it("焦點在「下一步」；Tab 在卡片內循環", async () => {
    await startTour();
    await findCard("Sidebar sections");
    const c = within(card());
    expect(document.activeElement).toBe(c.getByRole("button", { name: "Next" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(c.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(c.getByRole("button", { name: "Skip feature tour" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(c.getByRole("button", { name: "Close" }));
  });
});

describe("等不到目標就跳站", () => {
  it("版本泡泡一直是 0 尺寸 → 跳過那站，直接到最後一站（站號照原本的序）", async () => {
    hiddenTargets = new Set(["versions"]);
    await startTour();
    await findCard("Sidebar sections");
    for (const title of FULL_TITLES.slice(1, 5)) await next(title);
    fireEvent.click(within(card()).getByRole("button", { name: "Next" }));
    await screen.findByRole("dialog", { name: "Forgot how something works?" }, { timeout: TARGET_TIMEOUT_MS + 2000 });
    expect(progress()).toBe("7 / 7");
  });
});

describe("窄視窗：開始時抽屜開著", () => {
  it("先關抽屜、等它從 DOM 消失才準備示範筆記；第 1 站指漢堡鈕", async () => {
    stubViewport(true);
    const drawerAtPrepare: boolean[] = [];
    const prepareSample = vi.fn(async (signal: AbortSignal) => {
      drawerAtPrepare.push(document.querySelector("[data-sidebar-drawer]") !== null);
      return fakePrepareSample(signal);
    });
    await startTour({
      initial: "/",
      props: { prepareSample },
      before: async () => {
        fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
        await screen.findByRole("dialog", { name: "Navigation" });
      },
    });
    await findCard("Sidebar sections");
    expect(drawerAtPrepare).toEqual([false]);
    expect(document.querySelector("[data-sidebar-drawer]")).toBeNull();
    expect(hole()).toEqual(padded(RECTS.drawerButton));
  });
});

describe("寬窄判準改變", () => {
  it("導覽中變窄：當站目標改成漢堡鈕、說明換窄視窗那一句", async () => {
    await startTour();
    await findCard("Sidebar sections");
    expect(hole()).toEqual(padded(RECTS.tabs));
    expect(card()).toHaveAccessibleDescription(i18n.t("tourGuide.stops.tabs.body"));
    setNarrow(true);
    await waitFor(() => expect(hole()).toEqual(padded(RECTS.drawerButton)));
    expect(card()).toHaveAccessibleDescription(i18n.t("tourGuide.stops.tabs.narrowBody"));
  });

  it("只有窄視窗說明、目標不變的站：跨過判準時說明跟著換，挖洞不動", async () => {
    const entry = fakeEntry("one", "tabs", { narrowBodyKey: "fake.one.narrowBody" });
    await startTour({ props: { stops: [entry, fakeEntry("two", "userMenu")] } });
    await findCard("fake.one");
    expect(card()).toHaveAccessibleDescription("fake.one.body");
    setNarrow(true);
    await waitFor(() => expect(card()).toHaveAccessibleDescription("fake.one.narrowBody"));
    expect(hole()).toEqual(padded(RECTS.tabs));
    setNarrow(false);
    await waitFor(() => expect(card()).toHaveAccessibleDescription("fake.one.body"));
  });
});

describe("結束後還原側欄 tab", () => {
  it("寬視窗：開始前在「群組」，導覽中切到「我的筆記」，結束後回到「群組」", async () => {
    localStorage.setItem("sidebar.tab", "workspace");
    const { onFinished } = await startTour();
    await findCard("Sidebar sections");
    await next("New note");
    expect(getShellControls()!.getTab()).toBe("myNotes");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(getShellControls()!.getTab()).toBe("workspace");
    expect(localStorage.getItem("sidebar.tab")).toBe("workspace");
  });

  it("窄視窗不呼叫 showTab（窄視窗切 tab 會打開抽屜）：導覽中變窄後結束，tab 不動、抽屜不開", async () => {
    localStorage.setItem("sidebar.tab", "workspace");
    const { onFinished } = await startTour();
    await findCard("Sidebar sections");
    await next("New note");
    setNarrow(true);
    const showTab = vi.spyOn(getShellControls()!, "showTab");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(showTab).not.toHaveBeenCalled();
    expect(getShellControls()!.getTab()).toBe("myNotes");
    expect(document.querySelector("[data-sidebar-drawer]")).toBeNull();
  });
});

describe("結束後的焦點", () => {
  it("從首頁打開：原觸發鈕所在的側欄已卸載 → 焦點在新掛上的帳號列", async () => {
    const { onFinished, startedWith } = await startTour({ initial: "/" });
    await goToLast();
    fireEvent.click(within(card()).getByRole("button", { name: "Keep sample note" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(currentPath).toBe("/");
    expect(startedWith.trigger).not.toBeNull();
    expect(startedWith.trigger!.isConnected).toBe(false);
    const account = findUserMenuTrigger();
    expect(account).not.toBe(startedWith.trigger);
    expect(document.activeElement).toBe(account);
  });

  it("窄視窗：焦點在漢堡鈕", async () => {
    stubViewport(true);
    const { onFinished } = await startTour();
    await findCard("Sidebar sections");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(currentPath).toBe(OTHER_PATH);
    expect(document.activeElement).toBe(within(document.querySelector(`[data-note-id="${OTHER.id}"]`)!).getByRole("button", { name: "Open navigation" }));
  });

  it("查找函式回 null → 回到的那頁的標題框", async () => {
    const { onFinished } = await startTour({ props: { returnFocus: () => null } });
    await findCard("Sidebar sections");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Note title" }));
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue(OTHER.title);
  });
});

describe("〔刪除〕", () => {
  it("先回到原頁再移到垃圾桶；成功跳可復原的提示；焦點仍在帳號列", async () => {
    const { onFinished } = await startTour();
    await goToLast();
    fireEvent.click(within(card()).getByRole("button", { name: "Delete sample note" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toEqual([{ method: "DELETE", url: `/api/notes/${SAMPLE.id}`, at: OTHER_PATH }]);
    expect(await screen.findByText(i18n.t("trash.moved"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("trash.undo") })).toBeInTheDocument();
    expect(currentPath).toBe(OTHER_PATH);
    expect(document.activeElement).toBe(findUserMenuTrigger());
  });

  it("移到垃圾桶失敗 → 一次錯誤提示，沒有垃圾桶提示；導覽照樣結束", async () => {
    deleteStatus = 500;
    const { onFinished } = await startTour();
    await goToLast();
    fireEvent.click(within(card()).getByRole("button", { name: "Delete sample note" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(await screen.findAllByText(i18n.t("errors.internal"))).toHaveLength(1);
    expect(screen.queryByText(i18n.t("trash.moved"))).not.toBeInTheDocument();
    expect(overlay()).toBeNull();
    expect(currentPath).toBe(OTHER_PATH);
  });
});

describe("卸載", () => {
  it("導覽中卸載：畫面上那站收拾一次、遮罩消失、不呼叫 onFinished、不導頁", async () => {
    const first = fakeEntry("one", "tabs");
    const { onFinished, unmountRunner } = await startTour({ props: { stops: [first, fakeEntry("two", "userMenu")] } });
    await findCard("fake.one");
    unmountRunner();
    expect(first.leave).toHaveBeenCalledTimes(1);
    expect(overlay()).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(onFinished).not.toHaveBeenCalled();
    expect(currentPath).toBe(SAMPLE_PATH);
  });
});
