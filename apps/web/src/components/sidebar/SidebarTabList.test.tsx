import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { SidebarTabProvider } from "@/lib/sidebar-tab";
import { SidebarTabList } from "./SidebarTabList";

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

const TAB_IDS = ["recent", "myNotes", "workspace", "shared"] as const;

describe("SidebarTabList", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("TL1：tablist 名、四顆 tab 的名稱／title／圖示／預設選中", () => {
    renderList();
    expect(screen.getByRole("tablist", { name: "Sidebar sections" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Recent",
      "My notes",
      "Workspace",
      "Shared with me",
    ]);
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual(
      tabs.map((tab) => tab.getAttribute("title")),
    );
    expect(tabs.map((tab) => tab.querySelector("svg")?.getAttribute("data-icon"))).toEqual([
      "clock",
      "user",
      "users",
      "share",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
  });

  it("TL2 roving：只有選中那顆 tabIndex 0", () => {
    renderList();
    expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([-1, 0, -1, -1]);
  });

  it("TL3 點擊：切選中、tabIndex、並寫進 localStorage", () => {
    renderList();
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    expect(screen.getByRole("tab", { name: "Workspace" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Workspace" }).tabIndex).toBe(0);
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
    expect(selected()).toBe(tab("Workspace"));
    expect(tab("Workspace")).toHaveFocus();

    expect(fireEvent.keyDown(tab("Workspace"), { key: "ArrowLeft" })).toBe(false);
    expect(fireEvent.keyDown(tab("My notes"), { key: "ArrowLeft" })).toBe(false);
    expect(selected()).toBe(tab("Recent"));
    expect(tab("Recent")).toHaveFocus();

    // 循環：第一顆往左 → 最後一顆；最後一顆往右 → 第一顆。
    expect(fireEvent.keyDown(tab("Recent"), { key: "ArrowLeft" })).toBe(false);
    expect(selected()).toBe(tab("Shared with me"));
    expect(tab("Shared with me")).toHaveFocus();
    expect(fireEvent.keyDown(tab("Shared with me"), { key: "ArrowRight" })).toBe(false);
    expect(selected()).toBe(tab("Recent"));

    expect(fireEvent.keyDown(tab("Recent"), { key: "End" })).toBe(false);
    expect(selected()).toBe(tab("Shared with me"));
    expect(tab("Shared with me")).toHaveFocus();
    expect(fireEvent.keyDown(tab("Shared with me"), { key: "Home" })).toBe(false);
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
    for (const name of ["Recent", "Workspace", "Shared with me"]) {
      expect(screen.getByRole("tab", { name })).toHaveClass("border-transparent", "text-muted-foreground");
    }
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab).toHaveClass("h-11", "md:h-9", "focus-visible:ring-2");
    }
  });

  it("TL7 zh-TW：tablist 與 tab 名", async () => {
    await i18n.changeLanguage("zh-TW");
    renderList();
    expect(screen.getByRole("tablist", { name: "側欄分類" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "最近",
      "我的筆記",
      "工作坊",
      "與我共享",
    ]);
  });
});
