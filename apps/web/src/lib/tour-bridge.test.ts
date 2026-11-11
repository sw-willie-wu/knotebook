import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDemoEditor,
  getShellControls,
  notifyEditorEditable,
  onEditorEditable,
  registerEditor,
  registerShellControls,
  type ShellControls,
  type TourEditor,
} from "./tour-bridge";

// 登記處是模組層狀態：每案把自己登記的東西撤乾淨，前一案失敗不連累下一案。
const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});
function keep(dispose: () => void): () => void {
  disposers.push(dispose);
  return dispose;
}

function shell(): ShellControls {
  return { showTab: vi.fn(), endSelectionIfActive: vi.fn(() => false), closeDrawer: vi.fn(), getTab: vi.fn(() => "myNotes" as const) };
}

/** 登記處只轉交 editor、不呼叫它的方法，所以用不同的空物件當替身就分得出是哪一份。 */
function fakeEditor(): TourEditor {
  return {} as TourEditor;
}

describe("tour-bridge：外殼控制", () => {
  it("B1 登記→取得→撤銷", () => {
    const a = shell();
    const unregister = registerShellControls(a);
    expect(getShellControls()).toBe(a);
    unregister();
    expect(getShellControls()).toBeNull();
  });

  it("B2 A 登記、B 登記、A 撤銷 → 仍取得 B；B 撤銷後才清空", () => {
    const a = shell();
    const b = shell();
    const unregisterA = keep(registerShellControls(a));
    const unregisterB = keep(registerShellControls(b));
    expect(getShellControls()).toBe(b);
    unregisterA();
    expect(getShellControls()).toBe(b);
    unregisterB();
    expect(getShellControls()).toBeNull();
  });
});

describe("tour-bridge：編輯器", () => {
  it("B1 登記→取得→撤銷", () => {
    const editor = fakeEditor();
    const unregister = registerEditor("note-1", editor);
    expect(getDemoEditor("note-1")).toBe(editor);
    unregister();
    expect(getDemoEditor("note-1")).toBeNull();
  });

  it("B2 A 登記、B 登記、A 撤銷 → 仍取得 B；B 撤銷後才清空", () => {
    const a = fakeEditor();
    const b = fakeEditor();
    const unregisterA = keep(registerEditor("note-1", a));
    const unregisterB = keep(registerEditor("note-1", b));
    expect(getDemoEditor("note-1")).toBe(b);
    unregisterA();
    expect(getDemoEditor("note-1")).toBe(b);
    unregisterB();
    expect(getDemoEditor("note-1")).toBeNull();
  });

  it("B3 傳入的 id 與登記的不同 → null（登記的那份照樣取得）", () => {
    const editor = fakeEditor();
    keep(registerEditor("note-1", editor));
    expect(getDemoEditor("other")).toBeNull();
    expect(getDemoEditor("note-1")).toBe(editor);
  });

  it("B3 什麼都沒登記 → null", () => {
    expect(getDemoEditor("note-1")).toBeNull();
  });

  it("B6 同一個編輯器實例只通知一次；換一個實例再通知一次", () => {
    const fn = vi.fn();
    keep(onEditorEditable(fn));
    const a = fakeEditor();
    notifyEditorEditable("note-1", a);
    notifyEditorEditable("note-1", a);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith("note-1", a);
    const b = fakeEditor();
    notifyEditorEditable("note-1", b);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("note-1", b);
  });

  it("B6 一支訂閱者拋錯 → 不往外拋、記到 console、下一支照跑", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("boom");
    keep(
      onEditorEditable(() => {
        throw boom;
      }),
    );
    const next = vi.fn();
    keep(onEditorEditable(next));
    const editor = fakeEditor();
    expect(() => notifyEditorEditable("note-1", editor)).not.toThrow();
    expect(next).toHaveBeenCalledWith("note-1", editor);
    expect(consoleError).toHaveBeenCalledWith(boom);
    consoleError.mockRestore();
  });

  it("B6 取消訂閱後不再被呼叫", () => {
    const fn = vi.fn();
    const off = onEditorEditable(fn);
    off();
    notifyEditorEditable("note-1", fakeEditor());
    expect(fn).not.toHaveBeenCalled();
  });
});
