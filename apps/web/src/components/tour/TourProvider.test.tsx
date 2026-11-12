import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams, type NavigateFunction } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, toast, Toaster } from "@/components/ui/toast";
import { SidebarQueryProvider } from "@/lib/sidebar-query";
import { notifyEditorEditable, registerEditor, registerShellControls, type TourEditor } from "@/lib/tour-bridge";
import { useTour, type TourApi } from "@/lib/tour-context";
import { OWNER_PERMS } from "@/test/fixtures";
import { seedSampleNote } from "./sample-note";
import { START_TIMEOUT_MS, TourProvider } from "./TourProvider";

// 寫入示範內容換成替身：這裡驗的是開始流程何時呼叫它、它的結果怎麼決定筆記去留；寫入本身在 sample-note.test.ts。
vi.mock("./sample-note", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sample-note")>();
  return { ...actual, seedSampleNote: vi.fn(() => true) };
});
const seed = vi.mocked(seedSampleNote);

// 數提示：包住真的 `toast`，畫面照常出現。
vi.mock("@/components/ui/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/toast")>();
  return { ...actual, toast: vi.fn(actual.toast) };
});
const toastSpy = vi.mocked(toast);

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
const ELSEWHERE = noteDto("99999999-9999-9999-9999-999999999999", "Recipes", "recipes");
const NOTES = [SAMPLE, OTHER, ELSEWHERE];
const SAMPLE_PATH = canonicalNotePath(SAMPLE);
const OTHER_PATH = canonicalNotePath(OTHER);
const ELSEWHERE_PATH = canonicalNotePath(ELSEWHERE);

const START_FAILED = "The feature tour couldn't start. Try again.";
const SAMPLE_FAILED = "Couldn't create the sample note. Try again.";

// ── 假 server ────────────────────────────────────────────────────────────────

interface Call {
  method: string;
  url: string;
  /** 發出請求當下的位置。 */
  at: string;
}

let calls: Call[] = [];
let postStatus = 200;
let postGate: Promise<void> | null = null;
let aiGate: Promise<void> | null = null;
/** 依序記下開始流程的幾個步驟。 */
let steps: string[] = [];

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
      if (url === "/api/notes" && method === "POST") {
        steps.push(`POST drawer=${document.querySelector("[data-sidebar-drawer]") !== null}`);
        if (postGate !== null) await postGate;
        return postStatus === 200 ? json(SAMPLE) : json({ error: { code: "internal", message: "x" } }, postStatus);
      }
      if (url === "/api/notes") return json(NOTES);
      if (url === "/api/ai/actions") {
        if (aiGate !== null) await aiGate;
        return json({ actions: [] });
      }
      if (url.startsWith("/api/notes/") && method === "DELETE") return new Response(null, { status: 204 });
      return json({ error: { code: "not_found", message: url } }, 404);
    }),
  );
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// ── 宿主：首頁、筆記頁（登記一份假的編輯器、放第 1 站的目標）、側欄抽屜 ─────────────

let currentPath = "";
let routerNavigate: NavigateFunction | null = null;
let tour: TourApi | null = null;
/** 筆記頁的假編輯器掛上時是否可編輯；false＝一直不可編輯（共編連不上）。 */
let editable = true;
/** 第 1 站（側欄 tab 列）的目標是否有尺寸；false＝第 1 站一直等不到。 */
let targetVisible = true;

function Probe() {
  const location = useLocation();
  currentPath = location.pathname + location.search;
  routerNavigate = useNavigate();
  tour = useTour();
  useEffect(() => {
    steps.push(`at ${location.pathname}`);
  }, [location.pathname]);
  return null;
}

function Drawer() {
  const [open, setOpen] = useState(true);
  useEffect(
    () =>
      registerShellControls({
        showTab: () => {},
        endSelectionIfActive: () => false,
        closeDrawer: () => {
          steps.push("closeDrawer");
          setOpen(false);
        },
        getTab: () => "myNotes",
      }),
    [],
  );
  return open ? <div data-sidebar-drawer="" /> : null;
}

function NoteStandIn() {
  const { slug } = useParams();
  const note = NOTES.find((n) => n.slug === slug)!;
  useEffect(() => {
    const editor = { isEditable: editable, document: [], _tiptapEditor: {} } as unknown as TourEditor;
    const unregister = registerEditor(note.id, editor);
    if (editable) notifyEditorEditable(note.id, editor);
    return unregister;
  }, [note.id]);
  return (
    <main>
      <div data-kb-tour-target="tabs" />
      <input data-note-title-input="" aria-label="Note title" defaultValue={note.title} />
    </main>
  );
}

let queryClient: QueryClient;

function renderHost(initial = OTHER_PATH, { drawer = false } = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initial]}>
        <SidebarQueryProvider>
          <TourProvider>
            {drawer && <Drawer />}
            <Routes>
              <Route path="/" element={<main>Home</main>} />
              <Route path="/n/:handle/:slug" element={<NoteStandIn />} />
            </Routes>
            <Probe />
          </TourProvider>
        </SidebarQueryProvider>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
}

