import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `lib/mermaid.ts` 的單元測試。
 *
 * ⚠ **mermaid 本體在 jsdom 裡跑不起來**：`mermaid.render()` 會暫時往 `document.body` 插一個
 * 隱藏 div 做文字量測（mermaid 11 型別檔 148-151 行逐字說明），而 jsdom 沒有 layout、
 * 沒有 `SVGElement.getBBox`。所以這一層的測試一律把 `mermaid` 模組整個 mock 掉，只驗**我們**
 * 的行為（id 產生、initialize 參數、錯誤不外拋、主題對映）。真正的渲染由 e2e 覆蓋。
 */

const renderMock = vi.hoisted(() => vi.fn());
const initializeMock = vi.hoisted(() => vi.fn());
const parseMock = vi.hoisted(() => vi.fn());

vi.mock("mermaid", () => ({
  default: { render: renderMock, initialize: initializeMock, parse: parseMock },
}));

const { nextMermaidId, renderMermaid, resetMermaidForTests, stripExternalResources } = await import("./mermaid");

beforeEach(() => {
  renderMock.mockReset();
  initializeMock.mockReset();
  parseMock.mockReset();
  parseMock.mockResolvedValue(true); // 預設語法有效
  resetMermaidForTests();
});

describe("nextMermaidId", () => {
  it("每次回傳不同的 id", () => {
    const ids = new Set([nextMermaidId(), nextMermaidId(), nextMermaidId()]);
    expect(ids.size).toBe(3);
  });

  it("id 是合法的 DOM id（字母開頭、只含 [A-Za-z0-9-]）", () => {
    // mermaid 會把這個 id 拿去當 DOM 元素的 id 與 SVG 內部的 id 前綴，
    // 數字開頭或含特殊字元會產生無效的選擇器。
    expect(nextMermaidId()).toMatch(/^[A-Za-z][A-Za-z0-9-]*$/);
  });

  it("不使用 crypto.randomUUID", () => {
    // 這個 repo 的正當拓撲包含 LAN plain-http（非 secure context），那裡
    // `crypto.randomUUID` **不存在**——`ui/toast.tsx` 已經為同一個原因改用模組層級計數器。
    // jsdom/Node 有 polyfill，所以只有這條斷言擋得住這個雷。
    const spy = vi.spyOn(globalThis.crypto, "randomUUID");
    nextMermaidId();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("renderMermaid", () => {
  it("成功時回傳 svg", async () => {
    renderMock.mockResolvedValue({ svg: "<svg id='x'></svg>" });
    const result = await renderMermaid("graph TD; A-->B;", "light");
    expect(result).toEqual({ ok: true, svg: "<svg id='x'></svg>" });
  });

  it("語法錯誤時回傳 ok:false 與訊息，不外拋", async () => {
    parseMock.mockRejectedValue(new Error("Parse error on line 2"));
    const result = await renderMermaid("not a diagram", "light");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("Parse error");
  });

  it("⚠ 語法錯誤時**絕不呼叫 render**（否則 mermaid 會把炸彈錯誤圖注入 document.body）", async () => {
    // 這是 2026-08-27 用瀏覽器實際看畫面才發現的 bug：`render()` 的拋錯路徑會在 body 留下
    // 一張「Syntax error in text」的圖，逃出元件邊界、每重繪一次多一張。
    // 修法是先 `parse()`（純驗證、不碰 DOM）。這條測試釘住那個順序。
    parseMock.mockRejectedValue(new Error("Parse error"));
    await renderMermaid("broken", "light");
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("先 parse 再 render（順序不可調換）", async () => {
    const order: string[] = [];
    parseMock.mockImplementation(async () => {
      order.push("parse");
      return true;
    });
    renderMock.mockImplementation(async () => {
      order.push("render");
      return { svg: "<svg></svg>" };
    });
    await renderMermaid("graph TD; A-->B;", "light");
    expect(order).toEqual(["parse", "render"]);
  });

  it("非 Error 的 reject 也收得住", async () => {
    renderMock.mockRejectedValue("boom");
    const result = await renderMermaid("x", "light");
    expect(result.ok).toBe(false);
  });

  it("以 securityLevel:strict 與 htmlLabels:false 初始化", async () => {
    // 圖是用 dangerouslySetInnerHTML 塞進 DOM 的，這兩個設定是第一道防線
    // （strict 模式背後是 mermaid 內建的 dompurify）。第二道是呼叫端對產出 SVG 的斷言。
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await renderMermaid("graph TD; A-->B;", "light");
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", startOnLoad: false, flowchart: expect.objectContaining({ htmlLabels: false }) }),
    );
  });

  it("主題對映：light → default、dark → dark", async () => {
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await renderMermaid("graph TD; A-->B;", "light");
    expect(initializeMock).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "default" }));

    await renderMermaid("graph TD; A-->B;", "dark");
    expect(initializeMock).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" }));
  });

  it("同一個主題連續渲染只 initialize 一次", async () => {
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await renderMermaid("a", "light");
    await renderMermaid("b", "light");
    expect(initializeMock).toHaveBeenCalledTimes(1);
  });

  it("主題換手時重新 initialize", async () => {
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await renderMermaid("a", "light");
    await renderMermaid("a", "dark");
    expect(initializeMock).toHaveBeenCalledTimes(2);
  });

  it("不呼叫 bindFunctions（圖裡的 click 宣告不得變成真的 handler）", async () => {
    const bindFunctions = vi.fn();
    renderMock.mockResolvedValue({ svg: "<svg></svg>", bindFunctions });
    await renderMermaid("graph TD; A-->B; click A callback", "light");
    expect(bindFunctions).not.toHaveBeenCalled();
  });

  it("空白原始碼直接回 ok:false，不打 mermaid", async () => {
    const result = await renderMermaid("   \n  ", "light");
    expect(result.ok).toBe(false);
    expect(renderMock).not.toHaveBeenCalled();
  });
});

describe("stripExternalResources（外部資源不得被載入）", () => {
  // 背景：mermaid 的 DOMPurify 只擋執行、不擋載入。這兩條路徑是審查者實測出來的，
  // 都會讓每個讀者的瀏覽器對圖表作者指定的主機發請求。

  it("image shape 產出的遠端 href 被拔掉（flowchart `A@{shape: image, img: …}`）", () => {
    const out = stripExternalResources('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>');
    expect(out).not.toContain("evil.example");
  });

  it("protocol-relative（//host）也算遠端", () => {
    const out = stripExternalResources('<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="//evil.example/x.png"/></svg>');
    expect(out).not.toContain("evil.example");
  });

  it("themeCSS 塞進 <style> 的遠端 url() 被清掉", () => {
    const out = stripExternalResources(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>#a{background:url(https://evil.example/x.png)}</style></svg>',
    );
    expect(out).not.toContain("evil.example");
  });

  it("style 屬性裡的遠端 url() 也清", () => {
    const out = stripExternalResources(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.example/x.png)"/></svg>',
    );
    expect(out).not.toContain("evil.example");
  });

  it("@import 被移除", () => {
    const out = stripExternalResources(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example/a.css);#a{fill:red}</style></svg>',
    );
    expect(out).not.toContain("evil.example");
    expect(out).toContain("fill:red");
  });

  it("⚠ 本地參照必須保留：url(#id) 是 mermaid 的箭頭 marker／mask 命脈", () => {
    const out = stripExternalResources(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>#a{marker-end:url(#arrowhead)}</style><path marker-end="url(#arrowhead)"/></svg>',
    );
    expect(out).toContain("url(#arrowhead)");
  });

  it("data: 不外連，保留", () => {
    const out = stripExternalResources(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA"/></svg>',
    );
    expect(out).toContain("data:image/png");
  });

  it("fail closed：SVG 解析失敗時不原樣放行，仍然清掉遠端參照", () => {
    const broken = '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"><style>#a{background:url(https://evil.example/y.png)}';
    const out = stripExternalResources(broken);
    expect(out).not.toContain("evil.example");
  });

  it("接線：renderMermaid 的輸出真的有經過清洗（不只是函式本身正確）", async () => {
    renderMock.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>' });
    const result = await renderMermaid("graph TD; A-->B;", "light");
    expect(result.ok).toBe(true);
    expect(result.ok && result.svg).not.toContain("evil.example");
  });
});
