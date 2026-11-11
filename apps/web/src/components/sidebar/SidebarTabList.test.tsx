import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { SidebarTabProvider } from "@/lib/sidebar-tab";
import { SidebarTabList } from "./SidebarTabList";
import { tabSpec } from "./tab-specs";

afterEach(() => {
  localStorage.clear();
});

function renderList() {
  return render(
    <SidebarTabProvider>
      <SidebarTabList idBase="x" />
    </SidebarTabProvider>,
  );
}

const TAB_IDS = ["recent", "favorites", "myNotes", "workspace", "shared", "trash"] as const;

describe("SidebarTabList", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("TL1：tablist 名、六顆 tab 的名稱／title／圖示／預設選中", () => {
    renderList();
    expect(screen.getByRole("tablist", { name: "Sidebar sections" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Recent",
      "Favorites",
      "My notes",
      "Groups",
      "Shared with me",
      "Trash",
    ]);
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual(
      tabs.map((tab) => tab.getAttribute("title")),
    );
    expect(tabs.map((tab) => tab.querySelector("svg")?.getAttribute("data-icon"))).toEqual([
      "clock",
      "star",
      "user",
      "users",
      "share",
      "trash",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "false", "true", "false", "false", "false"]);
  });

  it("TL2 roving：只有選中那顆 tabIndex 0", () => {
    renderList();
    expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1]);
  });

  it("TL3 點擊：切選中、tabIndex、並寫進 localStorage", () => {
    renderList();
    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    expect(screen.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Groups" }).tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: "My notes" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "My notes" }).tabIndex).toBe(-1);
    expect(localStorage.getItem("sidebar.tab")).toBe("workspace");
  });

  it("TL4 鍵盤：方向鍵循環、Home／End、preventDefault、其他鍵不處理", () => {
    renderList();
    const tab = (name: string) => screen.getByRole("tab", { name });
    const selected = () => screen.getAllByRole("tab").find((el) => el.getAttribute("aria-selected") === "true");

    tab("My notes").focus();
    expect(fireEvent.keyDown(tab("My notes"), { key: "ArrowRight" })).toBe(false);
    expect(selected()).toBe(tab("Groups"));
    expect(tab("Groups")).toHaveFocus();

    expect(fireEvent.keyDown(tab("Groups"), { key: "ArrowLeft" })).toBe(false);
    // 我的筆記的左邊是最愛，再左才是最近。
    expect(fireEvent.keyDown(tab("My notes"), { key: "ArrowLeft" })).toBe(false);
    expect(selected()).toBe(tab("Favorites"));
    expect(tab("Favorites")).toHaveFocus();
    expect(fireEvent.keyDown(tab("Favorites"), { key: "ArrowLeft" })).toBe(false);
    expect(selected()).toBe(tab("Recent"));
    expect(tab("Recent")).toHaveFocus();

    // 循環：第一顆往左 → 最後一顆；最後一顆往右 → 第一顆。
    expect(fireEvent.keyDown(tab("Recent"), { key: "ArrowLeft" })).toBe(false);
    expect(selected()).toBe(tab("Trash"));
    expect(tab("Trash")).toHaveFocus();
    expect(fireEvent.keyDown(tab("Trash"), { key: "ArrowRight" })).toBe(false);
    expect(selected()).toBe(tab("Recent"));
    expect(fireEvent.keyDown(tab("Recent"), { key: "ArrowRight" })).toBe(false);
    expect(selected()).toBe(tab("Favorites"));
    expect(tab("Favorites")).toHaveFocus();
    expect(fireEvent.keyDown(tab("Favorites"), { key: "ArrowRight" })).toBe(false);
    expect(selected()).toBe(tab("My notes"));
    expect(fireEvent.keyDown(tab("My notes"), { key: "Home" })).toBe(false);
    expect(selected()).toBe(tab("Recent"));

    expect(fireEvent.keyDown(tab("Recent"), { key: "End" })).toBe(false);
    expect(selected()).toBe(tab("Trash"));
    expect(tab("Trash")).toHaveFocus();
    expect(fireEvent.keyDown(tab("Trash"), { key: "Home" })).toBe(false);
    expect(selected()).toBe(tab("Recent"));
    expect(tab("Recent")).toHaveFocus();

    expect(fireEvent.keyDown(tab("Recent"), { key: "a" })).toBe(true);
    expect(selected()).toBe(tab("Recent"));
  });

  it("TL5 a11y 關聯：id 與 aria-controls 以 idBase 組成", () => {
    renderList();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.id)).toEqual(TAB_IDS.map((id) => `x-tab-${id}`));
    for (const tab of tabs) expect(tab).toHaveAttribute("aria-controls", "x-panel");
  });

  it("TL6 class：選中／未選的配色與共用的高度、焦點環", () => {
    renderList();
    expect(screen.getByRole("tab", { name: "My notes" })).toHaveClass("border-brand", "text-brand-on-soft");
    for (const name of ["Recent", "Favorites", "Groups", "Shared with me", "Trash"]) {
      expect(screen.getByRole("tab", { name })).toHaveClass("border-transparent", "text-muted-foreground");
    }
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab).toHaveClass("h-11", "md:h-9", "focus-visible:ring-2");
    }
  });

  it("TL6b 窄寬：六顆均分 tablist、不帶固定寬或左右內距，200 px 側欄也排得下", () => {
    // jsdom 沒有版面，這裡守住寬度的來源：每顆 `flex-1` 均分、內容只有 16 px 圖示。
    // 200 px 側欄扣掉 tablist 的 `mx-2` 剩 184 px，六顆各約 30 px；任何一顆加了固定寬、最小寬或左右內距，
    // 六顆的最小寬加總就可能超過 184 px。真瀏覽器量測在 e2e。
    renderList();
    const tablist = screen.getByRole("tablist");
    expect(tablist).toHaveClass("mx-2", "flex");
    expect(tablist.className).not.toMatch(/(^|\s)(overflow-x-auto|overflow-x-scroll|flex-wrap)(\s|$)/);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(6);
    for (const tab of tabs) {
      expect(tab).toHaveClass("flex-1");
      expect(tab.className).not.toMatch(/(^|\s)(md:)?(w|min-w|basis|px|pl|pr|p)-\S+/);
      expect(tab.className).not.toMatch(/(^|\s)shrink-0(\s|$)/);
      expect(tab.querySelector("svg")).toHaveClass("h-4", "w-4");
    }
  });

  it("TL6c 標題列動作：最愛 tab 不宣告任何動作（沒有選取、新增），其餘五顆都有選取", () => {
    expect(tabSpec("favorites").actions).toEqual([]);
    for (const id of TAB_IDS.filter((tab) => tab !== "favorites")) expect(tabSpec(id).actions).toContain("selectMode");
  });

  it("TL7 zh-TW：tablist 與 tab 名", async () => {
    await i18n.changeLanguage("zh-TW");
    renderList();
    expect(screen.getByRole("tablist", { name: "側欄分類" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "最近",
      "最愛",
      "我的筆記",
      "群組",
      "與我共享",
      "垃圾桶",
    ]);
  });
});
