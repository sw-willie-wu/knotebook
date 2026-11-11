import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { NoteDto, UserDto } from "@knotebook/shared";
import type { CollabState } from "@/collab/connection";
import i18n from "@/i18n";
import tourEn from "@/i18n/tour.en.json";
import tourZhTW from "@/i18n/tour.zh-TW.json";
import { ActiveNoteProvider } from "@/lib/active-note";
import { NARROW_QUERY } from "@/lib/sidebar-drawer";
import { getShellControls } from "@/lib/tour-bridge";
import { findDrawerButton, findTourTarget, findUserMenuTrigger, type TourTargetId } from "@/lib/tour-targets";
import { useVersionsController, VersionsProvider } from "@/lib/versions-context";
import { ThemeProvider } from "@/theme";
import { AppShell, SidebarDrawerButton } from "@/components/AppShell";
import { CornerStack } from "@/components/CornerStack";
import { NarrowTopBar } from "@/components/NarrowTopBar";
import { NoteMenu } from "@/components/NoteMenu";
import { ShareDialog } from "@/components/ShareDialog";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY, folderDto } from "@/test/folder-fixtures";
import type { FolderListDto } from "@knotebook/shared";
import { FULL_TOUR, prepareStop, STOPS, stopBodyKey, stopTarget, type StopContext, type StopId } from "./stops";

// 測試宿主照筆記頁的接線：真的 AppShell（側欄、搜尋框、tab 列、新增鈕、使用者選單），
// 主內容區放筆記頁頁首用的同一批元件（漢堡鈕、分享、⋮）與右下角的版本泡泡。

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

const NOTE: NoteDto = {
  id: "77777777-7777-7777-7777-777777777777",
  title: "Tour Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "tour-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

const CONNECTED: CollabState = { phase: "connected", role: "owner" };

function json(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
}

function stubFetch(folders: FolderListDto = FOLDER_LIST_EMPTY) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") return json([]);
      if (url === "/api/auth/me") return json(USER);
      if (url === "/api/folders") return json(folders);
      if (url === "/api/notes" && method === "GET") return json([NOTE]);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/** `NARROW_QUERY` 回 `narrow`，其他查詢一律不符合（同 setup.ts 的預設）。 */
function stubViewport(narrow: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === NARROW_QUERY ? narrow : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

function NotePageStandIn({ withShare }: { withShare: boolean }) {
  const versions = useVersionsController({ noteId: NOTE.id, enabled: true });
  return (
    <VersionsProvider value={versions}>
      <header>
        <SidebarDrawerButton />
        {withShare && <ShareDialog note={NOTE} />}
        <NoteMenu note={NOTE} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} />
      </header>
      <CornerStack />
    </VersionsProvider>
  );
}

async function renderPage({ withShare = true, home = false, inert = false }: { withShare?: boolean; home?: boolean; inert?: boolean } = {}) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[`/n/${NOTE.ownerHandle}/${NOTE.slug}`]}>
          <ActiveNoteProvider>
            <Routes>
              <Route
                path="/n/:handle/:slug"
                element={
                  <AppShell inert={inert}>
                    {home ? <NarrowTopBar /> : <NotePageStandIn withShare={withShare} />}
                  </AppShell>
                }
              />
            </Routes>
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  // 使用者選單要等 /api/auth/me 回來才有名稱。
  await screen.findByRole("button", { name: USER.displayName });
}

function ctx(searchQuery = ""): StopContext {
  return { searchQuery, aiActions: [] };
}

const aside = () => document.querySelector<HTMLElement>("aside[data-sidebar-instance]")!;
const pageHeader = () => document.querySelector<HTMLElement>("main header")!;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem("sidebar.tab");
});