/** 結束後的焦點落在回到的那頁的 `<main>`（查不到就要等滿一秒才退）。 */
function start(returnTo = currentPath) {
  act(() => tour!.start({ returnTo, returnFocus: () => document.querySelector("main") }));
}

const overlay = () => document.querySelector("[data-tour-overlay]");
const posts = () => calls.filter((c) => c.method === "POST" && c.url === "/api/notes");
const deletes = () => calls.filter((c) => c.method === "DELETE");
const aiReads = () => calls.filter((c) => c.url === "/api/ai/actions");
const toastCount = (text: string) => screen.queryAllByText(text).length;
/** 這一案跳過的所有提示的標題（含不是導覽發的）。 */
const toastTitles = () => toastSpy.mock.calls.map(([item]) => item.title);

function useFakeClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  calls = [];
  steps = [];
  postStatus = 200;
  postGate = null;
  aiGate = null;
  editable = true;
  targetVisible = true;
  tour = null;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  dismissAllToasts();
  toastSpy.mockClear();
  seed.mockReset();
  seed.mockImplementation(() => true);
  stubFetch();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.getAttribute("data-kb-tour-target") === "tabs" && targetVisible) return new DOMRect(10, 10, 100, 30);
    return new DOMRect(0, 0, 0, 0);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  routerNavigate = null;
});

describe("不會自己出現", () => {
  it("掛著 TourProvider、沒有人呼叫 start：不建筆記、不讀 AI 動作、沒有遮罩", async () => {
    renderHost();
    await new Promise((r) => setTimeout(r, 300));
    expect(tour).not.toBeNull();
    expect(posts()).toEqual([]);
    expect(aiReads()).toEqual([]);
    expect(overlay()).toBeNull();
  });
});

describe("開始", () => {
  it("先關抽屜、等它消失，再建示範筆記，再導過去；第 1 站出現在示範筆記上", async () => {
    renderHost(OTHER_PATH, { drawer: true });
    steps = [];
    start();
    await screen.findByRole("dialog", { name: "Sidebar sections" });
    expect(steps).toEqual(["closeDrawer", "POST drawer=false", `at ${SAMPLE_PATH}`]);
    expect(currentPath).toBe(SAMPLE_PATH);
    expect(seed).toHaveBeenCalledTimes(1);
    expect(seed.mock.calls[0]![1]).toEqual(SAMPLE);
    // 站台沒有 AI 動作：寫入時不放 AI 那句。
    expect(seed.mock.calls[0]![3]).toBe(false);
    expect(aiReads()).toHaveLength(1);
  });

  it("建示範筆記失敗 → 一則建立失敗的提示、沒有遮罩、不另跳開始失敗；之後可以再開", async () => {
    postStatus = 500;
    renderHost();
    start();
    await screen.findByText(SAMPLE_FAILED);
    await new Promise((r) => setTimeout(r, 200));
    expect(toastCount(SAMPLE_FAILED)).toBe(1);
    expect(toastCount(START_FAILED)).toBe(0);
    expect(overlay()).toBeNull();
    expect(currentPath).toBe(OTHER_PATH);

    postStatus = 200;
    start();
    await screen.findByRole("dialog", { name: "Sidebar sections" });
    expect(posts()).toHaveLength(2);
  });

  it("進行中再呼叫 start → 不動作（不再建一篇）", async () => {
    postGate = gate().promise;
    renderHost();
    start();
    await waitFor(() => expect(posts()).toHaveLength(1));
    start();
    start();
    await new Promise((r) => setTimeout(r, 200));
    expect(posts()).toHaveLength(1);
  });

  it("導覽正常結束後可以再開，每次都建新的一篇", async () => {
    renderHost();
    start();
    await screen.findByRole("dialog", { name: "Sidebar sections" });
    act(() => screen.getByRole("button", { name: "Close" }).click());
    await waitFor(() => expect(overlay()).toBeNull());
    await waitFor(() => expect(currentPath).toBe(OTHER_PATH));
    await waitFor(() => expect(document.activeElement?.tagName).toBe("MAIN"));
    start();
    await screen.findByRole("dialog", { name: "Sidebar sections" });
    expect(posts()).toHaveLength(2);
    expect(deletes()).toEqual([]);
  });
});

