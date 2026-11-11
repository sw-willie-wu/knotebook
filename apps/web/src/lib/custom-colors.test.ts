import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOM_COLORS_STYLE_ID,
  customColorSelectors,
  ensureCustomColor,
  installCustomColors,
  resetCustomColorsForTest,
} from "./custom-colors";

const styleEl = () => document.getElementById(CUSTOM_COLORS_STYLE_ID) as HTMLStyleElement | null;
const selectors = () => Array.from(styleEl()?.sheet?.cssRules ?? []).map((r) => (r as CSSStyleRule).selectorText);

afterEach(() => {
  vi.restoreAllMocks();
  resetCustomColorsForTest();
  document.body.innerHTML = "";
});

describe("customColorSelectors (#378)", () => {
  it("CC1 inline 兩條、block 三條，inline 不含 :has", () => {
    const inline = customColorSelectors("inline", "textColor", "#ff6600");
    expect(inline).toEqual([
      '[data-style-type="textColor"][data-value="#ff6600"]',
      '.kn-present [data-style-type="textColor"][data-value="#ff6600"]',
    ]);
    expect(inline.some((s) => s.includes(":has("))).toBe(false);
    expect(customColorSelectors("block", "backgroundColor", "#00ff00")).toEqual([
      '[data-background-color="#00ff00"]',
      '.bn-block:has(> .bn-block-content[data-background-color="#00ff00"])',
      '.kn-present [data-background-color="#00ff00"]',
    ]);
  });
});

