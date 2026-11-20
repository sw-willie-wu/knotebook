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

  it("tablist name, and the six tabs' names, titles, icons and default selection", () => {
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

  it("roving tabindex: only the selected tab has tabIndex 0", () => {
    renderList();
    expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1]);
  });

  it("click: switches selection and tabIndex, and writes to localStorage", () => {
    renderList();
    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    expect(screen.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Groups" }).tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: "My notes" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "My notes" }).tabIndex).toBe(-1);
    expect(localStorage.getItem("sidebar.tab")).toBe("workspace");
  });

  it("keyboard: arrow keys wrap around, Home/End, preventDefault, other keys ignored", () => {
    renderList();
    const tab = (name: string) => screen.getByRole("tab", { name });
    const selected = () => screen.getAllByRole("tab").find((el) => el.getAttribute("aria-selected") === "true");

    tab("My notes").focus();
    expect(fireEvent.keyDown(tab("My notes"), { key: "ArrowRight" })).toBe(false);
    expect(selected()).toBe(tab("Groups"));
    expect(tab("Groups")).toHaveFocus();

    expect(fireEvent.keyDown(tab("Groups"), { key: "ArrowLeft" })).toBe(false);
    expect(fireEvent.keyDown(tab("My notes"), { key: "ArrowLeft" })).toBe(false);
    expect(selected()).toBe(tab("Favorites"));
    expect(tab("Favorites")).toHaveFocus();
    expect(fireEvent.keyDown(tab("Favorites"), { key: "ArrowLeft" })).toBe(false);
    expect(selected()).toBe(tab("Recent"));
    expect(tab("Recent")).toHaveFocus();

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

  it("a11y: id and aria-controls are built from idBase", () => {
    renderList();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.id)).toEqual(TAB_IDS.map((id) => `x-tab-${id}`));
    for (const tab of tabs) expect(tab).toHaveAttribute("aria-controls", "x-panel");
  });

  it("classes: selected/unselected colors plus the shared height and focus ring", () => {
    renderList();
    expect(screen.getByRole("tab", { name: "My notes" })).toHaveClass("border-brand", "text-brand-on-soft");
    for (const name of ["Recent", "Favorites", "Groups", "Shared with me", "Trash"]) {
      expect(screen.getByRole("tab", { name })).toHaveClass("border-transparent", "text-muted-foreground");
    }
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab).toHaveClass("h-11", "pointer-fine:h-9", "focus-visible:ring-2");
      expect(tab).not.toHaveClass("md:h-9");
    }
  });

  it("narrow width: the six tabs split the tablist evenly with no fixed width or horizontal padding, so they fit a 200 px sidebar", () => {
    // jsdom has no layout, so this pins where the width comes from: each tab is `flex-1` and its content is only a 16 px icon.
    // A 200 px sidebar minus the card border and the tablist's `mx-2` leaves 182 px, about 30 px per tab; a fixed width, min width or horizontal padding
    // on any tab (any breakpoint prefix, ps/pe included), or spacing or padding on the tablist, can push the summed minimum widths past 182 px.
    renderList();
    const tablist = screen.getByRole("tablist");
    expect(tablist).toHaveClass("mx-2", "flex");
    expect(tablist.className).not.toMatch(/(^|\s)(overflow-x-auto|overflow-x-scroll|flex-wrap)(\s|$)/);
    expect(tablist.className).not.toMatch(/(^|\s)([a-z0-9-]+:)*(gap|gap-x|space-x|p|px|pl|pr|ps|pe)-\S+/);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(6);
    for (const tab of tabs) {
      expect(tab).toHaveClass("flex-1");
      expect(tab.className).not.toMatch(/(^|\s)([a-z0-9-]+:)*(w|min-w|basis|p|px|pl|pr|ps|pe)-\S+/);
      expect(tab.className).not.toMatch(/(^|\s)shrink-0(\s|$)/);
      expect(tab.querySelector("svg")).toHaveClass("h-4", "w-4");
    }
  });

  it("header actions: all six tabs declare select; the favorites tab has select only (no add)", () => {
    expect(tabSpec("favorites").actions).toEqual(["selectMode"]);
    for (const id of TAB_IDS) expect(tabSpec(id).actions).toContain("selectMode");
  });

  it("header actions: only My notes and Groups carry the tag filter, ahead of select", () => {
    for (const id of TAB_IDS) {
      const actions = tabSpec(id).actions;
      if (id === "myNotes" || id === "workspace") expect(actions.indexOf("tagFilter")).toBe(0);
      else expect(actions).not.toContain("tagFilter");
    }
  });

  it("zh-TW: tablist and tab names", async () => {
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