describe("開始流程的中止", () => {
  it("等可編輯期間位置離開示範筆記 → 一則提示、空白的示範筆記移到垃圾桶；之後再開正常建新的一篇", async () => {
    editable = false;
    renderHost();
    start();
    await waitFor(() => expect(currentPath).toBe(SAMPLE_PATH));
    act(() => void routerNavigate!(ELSEWHERE_PATH));
    await screen.findByText(START_FAILED);
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(deletes()[0]!.url).toBe(`/api/notes/${SAMPLE.id}`);
    expect(seed).not.toHaveBeenCalled();
    expect(currentPath).toBe(ELSEWHERE_PATH);
    expect(overlay()).toBeNull();
    await waitFor(() => expect(document.activeElement?.tagName).toBe("MAIN"));

    editable = true;
    start();
    await screen.findByRole("dialog", { name: "Sidebar sections" });
    expect(posts()).toHaveLength(2);
    expect(toastCount(START_FAILED)).toBe(1);
  });

  it("編輯器一直不可編輯 → 15 秒逾時：只有一則提示、先導回原頁再移到垃圾桶、「進行中」清掉可以再開", async () => {
    useFakeClock();
    editable = false;
    renderHost();
    start(OTHER_PATH);
    await waitFor(() => expect(currentPath).toBe(SAMPLE_PATH));
    // 推進計時器不包 `act()`：讓 React 像在瀏覽器裡那樣，先 commit 一般更新（收掉導覽），導頁的 transition 晚一點才 commit。
    // 包了 `act()`，兩者會在 act 結束時一起 flush，「還在示範筆記上就送出移到垃圾桶」的順序錯誤就看不出來。
    // 計時器也跟著真實時間走（`shouldAdvanceTime`）：留 2 秒餘裕，冷載入導覽 chunk 的那段真實時間不會讓它提早到期。
    vi.advanceTimersByTime(START_TIMEOUT_MS - 2_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(toastCount(START_FAILED)).toBe(0);
    vi.advanceTimersByTime(2_100);
    await screen.findByText(START_FAILED);
    await waitFor(() => expect(deletes()).toHaveLength(1));
    // 刪的時候已經不在示範筆記上（導回是取代歷史）。
    expect(deletes()[0]!.at).toBe(OTHER_PATH);
    expect(currentPath).toBe(OTHER_PATH);
    expect(toastTitles()).toEqual([START_FAILED]);
    expect(seed).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement?.tagName).toBe("MAIN"));

    editable = true;
    start(OTHER_PATH);
    await screen.findByRole("dialog", { name: "Sidebar sections" });
    expect(posts()).toHaveLength(2);
  });

  it("寫入示範內容時拋錯 → 一則提示、導回原頁、筆記移到垃圾桶、焦點回到 returnFocus 找到的元素", async () => {
    seed.mockImplementation(() => {
      throw new TypeError("bad block");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderHost();
    start(OTHER_PATH);
    await screen.findByText(START_FAILED);
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(deletes()[0]!.at).toBe(OTHER_PATH);
    expect(currentPath).toBe(OTHER_PATH);
    expect(toastCount(START_FAILED)).toBe(1);
    expect(overlay()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector("main")));
  });

  it("讀 AI 動作期間逾時 → 之後那次讀取回來也不寫入、筆記移到垃圾桶", async () => {
    useFakeClock();
    const ai = gate();
    aiGate = ai.promise;
    renderHost();
    start(OTHER_PATH);
    await waitFor(() => expect(currentPath).toBe(SAMPLE_PATH));
    await waitFor(() => expect(aiReads()).toHaveLength(1));
    act(() => vi.advanceTimersByTime(START_TIMEOUT_MS));
    await screen.findByText(START_FAILED);
    ai.release();
    await waitFor(() => expect(deletes()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(seed).not.toHaveBeenCalled();
    expect(deletes()).toHaveLength(1);
    expect(overlay()).toBeNull();
  });

  it("建示範筆記的請求還沒回來就逾時 → 回來後不導過去、那篇直接移到垃圾桶", async () => {
    useFakeClock();
    const post = gate();
    postGate = post.promise;
    renderHost();
    start(OTHER_PATH);
    await waitFor(() => expect(posts()).toHaveLength(1));
    act(() => vi.advanceTimersByTime(START_TIMEOUT_MS));
    await screen.findByText(START_FAILED);
    post.release();
    await waitFor(() => expect(deletes()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(currentPath).toBe(OTHER_PATH);
    expect(steps).not.toContain(`at ${SAMPLE_PATH}`);
    expect(seed).not.toHaveBeenCalled();
  });

  it("寫入回 false（已有別人的內容）之後才逾時 → 一則提示、筆記留著、不導頁", async () => {
    useFakeClock();
    seed.mockImplementation(() => false);
    targetVisible = false;
    renderHost();
    start(OTHER_PATH);
    await waitFor(() => expect(seed).toHaveBeenCalledTimes(1));
    act(() => vi.advanceTimersByTime(START_TIMEOUT_MS));
    await screen.findByText(START_FAILED);
    await new Promise((r) => setTimeout(r, 200));
    expect(deletes()).toEqual([]);
    expect(currentPath).toBe(SAMPLE_PATH);
    expect(overlay()).toBeNull();
  });

  it("第 1 站出現之後就不再逾時：過了 15 秒導覽照常開著", async () => {
    useFakeClock();
    renderHost();
    start(OTHER_PATH);
    await screen.findByRole("dialog", { name: "Sidebar sections" });
    act(() => vi.advanceTimersByTime(START_TIMEOUT_MS * 2));
    await new Promise((r) => setTimeout(r, 100));
    expect(toastCount(START_FAILED)).toBe(0);
    expect(screen.getByRole("dialog", { name: "Sidebar sections" })).toBeTruthy();
    expect(deletes()).toEqual([]);
  });
});
