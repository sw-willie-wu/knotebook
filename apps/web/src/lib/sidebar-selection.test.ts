import { describe, expect, it } from "vitest";
import { EMPTY_SELECTION, reduceSelection, selectionKey, SIDEBAR_SELECT_BUTTON, type SelectionOp, type SidebarSelection } from "./sidebar-selection";

const ORDER = ["a", "b", "c", "d", "e"] as const;

function run(ops: SelectionOp[], from: SidebarSelection = EMPTY_SELECTION): SidebarSelection {
  return ops.reduce(reduceSelection, from);
}

const keysOf = (state: SidebarSelection) => [...state.keys].sort();

describe("reduceSelection", () => {
  it("SL1 start／end：start 進入、end 回 EMPTY_SELECTION；非選取中 end 回原 state", () => {
    const started = run([{ type: "start" }]);
    expect(started.active).toBe(true);
    expect(started.keys.size).toBe(0);
    expect(started.anchor).toBeNull();
    expect(reduceSelection(run([{ type: "toggle", key: "a" }], started), { type: "end" })).toBe(EMPTY_SELECTION);

    const idle: SidebarSelection = { active: false, keys: new Set(), anchor: null };
    expect(reduceSelection(idle, { type: "end" })).toBe(idle);
  });

  it("SL2 toggle：加入、再 toggle 移除；anchor 是最後 toggle 的鍵", () => {
    const added = run([{ type: "start" }, { type: "toggle", key: "a" }]);
    expect(keysOf(added)).toEqual(["a"]);
    expect(added.anchor).toBe("a");
    const both = reduceSelection(added, { type: "toggle", key: "b" });
    expect(keysOf(both)).toEqual(["a", "b"]);
    expect(both.anchor).toBe("b");
    const removed = reduceSelection(both, { type: "toggle", key: "a" });
    expect(keysOf(removed)).toEqual(["b"]);
    expect(removed.anchor).toBe("a");
  });

  it("SL3 range：錨點到 key 之間全部加入、不取消區間外、anchor 不動", () => {
    const first = run([{ type: "start" }, { type: "toggle", key: "b" }, { type: "range", key: "d", order: ORDER }]);
    expect(keysOf(first)).toEqual(["b", "c", "d"]);
    expect(first.anchor).toBe("b");
    const second = reduceSelection(first, { type: "range", key: "a", order: ORDER });
    expect(keysOf(second)).toEqual(["a", "b", "c", "d"]);
    expect(second.anchor).toBe("b");
  });

  it("SL4 range 退化成單列切換：沒有錨點、錨點不在 order、key 不在 order", () => {
    const noAnchor = run([{ type: "start" }, { type: "range", key: "d", order: ORDER }]);
    expect(keysOf(noAnchor)).toEqual(["d"]);
    expect(noAnchor.anchor).toBe("d");

    const staleAnchor = run([{ type: "start" }, { type: "toggle", key: "x" }, { type: "range", key: "d", order: ORDER }]);
    expect(keysOf(staleAnchor)).toEqual(["d", "x"]);
    expect(staleAnchor.anchor).toBe("d");

    const outside = run([{ type: "start" }, { type: "toggle", key: "b" }, { type: "range", key: "z", order: ORDER }]);
    expect(keysOf(outside)).toEqual(["b", "z"]);
    expect(outside.anchor).toBe("z");
  });

  it("SL5 setAll／clear：setAll 換成給的鍵、anchor 不變；clear 清空且 anchor null", () => {
    const all = run([{ type: "start" }, { type: "toggle", key: "e" }, { type: "setAll", keys: ["a", "c"] }]);
    expect(keysOf(all)).toEqual(["a", "c"]);
    expect(all.anchor).toBe("e");
    const cleared = reduceSelection(all, { type: "clear" });
    expect(cleared.keys.size).toBe(0);
    expect(cleared.anchor).toBeNull();
    expect(cleared.active).toBe(true);
  });

  it("SL6 非選取中 toggle／range／setAll／clear 都回原 state", () => {
    const idle = EMPTY_SELECTION;
    expect(reduceSelection(idle, { type: "toggle", key: "a" })).toBe(idle);
    expect(reduceSelection(idle, { type: "range", key: "c", order: ORDER })).toBe(idle);
    expect(reduceSelection(idle, { type: "setAll", keys: ["a", "b"] })).toBe(idle);
    expect(reduceSelection(idle, { type: "clear" })).toBe(idle);
  });

  it("SL7 selectionKey 是 kind:id", () => {
    expect(selectionKey({ kind: "note", id: "x" })).toBe("note:x");
  });

  it("SL8 SIDEBAR_SELECT_BUTTON：標題列裡帶 data-sidebar-select 的鈕", () => {
    expect(SIDEBAR_SELECT_BUTTON).toBe("[data-sidebar-header] button[data-sidebar-select]");
  });
});

describe("資料夾鍵", () => {
  it("SS-F1 folder:a 與 note:a 是兩個鍵、toggle 互不影響", () => {
    expect(selectionKey({ kind: "folder", id: "a" })).toBe("folder:a");
    const state = run([{ type: "start" }, { type: "toggle", key: selectionKey({ kind: "folder", id: "a" }) }, { type: "toggle", key: selectionKey({ kind: "note", id: "a" }) }]);
    expect(keysOf(state)).toEqual(["folder:a", "note:a"]);
    expect(keysOf(run([{ type: "toggle", key: "folder:a" }], state))).toEqual(["note:a"]);
  });
});