describe("站點表", () => {
  it("完整導覽的順序；每個站點恰好出現一次", () => {
    expect(FULL_TOUR).toEqual(["tabs", "newNote", "folders", "search", "header", "versions", "userMenu"]);
    expect(Object.keys(STOPS).sort()).toEqual([...FULL_TOUR].sort());
    for (const id of FULL_TOUR) expect(STOPS[id].id).toBe(id);
  });

  it.each([
    ["en", tourEn],
    ["zh-TW", tourZhTW],
  ] as const)("%s：每站的標題、說明（含窄視窗說明）都有字", (_lang, bundle) => {
    for (const stop of Object.values(STOPS)) {
      for (const key of [stop.titleKey, stop.bodyKey, stop.narrowBodyKey].filter((k) => k !== undefined)) {
        const value = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], bundle);
        expect(typeof value === "string" && value.length > 0, key).toBe(true);
      }
    }
  });
});

describe("寬視窗：目標", () => {
  beforeEach(() => stubViewport(false));

  it("每站都找得到，而且是側欄卡片／頁首裡的那一顆", async () => {
    await renderPage();
    const side = within(aside());
    const header = within(pageHeader());
    // folders 的目標在「我的筆記」標題列；預設 tab 就是我的筆記。
    await waitFor(() => expect(stopTarget(STOPS.folders, ctx())).toHaveLength(1));

    const expected: Record<StopId, HTMLElement[]> = {
      tabs: [side.getByRole("tablist")],
      newNote: [side.getByRole("button", { name: "New note" })],
      folders: [side.getByRole("button", { name: "New folder" })],
      search: [side.getByRole("textbox", { name: "Search notes" })],
      header: [header.getByRole("button", { name: "Share" }), header.getByRole("button", { name: "More" })],
      versions: [screen.getByTestId("versions-bubble")],
      userMenu: [side.getByRole("button", { name: "Ann" })],
    };
    for (const id of FULL_TOUR) expect(stopTarget(STOPS[id], ctx()), id).toEqual(expected[id]);
  });

  it("頁面上沒有目標時回空陣列", () => {
    for (const id of FULL_TOUR) expect(stopTarget(STOPS[id], ctx()), id).toEqual([]);
  });

  it("頁首要分享鈕與 ⋮ 都在才算找到（只找到一顆不挖亮）", async () => {
    await renderPage({ withShare: false });
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
    expect(stopTarget(STOPS.header, ctx())).toEqual([]);
  });

  it("說明用寬視窗那一句", () => {
    for (const stop of Object.values(STOPS)) expect(stopBodyKey(stop)).toBe(stop.bodyKey);
  });
});

describe("窄視窗：目標", () => {
  beforeEach(() => stubViewport(true));

  it("側欄裡的站改指頁首的漢堡鈕；版本改指 ⋮；頁首不變", async () => {
    await renderPage();
    const header = within(pageHeader());
    const hamburger = header.getByRole("button", { name: "Open navigation" });
    const more = header.getByRole("button", { name: "More" });
    const expected: Record<StopId, HTMLElement[]> = {
      tabs: [hamburger],
      newNote: [hamburger],
      folders: [hamburger],
      search: [hamburger],
      header: [header.getByRole("button", { name: "Share" }), more],
      versions: [more],
      userMenu: [hamburger],
    };
    for (const id of FULL_TOUR) expect(stopTarget(STOPS[id], ctx()), id).toEqual(expected[id]);
  });

  it("說明：有窄視窗那一句的站用它", () => {
    const narrowOnes = Object.values(STOPS).filter((s) => s.narrowBodyKey !== undefined).map((s) => s.id);
    expect(narrowOnes.sort()).toEqual(["folders", "newNote", "search", "tabs", "userMenu", "versions"]);
    for (const stop of Object.values(STOPS)) expect(stopBodyKey(stop)).toBe(stop.narrowBodyKey ?? stop.bodyKey);
  });
});

// 資料夾名稱是使用者自己取的：取成跟任何目標同名，也不能把目標搶走。
const COLLIDING_NAMES = [USER.displayName, "New note", "New folder", "Search notes", "Share", "More", "Open navigation", "Sidebar sections", "Version history"];

