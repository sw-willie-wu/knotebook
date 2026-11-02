import { describe, expect, it } from "vitest";
import { SHORTCUT_CATEGORIES, SHORTCUTS, visibleShortcuts } from "./shortcut-list";

/**
 * 條目資料與篩選（plan 2026-11-02-shortcuts-modal T3）。
 * 「清單 id ⇔ e2e 標籤」的雙向核對在 shortcut-e2e-coverage.test.ts（T9）；這裡只守資料形與站台能力篩選。
 */

const ids = (site: { aiAvailable: boolean; aiInstruct: boolean }) => visibleShortcuts(site).flatMap((g) => g.entries.map((e) => e.id));

describe("L1 分類", () => {
  it("恰為規定的順序", () => {
    expect([...SHORTCUT_CATEGORIES]).toEqual(["global", "typing", "markdown", "formatting", "columns", "sidebar", "presentation", "ai", "mouse"]);
  });
});

describe("L3 條目資料", () => {
  it("非空", () => expect(SHORTCUTS.length).toBeGreaterThan(0));
  it("id 不重複", () => {
    const all = SHORTCUTS.map((e) => e.id);
    expect(new Set(all).size).toBe(all.length);
  });
  it("每條的分類都在清單內", () => {
    for (const e of SHORTCUTS) expect(SHORTCUT_CATEGORIES, e.id).toContain(e.category);
  });
  it("每條至少一種按法", () => {
    for (const e of SHORTCUTS) expect(e.keys.length, e.id).toBeGreaterThan(0);
  });
});

describe("L4 站台能力篩選", () => {
  it("AI 全關：沒有 requires 的條目、沒有 ai 分類", () => {
    const groups = visibleShortcuts({ aiAvailable: false, aiInstruct: false });
    const shown = groups.flatMap((g) => g.entries);
    expect(shown.some((e) => e.requires !== undefined)).toBe(false);
    expect(groups.some((g) => g.category === "ai")).toBe(false);
  });

  it("AI 全開：aiSelect、aiSend、aiClose 都在", () => {
    expect(ids({ aiAvailable: true, aiInstruct: true })).toEqual(expect.arrayContaining(["aiSelect", "aiSend", "aiClose"]));
  });

  it("有 AI 但沒有 Instruct：aiSelect、aiClose 在、aiSend 不在", () => {
    const shown = ids({ aiAvailable: true, aiInstruct: false });
    expect(shown).toEqual(expect.arrayContaining(["aiSelect", "aiClose"]));
    expect(shown).not.toContain("aiSend");
  });

  it("三種組合都不回空分類，且分類順序照 SHORTCUT_CATEGORIES", () => {
    for (const site of [
      { aiAvailable: false, aiInstruct: false },
      { aiAvailable: true, aiInstruct: false },
      { aiAvailable: true, aiInstruct: true },
    ]) {
      const groups = visibleShortcuts(site);
      expect(groups.length).toBeGreaterThan(0);
      for (const g of groups) expect(g.entries.length, g.category).toBeGreaterThan(0);
      const order = groups.map((g) => SHORTCUT_CATEGORIES.indexOf(g.category));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });
});

describe("L5 redo", () => {
  it("Mac 另列、不含 Y（Chrome Mac 的 ⌘Y 是開歷史記錄）", () => {
    const redo = SHORTCUTS.find((e) => e.id === "redo");
    expect(redo, "redo 條目").toBeDefined();
    expect(redo!.macKeys, "redo 的 macKeys").toBeDefined();
    const macTokens = redo!.macKeys!.flatMap((k) => (k.kind === "combo" ? k.keys : []));
    expect(macTokens).not.toContain("Y");
    expect(macTokens).toEqual(["Mod", "Shift", "Z"]);
  });
});

describe("L6 多按法的分隔語意（sep）", () => {
  it("keys 有兩個以上的條目都有 sep", () => {
    for (const e of SHORTCUTS) if (e.keys.length > 1) expect(e.sep, e.id).toBeDefined();
  });

  it("不同動作（pair）與同一件事的不同按法（or）", () => {
    const sepOf = (id: string) => SHORTCUTS.find((e) => e.id === id)?.sep;
    for (const id of ["indent", "moveBlock", "presentNav", "heading", "checklist", "aiSend", "inlineMarks"]) expect(sepOf(id), id).toBe("pair");
    for (const id of ["redo", "bullet"]) expect(sepOf(id), id).toBe("or");
  });
});
