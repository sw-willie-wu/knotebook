import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { FolderDto, GroupDto, NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SidebarTabActionsContext, type SidebarTabActions } from "@/lib/sidebar-tab";
import { adminRole, groupDto, OWNER_PERMS } from "@/test/fixtures";
import { folderDto, groupFolder } from "@/test/folder-fixtures";
import { __resetCollapseForTests, isCollapsed } from "@/components/sidebar/collapse";
import { fitSegments, NoteLocation } from "./NoteLocation";

const data = vi.hoisted(() => ({ folders: [] as unknown[], groups: [] as unknown[], width: 0 }));
vi.mock("@/api/folders", () => ({ useFolders: () => ({ data: data.folders }) }));
vi.mock("@/api/groups", () => ({ useGroups: () => ({ data: data.groups }) }));
vi.mock("@/lib/use-container-width", () => ({ useContainerWidth: () => data.width }));

function note(over: Partial<NoteDto> = {}): NoteDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Plan",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: "plan",
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "alice",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
    ...over,
  };
}

describe("fitSegments", () => {
  const segs = ["My notes", "A", "B", "C", "D"];
  const widths = [60, 30, 30, 30, 30];

  it("全放得下 → 原樣、不截尾", () => {
    expect(fitSegments(segs, widths, 200, 20)).toEqual({ shown: segs, truncateLast: false });
  });

  it("放不下 → 中間從中央往外換成單一「…」，首尾保留", () => {
    // 去掉 B 後 170 仍超出 150，再去掉 A 變 140。
    expect(fitSegments(segs, widths, 150, 20)).toEqual({ shown: ["My notes", "…", "C", "D"], truncateLast: false });
    expect(fitSegments(segs, widths, 170, 20)).toEqual({ shown: ["My notes", "A", "…", "C", "D"], truncateLast: false });
  });

  it("去到只剩首尾仍放不下 → 保留首尾並截最後一段尾端", () => {
    expect(fitSegments(segs, widths, 90, 20)).toEqual({ shown: ["My notes", "…", "D"], truncateLast: true });
  });

  it("沒有中段可去（一或兩段）放不下 → 只截最後一段", () => {
    expect(fitSegments(["a", "b"], [60, 30], 50, 20)).toEqual({ shown: ["a", "b"], truncateLast: true });
    expect(fitSegments(["a"], [60], 50, 20)).toEqual({ shown: ["a"], truncateLast: true });
  });

  it("剛好放得下的邊界（含省略號寬）", () => {
    expect(fitSegments(["a", "b", "c"], [10, 10, 10], 25, 5)).toEqual({ shown: ["a", "…", "c"], truncateLast: false });
    expect(fitSegments(["a", "b", "c"], [10, 10, 10], 30, 5)).toEqual({ shown: ["a", "b", "c"], truncateLast: false });
  });
});

