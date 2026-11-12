import { afterEach, describe, expect, it, vi } from "vitest";
import { NARROW_QUERY } from "@/lib/sidebar-drawer";
import { findUserMenuReturnTarget, isNarrowViewport } from "./tour-targets";

function stubNarrow(narrow: boolean) {
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

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("導覽結束後要聚焦的使用者選單觸發鈕", () => {
  function mount() {
    document.body.innerHTML = `
      <button data-kb-tour-target="drawerButton">Open navigation</button>
      <aside><button data-kb-tour-target="userMenu">Ann</button></aside>
    `;
    return {
      account: document.querySelector('[data-kb-tour-target="userMenu"]'),
      hamburger: document.querySelector('[data-kb-tour-target="drawerButton"]'),
    };
  }

  it("寬視窗：側欄的帳號列", () => {
    stubNarrow(false);
    const { account } = mount();
    expect(isNarrowViewport()).toBe(false);
    expect(findUserMenuReturnTarget()).toBe(account);
  });

  it("窄視窗：開抽屜的漢堡鈕（使用者選單在已經關掉的抽屜裡）", () => {
    stubNarrow(true);
    const { hamburger } = mount();
    expect(isNarrowViewport()).toBe(true);
    expect(findUserMenuReturnTarget()).toBe(hamburger);
  });

  it("每次呼叫都重查：換殼後拿到的是新掛上的那顆", () => {
    stubNarrow(false);
    mount();
    document.body.innerHTML = `<aside><button data-kb-tour-target="userMenu">Ann</button></aside>`;
    expect(findUserMenuReturnTarget()).toBe(document.querySelector('[data-kb-tour-target="userMenu"]'));
  });
});