describe("ensureCustomColor (#378)", () => {
  it("CC2 重複登記只建一個 style、三條規則", () => {
    ensureCustomColor("block", "textColor", "#ff6600");
    ensureCustomColor("block", "textColor", "#ff6600");
    expect(document.querySelectorAll(`#${CUSTOM_COLORS_STYLE_ID}`)).toHaveLength(1);
    expect(styleEl()!.sheet!.cssRules.length).toBe(3);
  });

  it("CC3b 型別之外的 prop 不產生規則", () => {
    ensureCustomColor("block", 'x"], *, [data-x="' as never, "#ff6600");
    ensureCustomColor("inline", "color" as never, "#ff6600");
    expect(styleEl()?.sheet?.cssRules.length ?? 0).toBe(0);
  });

  // 含大括號的值即使放行，jsdom 的 insertRule 也會自己拒絕；這案只證明「最後不會有規則」，
  // 擋下注入的是下一案（單一規則內跳出屬性選擇器、不靠解析器拒絕）。
  it("CC3 含大括號的值不留下規則（解析器也會拒絕）", () => {
    ensureCustomColor("block", "textColor", '#ff6600"] , * { color: red } [');
    expect(styleEl()?.sheet?.cssRules.length ?? 0).toBe(0);
  });

  it.each(["#FF6600", "rgb(255, 102, 0)", "red;x:y", 'x"], *, [data-x="', "#f60"])(
    "CC3 非正規形不產生規則：%s",
    (bad) => {
      ensureCustomColor("block", "textColor", bad);
      ensureCustomColor("inline", "backgroundColor", bad);
      expect(styleEl()?.sheet?.cssRules.length ?? 0).toBe(0);
    },
  );

  it("CC4 computed：:has 讓子 block 繼承、inline 底色、簡報內文字色", () => {
    document.body.innerHTML =
      '<div class="bn-block"><div class="bn-block-content" data-text-color="#ff6600"></div>' +
      '<div class="bn-block-group"><div class="bn-block"><p id="child">child</p></div></div></div>' +
      '<span id="inl" data-style-type="backgroundColor" data-value="#00ff00">x</span>' +
      '<div class="kn-present"><h2 id="pres" data-text-color="#0000ff">h</h2></div>';
    ensureCustomColor("block", "textColor", "#ff6600");
    ensureCustomColor("inline", "backgroundColor", "#00ff00");
    ensureCustomColor("block", "textColor", "#0000ff");
    expect(getComputedStyle(document.getElementById("child")!).color).toBe("rgb(255, 102, 0)");
    expect(getComputedStyle(document.getElementById("inl")!).backgroundColor).toBe("rgb(0, 255, 0)");
    expect(getComputedStyle(document.getElementById("pres")!).color).toBe("rgb(0, 0, 255)");
  });

  it("CC5 :has 規則被瀏覽器拒絕時，其餘規則仍登記、不丟例外", () => {
    const orig = CSSStyleSheet.prototype.insertRule;
    vi.spyOn(CSSStyleSheet.prototype, "insertRule").mockImplementation(function (this: CSSStyleSheet, rule: string, index?: number) {
      if (rule.includes(":has(")) throw new DOMException("bad", "SyntaxError");
      return orig.call(this, rule, index);
    });
    expect(() => ensureCustomColor("block", "textColor", "#ff6600")).not.toThrow();
    const sels = selectors();
    expect(sels).toContain('[data-text-color="#ff6600"]');
    expect(sels).toContain('.kn-present [data-text-color="#ff6600"]');
    expect(sels.some((s) => s.includes(":has("))).toBe(false);
  });
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const OBSERVER_KEY = Symbol.for("knotebook.customColors.observer");

describe("installCustomColors (#378)", () => {
  it("OB1 安裝前已存在的色碼元素，安裝時全量掃描登記", () => {
    document.body.innerHTML = '<span data-style-type="textColor" data-value="#ff6600">x</span>';
    installCustomColors();
    expect(selectors()).toContain('[data-style-type="textColor"][data-value="#ff6600"]');
  });

  it("OB2 安裝後直接掛上 body 的裸 span 也登記（元素本身要比對選擇器）", async () => {
    installCustomColors();
    const span = document.createElement("span");
    span.setAttribute("data-style-type", "textColor");
    span.setAttribute("data-value", "#ff6600");
    document.body.append(span);
    await flush();
    expect(selectors()).toContain('[data-style-type="textColor"][data-value="#ff6600"]');
  });

  it("OB3 安裝後掛上含 block 色碼後代的容器，登記 block 規則", async () => {
    installCustomColors();
    const div = document.createElement("div");
    div.innerHTML = '<p data-text-color="#00ff00"></p>';
    document.body.append(div);
    await flush();
    expect(selectors()).toContain('[data-text-color="#00ff00"]');
  });

  it("OB4 屬性改成色碼時登記；非顏色的 data-value 不登記", async () => {
    document.body.innerHTML =
      '<p id="p" data-background-color="red"></p><span id="l" data-style-type="link" data-value="#123456"></span>';
    installCustomColors();
    expect(styleEl()?.sheet?.cssRules.length ?? 0).toBe(0);
    document.getElementById("p")!.setAttribute("data-background-color", "#0000ff");
    document.getElementById("l")!.setAttribute("data-value", "#abcdef");
    await flush();
    const sels = selectors();
    expect(sels).toContain('[data-background-color="#0000ff"]');
    expect(sels.some((s) => s.includes("#123456") || s.includes("#abcdef"))).toBe(false);
  });

  it("OB4b 非正規形的屬性值不登記", async () => {
    installCustomColors();
    const p = document.createElement("p");
    p.setAttribute("data-text-color", "#FF6600");
    document.body.append(p);
    await flush();
    expect(styleEl()?.sheet?.cssRules.length ?? 0).toBe(0);
  });

  it("OB5 連裝兩次：只有一個 style，且重裝會斷開舊 observer", () => {
    document.body.innerHTML = '<span data-style-type="textColor" data-value="#ff6600">x</span>';
    const spy = vi.spyOn(MutationObserver.prototype, "disconnect");
    installCustomColors();
    const first = (document as unknown as Record<symbol, unknown>)[OBSERVER_KEY];
    expect(first).toBeTruthy();
    spy.mockClear();
    installCustomColors();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((document as unknown as Record<symbol, unknown>)[OBSERVER_KEY]).not.toBe(first);
    expect(document.querySelectorAll(`#${CUSTOM_COLORS_STYLE_ID}`)).toHaveLength(1);
  });
});