describe("NoteLocation", () => {
  const showTab = vi.fn();
  const actions: SidebarTabActions = { showTab, updateSelection: vi.fn(), endSelectionIfActive: vi.fn(() => false), getSelectionSession: vi.fn(() => null) };

  function renderLocation(n: NoteDto) {
    return render(
      <SidebarTabActionsContext.Provider value={actions}>
        <NoteLocation note={n} />
      </SidebarTabActionsContext.Provider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    __resetCollapseForTests();
    showTab.mockClear();
    data.width = 0;
    const folders: FolderDto[] = [folderDto({ id: "pA", name: "Projects" }), folderDto({ id: "pB", name: "Sprint", parentId: "pA" })];
    data.folders = folders;
    data.groups = [] as GroupDto[];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("一顆按鈕，aria-label 是完整路徑", () => {
    renderLocation(note({ folderId: "pB" }));
    const button = screen.getByRole("button", { name: "Show in list: My notes › Projects › Sprint" });
    expect(button).toBeInTheDocument();
  });

  it("共享：路徑後面接 @擁有者帳號", () => {
    renderLocation(note({ role: "viewer", ownerHandle: "bob" }));
    expect(screen.getByRole("button", { name: "Show in list: Shared with me · @bob" })).toBeInTheDocument();
  });

  it("zh-TW 的 aria-label", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      renderLocation(note());
      expect(screen.getByRole("button", { name: "在清單中顯示：我的筆記" })).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("點了：切到該 tab、把資料夾鏈展開", () => {
    __resetCollapseForTests();
    // 先寫成收合，驗證點擊會展開。
    localStorage.setItem("sidebar.collapsed.folder:pA", "1");
    localStorage.setItem("sidebar.collapsed.folder:pB", "1");
    __resetCollapseForTests();
    expect(isCollapsed("folder:pA")).toBe(true);
    renderLocation(note({ folderId: "pB" }));
    fireEvent.click(screen.getByRole("button", { name: /^Show in list/ }));
    expect(showTab).toHaveBeenCalledWith("myNotes");
    expect(isCollapsed("folder:pA")).toBe(false);
    expect(isCollapsed("folder:pB")).toBe(false);
  });

  it("根層筆記：只切 tab，不碰展開狀態", () => {
    renderLocation(note());
    fireEvent.click(screen.getByRole("button", { name: /^Show in list/ }));
    expect(showTab).toHaveBeenCalledWith("myNotes");
  });

  const NOTE_ID = "11111111-1111-4111-8111-111111111111";
  function makeRow(visible: boolean) {
    const row = document.createElement("li");
    row.setAttribute("data-node-id", NOTE_ID);
    const link = document.createElement("a");
    link.href = "/n/alice/plan";
    row.appendChild(link);
    const scroll = vi.fn();
    row.scrollIntoView = scroll;
    row.getClientRects = () => (visible ? ([{}] as unknown as DOMRectList) : ([] as unknown as DOMRectList));
    document.body.appendChild(row);
    return { row, link, scroll };
  }

  it("清單出現後把那一列捲到中央，並把焦點放到它的連結（不再捲動）", () => {
    vi.useFakeTimers();
    const hidden = makeRow(false); // 另一份看不見的副本排在前面
    const shown = makeRow(true);
    const focus = vi.spyOn(shown.link, "focus");
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
    renderLocation(note());
    fireEvent.click(screen.getByRole("button", { name: /^Show in list/ }));
    vi.runAllTimers();
    expect(shown.scroll).toHaveBeenCalledWith({ block: "center" });
    expect(hidden.scroll).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    hidden.row.remove();
    shown.row.remove();
  });

  it("找不到可見的那一列：最多輪詢 30 個影格就停", () => {
    vi.useFakeTimers();
    const hidden = makeRow(false);
    const raf = vi.fn((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
    vi.stubGlobal("requestAnimationFrame", raf);
    renderLocation(note());
    fireEvent.click(screen.getByRole("button", { name: /^Show in list/ }));
    vi.runAllTimers();
    expect(raf).toHaveBeenCalledTimes(30);
    expect(hidden.scroll).not.toHaveBeenCalled();
    hidden.row.remove();
  });

  it("群組筆記：點了把收合的群組區塊展開", () => {
    const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    data.groups = [groupDto({ id: groupId, name: "Workshop A" }, adminRole())];
    localStorage.setItem(`sidebar.collapsed.group:${groupId}`, "1");
    __resetCollapseForTests();
    expect(isCollapsed(`group:${groupId}`)).toBe(true);
    renderLocation(note({ role: "editor", group: { id: groupId, name: "Workshop A" }, groupId }));
    fireEvent.click(screen.getByRole("button", { name: "Show in list: Workshop A" }));
    expect(showTab).toHaveBeenCalledWith("workspace");
    expect(isCollapsed(`group:${groupId}`)).toBe(false);
  });

  it("分隔符保留空白、按鈕裁切溢出，量測副本對輔助技術隱藏", () => {
    renderLocation(note({ folderId: "pB" }));
    const button = screen.getByRole("button", { name: /^Show in list/ });
    expect(button).toHaveClass("overflow-hidden");
    const separators = Array.from(button.querySelectorAll("[aria-hidden='true']"));
    expect(separators.length).toBeGreaterThanOrEqual(2);
    for (const sep of separators) expect(sep).toHaveClass("whitespace-pre");
    const measured = document.querySelector("[data-measure-seg]") as HTMLElement;
    expect(measured.closest("[aria-hidden='true']")).not.toBeNull();
    expect(button.contains(measured)).toBe(false);
  });

  describe("量到寬度時", () => {
    beforeEach(() => {
      // 每個字 10px、分隔符 5px、省略號 10px。
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        let width = 0;
        if (this.hasAttribute("data-measure-sep")) width = 5;
        else if (this.hasAttribute("data-measure-ellipsis")) width = 10;
        else if (this.hasAttribute("data-measure-seg") || this.hasAttribute("data-measure-suffix")) width = (this.textContent ?? "").length * 10;
        return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("放不下：中間換成「…」，元件確實套用 fitSegments", () => {
      data.width = 200; // 全長 80 + 85 + 65 = 230
      renderLocation(note({ folderId: "pB" }));
      const button = screen.getByRole("button", { name: /^Show in list/ });
      expect(within(button).getByText("…")).toBeInTheDocument();
      expect(within(button).queryByText("Projects")).toBeNull();
      expect(within(button).getByText("Sprint")).toBeInTheDocument();
      expect(button).toHaveAccessibleName("Show in list: My notes › Projects › Sprint");
    });

    it("放得下：完整路徑、沒有「…」", () => {
      data.width = 400;
      renderLocation(note({ folderId: "pB" }));
      const button = screen.getByRole("button", { name: /^Show in list/ });
      expect(within(button).queryByText("…")).toBeNull();
      expect(within(button).getByText("Projects")).toBeInTheDocument();
    });

    it("第一段很長、首尾放不下：第一段最多佔一半並截尾，最後一段吃剩餘寬度", () => {
      const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      data.groups = [groupDto({ id: groupId, name: "A very long group name" }, adminRole())];
      data.folders = [groupFolder({ id: "gf", name: "Sub", groupId })];
      data.width = 100;
      renderLocation(note({ role: "editor", group: { id: groupId, name: "A very long group name" }, groupId, folderId: "gf" }));
      const button = screen.getByRole("button", { name: /^Show in list/ });
      const first = within(button).getByText("A very long group name");
      expect(first).toHaveClass("max-w-[50%]", "truncate");
      const last = within(button).getByText("Sub");
      expect(last).toHaveClass("min-w-0", "truncate");
    });
  });
});
