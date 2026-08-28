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
      // `htmlLabels` 兩個位置都要：全域鍵是 mermaid 11 的新位置，`flowchart.*` 是舊版相容。
      // 只斷言其中一個的話，另一個被刪掉不會轉紅（第 2 輪審查突變實測）。
      expect.objectContaining({
        securityLevel: "strict",
        startOnLoad: false,
        htmlLabels: false,
        flowchart: expect.objectContaining({ htmlLabels: false }),
      }),
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

  it("元素上的遠端 href 被拔掉", () => {
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

describe("stripExternalResources — 繞過形（第 2 輪審查實測出來的六種）", () => {
  // 第一版是黑名單（比對 `https?://`），下面每一條都當場繞過去。留著當迴歸守門：
  // 任何「改回用 pattern 比對可疑形狀」的重構都會讓這一組轉紅。

  it("URL 裡插 ASCII 控制字元（URL parser 會把它丟掉，瀏覽器照樣連得出去）", () => {
    const out = stripExternalResources(`<svg xmlns="http://www.w3.org/2000/svg"><image href="ht\tps://evil.example/x.png"/></svg>`);
    expect(out).not.toContain("evil.example");
  });

  it("CSS escape 的 scheme（backslash-68 ttps:）", () => {
    const out = stripExternalResources(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>#a{background:url(\\68 ttps://evil.example/x.png)}</style></svg>',
    );
    expect(out).not.toContain("evil.example");
  });

  it("url( 後面塞 CSS 註解", () => {
    const out = stripExternalResources(
      `<svg xmlns="http://www.w3.org/2000/svg"><style>#a{background:url(/**/"https://evil.example/x.png")}</style></svg>`,
    );
    expect(out).not.toContain("evil.example");
  });

  it("CSS escape 的 at-rule（backslash-40 import）", () => {
    const out = stripExternalResources(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>\\40 import "https://evil.example/a.css";</style></svg>',
    );
    expect(out).not.toContain("evil.example");
  });

  it("image-set()／cross-fade() 這類 url() 以外的資源函式", () => {
    const out = stripExternalResources(
      `<svg xmlns="http://www.w3.org/2000/svg"><style>#a{background:image-set("https://evil.example/x.png" 1x)}</style></svg>`,
    );
    expect(out).not.toContain("evil.example");
  });

  it("解析失敗的文件裡、沒加引號的屬性值", () => {
    const out = stripExternalResources(`<svg xmlns="http://www.w3.org/2000/svg"><image href=https://evil.example/x.png><style>#a{`);
    expect(out).not.toContain("evil.example");
  });
});

describe("stripExternalResources — 不得誤傷", () => {
  it("同源／相對網址保留（自家上傳的圖）", () => {
    const out = stripExternalResources(`<svg xmlns="http://www.w3.org/2000/svg"><image href="/api/notes/n1/uploads/a.png"/></svg>`);
    expect(out).toContain("/api/notes/n1/uploads/a.png");
  });

  it("⚠ 圖表**文字內容**不得被改寫（字串層清洗只在解析失敗時跑）", () => {
    // 第 2 輪審查實測：成功路徑也跑字串層清洗的話，`<text>` 裡剛好寫著 url(...) 的
    // 圖表文字會被改成 `none`——使用者的圖被靜默改字。
    const out = stripExternalResources(
      `<svg xmlns="http://www.w3.org/2000/svg"><text>see url(https://example.com) ok</text></svg>`,
    );
    expect(out).toContain("see url(https://example.com) ok");
  });

  it("⚠ `<a href>` 保留並補 rel——那是使用者主動點才會連出去的（mermaid 的 click X href）", () => {
    const out = stripExternalResources(
      `<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com"><rect/></a></svg>`,
    );
    expect(out).toContain("https://example.com");
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("`<a href=\"javascript:…\">` 仍然拔掉", () => {
    const out = stripExternalResources(`<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>`);
    expect(out).not.toContain("javascript:");
  });

  it("url() 的引號裡有括號時不會留下壞掉的 CSS", () => {
    const out = stripExternalResources(
      `<svg xmlns="http://www.w3.org/2000/svg"><style>#a{background:url("https://evil.example/x(1).png")}</style></svg>`,
    );
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain(".png");
  });
});

describe("directive 鎖定（第 3 輪審查 I-A／I-B：輸出端清洗根本來不及）", () => {
  it("secure 清單鎖住 themeCSS／htmlLabels／flowchart，且保留 mermaid 內建的六個", async () => {
    // 為什麼這條是**主**防線：`render()` 會把圖插進活的 document 做文字量測，
    // 瀏覽器當場套用 `<style>` 並發出請求——等我們拿到 SVG 字串再清洗，請求早就送出去了
    // （審查者用 Playwright 實測：渲染後完全不插進頁面，themeCSS 的 url() 照樣命中）。
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await renderMermaid("graph TD; A-->B;", "light");

    const [config] = initializeMock.mock.calls[0] as [{ secure: string[] }];
    expect(config.secure).toEqual(
      expect.arrayContaining([
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "themeCSS",
        "htmlLabels",
        "flowchart",
      ]),
    );
  });
});

describe("stripExternalResources — 第 3 輪審查抓到的形", () => {
  it("double-escape：我們解一次、瀏覽器再解一次（\\68ttps:）", () => {
    // `new URL("\\https://…", base)` 在 WHATWG 規則下把 `\` 當成 `/`，會解析成同源路徑
    // ——所以「解 escape 後再判斷」反而會放行。判斷改成看到反斜線就當不安全。
    const out = stripExternalResources(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>#a{background:url("\\68ttps://evil.example/x.png")}</style></svg>',
    );
    expect(out).not.toContain("evil.example");
  });

  it("HTML entity 的屬性值（輸出是用 dangerouslySetInnerHTML 插進去的，entity 會被解碼）", () => {
    const out = stripExternalResources('<svg xmlns="http://www.w3.org/2000/svg"><image href="&#104;ttps://evil.example/x.png"/></svg>');
    expect(out).not.toContain("evil.example");
  });

  it("srcset／poster／background 這些同樣會自動抓資源的屬性", () => {
    const out = stripExternalResources(
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img src="#" srcset="https://evil.example/x.png 1x"/><video poster="https://evil.example/p.jpg"></video></foreignObject></svg>',
    );
    expect(out).not.toContain("evil.example");
  });

  it("srcset 只要有一個候選不安全就整條拿掉（不是只看第一個）", () => {
    const out = stripExternalResources(
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img srcset="/local.png 1x, https://evil.example/x.png 2x"/></foreignObject></svg>',
    );
    expect(out).not.toContain("evil.example");
  });

  it("巢狀括號的資源函式（image-set(… type(…))）", () => {
    const out = stripExternalResources(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>#a{background:image-set("https://evil.example/x.png" type("image/png"))}</style></svg>',
    );
    expect(out).not.toContain("evil.example");
  });

  it("多目標的資源函式：第二個才是外連也要抓到", () => {
    const out = stripExternalResources(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>#a{background:image-set("/ok.png" 1x, "https://evil.example/x.png" 2x)}</style></svg>',
    );
    expect(out).not.toContain("evil.example");
  });
});

describe("stripExternalResources — 真實 mermaid 輸出的形狀（第 3 輪審查 I-D）", () => {
  // ⚠ 這一組全部用**真的 mermaid 會產出的形狀**：`xlink:href` 但**沒有宣告 `xmlns:xlink`**。
  // 舊版用 XML parser，這種輸入必定 parsererror、落到字串 fallback，結果是連結被整條拔掉、
  // 圖表文字被改寫。手寫「乾淨」的 SVG 測不到這一族——那正是第 2 輪留下來的假綠。

  const REAL_SHAPE = '<svg aria-roledescription="flowchart-v2" xmlns="http://www.w3.org/2000/svg"><a xlink:href="https://example.com/docs" class="clickable"><text>see url(https://example.com) ok</text></a></svg>';

  it("click X href 產生的連結**保留**，並補上 rel", () => {
    const out = stripExternalResources(REAL_SHAPE);
    expect(out).toContain("https://example.com/docs");
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("同一份輸出裡的圖表文字不得被改寫", () => {
    expect(stripExternalResources(REAL_SHAPE)).toContain("see url(https://example.com) ok");
  });

  it("`<a href=\"data:…\">` 不放行（導航目標，不是資源）", () => {
    const out = stripExternalResources('<svg xmlns="http://www.w3.org/2000/svg"><a href="data:text/html,<script>alert(1)</script>"><rect/></a></svg>');
    expect(out).not.toContain("data:text/html");
  });
});

describe("stripExternalResources — 正常 CSS 不得被改壞（第 3 輪審查 M-3／M-4）", () => {
  it("CSS escape 原樣保留（解 escape 只用於判斷，不寫回）", () => {
    const css = '<svg xmlns="http://www.w3.org/2000/svg"><style>#a::after{content:"\\22 hi"}</style></svg>';
    expect(stripExternalResources(css)).toContain('content:"\\22 hi"');
  });

  it("子代選擇器的 > 在**插回頁面之後**仍然是 >（第 2 輪那版用 XMLSerializer，這裡驗真正在意的往返）", () => {
    // 序列化字串裡出現 `&gt;` 本身沒關係——`<style>` 在 SVG 底下屬於 foreign content，
    // HTML parser 會把字元參照解回來（實測）。真正要守的是**往返之後**選擇器還在，
    // 因為輸出是用 `dangerouslySetInnerHTML`（＝HTML parser）插進頁面的。
    const css = '<svg xmlns="http://www.w3.org/2000/svg"><style>.a > .b{fill:red}</style><image href="https://evil.example/x.png"/></svg>';
    const out = stripExternalResources(css);
    expect(out).not.toContain("evil.example"); // 確定有走到「改寫並重新序列化」那條路

    const reinserted = document.createElement("div");
    reinserted.innerHTML = out;
    expect(reinserted.querySelector("style")?.textContent).toContain(".a > .b");
  });

  it("url(#id) 與正常宣告完全不動", () => {
    const css = '<svg xmlns="http://www.w3.org/2000/svg"><style>#a{marker-end:url(#arrowhead);fill:url(#gradient)}</style></svg>';
    const out = stripExternalResources(css);
    expect(out).toContain("url(#arrowhead)");
    expect(out).toContain("url(#gradient)");
  });
});