describe("使用者內容撞名", () => {
  beforeEach(() => {
    stubViewport(false);
    stubFetch({ folders: COLLIDING_NAMES.map((name, i) => folderDto({ id: `f-${i}`, name })) });
  });

  /** tabpanel 裡、名稱撞上目標的資料夾元素（一般模式是資料夾列；選取模式是帶 `aria-label` 的資料夾鈕）。標題列的動作鈕不算。 */
  function collidingInPanel(): Element[] {
    const panel = aside().querySelector("[role=tabpanel]")!;
    return Array.from(panel.querySelectorAll("button, input")).filter(
      (el) =>
        el.closest("[data-sidebar-header]") === null &&
        COLLIDING_NAMES.includes(el.getAttribute("aria-label") ?? el.textContent?.trim() ?? ""),
    );
  }

  /** 側欄卡片裡、tabpanel 外、名稱是 `name` 的那顆鈕（帳號列、底部的新增筆記）。 */
  function outsidePanel(name: string): HTMLElement {
    const found = within(aside())
      .getAllByRole("button", { name })
      .filter((el) => el.closest("[role=tabpanel]") === null);
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  function targetsOf(): Map<StopId, Element[]> {
    return new Map(FULL_TOUR.map((id) => [id, stopTarget(STOPS[id], ctx())]));
  }

  it("一般模式：每站仍指原本的目標，沒有一站指到資料夾", async () => {
    await renderPage();
    const side = within(aside());
    await waitFor(() => expect(collidingInPanel().length).toBeGreaterThanOrEqual(COLLIDING_NAMES.length));
    const colliding = collidingInPanel();
    const targets = targetsOf();
    for (const [id, els] of targets) for (const el of els) expect(colliding, id).not.toContain(el);
    expect(targets.get("userMenu")).toEqual([outsidePanel(USER.displayName)]);
    expect(targets.get("newNote")).toEqual([outsidePanel("New note")]);
    expect(targets.get("search")).toEqual([side.getByRole("textbox", { name: "Search notes" })]);
  });

  it("選取模式：資料夾鈕以資料夾名當 aria-label，仍不會被當成目標", async () => {
    await renderPage();
    const side = within(aside());
    await waitFor(() => expect(side.getByRole("button", { name: "Select" })).toBeEnabled());
    act(() => side.getByRole("button", { name: "Select" }).click());
    await side.findByRole("button", { name: "Done" });
    // 撞名真的成立：選取樹裡有 aria-label 就是使用者名稱的資料夾鈕，而且在 DOM 裡排在帳號列前面。
    const folderButton = await waitFor(() => {
      const el = collidingInPanel().find((e) => e.getAttribute("aria-label") === USER.displayName);
      expect(el).toBeDefined();
      return el!;
    });
    const account = findUserMenuTrigger()!;
    expect(folderButton.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const colliding = collidingInPanel();
    for (const [id, els] of targetsOf()) for (const el of els) expect(colliding, id).not.toContain(el);
    expect(account).toBe(outsidePanel(USER.displayName));
    expect(stopTarget(STOPS.userMenu, ctx())).toEqual([account]);
  });
});

describe("背景不可互動（簡報模式的 AppShell inert）", () => {
  const ALL_IDS: TourTargetId[] = ["tabs", "newNote", "newFolder", "search", "share", "noteMenu", "versions", "userMenu", "drawerButton"];

  it.each([false, true])("窄視窗＝%s：九個目標都查不到", async (narrow) => {
    stubViewport(narrow);
    await renderPage({ inert: true });
    // 元素都還在 DOM 裡（帶著屬性），只是在 inert 範圍內。窄視窗沒有版本泡泡。
    for (const id of narrow ? ALL_IDS.filter((i) => i !== "versions") : ALL_IDS) {
      expect(document.querySelector(`[data-kb-tour-target="${id}"]`), id).not.toBeNull();
    }
    for (const id of ALL_IDS) expect(findTourTarget(id), id).toBeNull();
    for (const id of FULL_TOUR) expect(stopTarget(STOPS[id], ctx()), id).toEqual([]);
  });
});

describe("漢堡鈕", () => {
  it("沒有筆記頁頁首的頁面（窄版頂列）也找得到", async () => {
    stubViewport(true);
    await renderPage({ home: true });
    expect(document.querySelector("main header")).toBeNull();
    expect(findDrawerButton()).toBe(within(document.querySelector("main")!).getByRole("button", { name: "Open navigation" }));
    expect(stopTarget(STOPS.userMenu, ctx())).toEqual([findDrawerButton()]);
  });
});

describe("側欄兩份：抽屜開著取抽屜那份，關著取固定卡片那份", () => {
  beforeEach(() => stubViewport(true));

  it("使用者選單、搜尋框、tab 列；抽屜開著時頁首的漢堡鈕被蓋住、查不到", async () => {
    await renderPage();
    const card = aside();
    expect(findUserMenuTrigger()?.closest("aside")).toBe(card);
    expect(findTourTarget("search")?.closest("aside")).toBe(card);
    expect(findDrawerButton()).toBe(within(pageHeader()).getByRole("button", { name: "Open navigation" }));

    act(() => within(pageHeader()).getByRole("button", { name: "Open navigation" }).click());
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await within(drawer).findByRole("button", { name: USER.displayName });
    for (const id of ["userMenu", "search", "tabs"] as const) {
      expect(findTourTarget(id), id).not.toBeNull();
      expect(drawer.contains(findTourTarget(id)), id).toBe(true);
    }
    expect(findDrawerButton()).toBeNull();

    act(() => getShellControls()!.closeDrawer());
    await waitFor(() => expect(document.querySelector("[data-sidebar-drawer]")).toBeNull());
    expect(findUserMenuTrigger()?.closest("aside")).toBe(card);
    expect(findDrawerButton()).not.toBeNull();
  });
});

describe("prepare", () => {
  it("寬視窗：newNote、folders 先切到「我的筆記」並結束選取模式", async () => {
    stubViewport(false);
    localStorage.setItem("sidebar.tab", "recent");
    await renderPage();
    for (const id of ["newNote", "folders"] as const) {
      act(() => getShellControls()!.showTab("recent"));
      const controls = getShellControls()!;
      const endSelection = vi.spyOn(controls, "endSelectionIfActive");
      act(() => prepareStop(STOPS[id], ctx()));
      expect(controls.getTab(), id).toBe("myNotes");
      expect(endSelection, id).toHaveBeenCalledTimes(1);
      endSelection.mockRestore();
    }
    // 切 tab 之後「新增資料夾」才出現在標題列。
    await waitFor(() => expect(stopTarget(STOPS.folders, ctx())).toHaveLength(1));
  });

  it("窄視窗：不跑 prepare——tab 不變、抽屜維持關閉", async () => {
    stubViewport(true);
    localStorage.setItem("sidebar.tab", "recent");
    await renderPage();
    const controls = getShellControls()!;
    const showTab = vi.spyOn(controls, "showTab");
    const endSelection = vi.spyOn(controls, "endSelectionIfActive");
    for (const id of FULL_TOUR) act(() => prepareStop(STOPS[id], ctx()));
    expect(showTab).not.toHaveBeenCalled();
    expect(endSelection).not.toHaveBeenCalled();
    expect(controls.getTab()).toBe("recent");
    expect(document.querySelector("[data-sidebar-drawer]")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
  });

  it("沒有登記的側欄時什麼都不做、不拋錯", () => {
    stubViewport(false);
    expect(getShellControls()).toBeNull();
    for (const id of FULL_TOUR) expect(() => prepareStop(STOPS[id], ctx())).not.toThrow();
  });
});

describe("precondition", () => {
  it("搜尋框有字時 tabs、folders、search 不成立（搜尋中 tab 列與標題列不渲染，也不清掉使用者的字）；其他站照常", () => {
    const applies = (q: string) => FULL_TOUR.filter((id) => STOPS[id].precondition?.(ctx(q)) ?? true);
    expect(applies("")).toEqual(FULL_TOUR);
    expect(applies("ab")).toEqual(["newNote", "header", "versions", "userMenu"]);
    // 空白也算搜尋中（同 AppShell 的判準）。
    expect(applies(" ")).toEqual(["newNote", "header", "versions", "userMenu"]);
  });
});
