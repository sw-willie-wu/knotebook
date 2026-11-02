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

/**
 * `default` 用 getter：`renderMermaid` 在 try 裡解構 `{ default: mermaid } = await import("mermaid")`，
 * 讀 `default` 的那一刻就是「載入完成」。`onLoad` 讓測試在那一刻插手（模擬下載期間被取消），
 * `loadError` 讓它丟錯（模擬 chunk 載入失敗）。
 */
const loadHooks = vi.hoisted(() => ({ onLoad: null as (() => void) | null, loadError: null as Error | null }));

vi.mock("mermaid", () => ({
  get default() {
    loadHooks.onLoad?.();
    if (loadHooks.loadError !== null) throw loadHooks.loadError;
    return { render: renderMock, initialize: initializeMock, parse: parseMock };
  },
}));

const { MERMAID_CACHE_LIMIT, cachedMermaid, nextMermaidId, renderMermaid, resetMermaidForTests, rewriteMermaidId } = await import("./mermaid");

beforeEach(() => {
  renderMock.mockReset();
  initializeMock.mockReset();
  parseMock.mockReset();
  parseMock.mockResolvedValue(true);
  loadHooks.onLoad = null;
  loadHooks.loadError = null;
  resetMermaidForTests();
});

/** 一個由測試手動 resolve 的 promise。 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** 等到 `predicate()` 成立（佇列每項之間會讓出一個 macrotask，所以要等 macrotask，不是只 flush microtask）。 */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !predicate(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(predicate()).toBe(true);
}

/** 像 mermaid 一樣把 id 寫進輸出各處的假 SVG（根 id、style 選擇器、marker 與 url() 引用）。 */
function svgFor(id: string): string {
  return `<svg id="${id}"><style>#${id} .node{fill:red}</style><marker id="${id}_flowchart-v2-pointEnd"/><path marker-end="url(#${id}_flowchart-v2-pointEnd)"/></svg>`;
}

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
    // `suppressErrorRendering: true` 下，語法錯由 `render()` 自己 throw。
    renderMock.mockRejectedValue(new Error("Parse error on line 2"));
    const result = await renderMermaid("not a diagram", "light");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("Parse error");
  });

  it("⚠ 以 suppressErrorRendering:true 初始化（否則 render 語法錯會把錯誤圖留在 document.body）", async () => {
    // 2026-08-27 用瀏覽器看畫面才發現：預設設定下 `render()` 的拋錯路徑會在 body 留下一張
    // 「Syntax error in text」的圖，逃出元件邊界、每重繪一次多一張。當時靠先 `parse()` 擋；
    // #344 改成這個設定（mermaid 在兩條拋錯路徑都先清掉暫時容器），body 沒有殘留由 e2e 06 在真瀏覽器驗。
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await renderMermaid("graph TD; A-->B;", "light");
    expect(initializeMock).toHaveBeenCalledWith(expect.objectContaining({ suppressErrorRendering: true }));
  });

  it("不先 parse（render 內部本來就會 parse，先 parse 是每張圖重工一次）", async () => {
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await renderMermaid("graph TD; A-->B;", "light");
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(parseMock).not.toHaveBeenCalled();
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

describe("序列化佇列（#344 C）", () => {
  it("一次只畫一張：前一張沒畫完，下一張不開始", async () => {
    const first = deferred<{ svg: string }>();
    renderMock.mockImplementationOnce(() => first.promise).mockResolvedValueOnce({ svg: "<svg>b</svg>" });

    const a = renderMermaid("a", "light");
    const b = renderMermaid("b", "light");
    await until(() => renderMock.mock.calls.length === 1);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(renderMock).toHaveBeenCalledTimes(1);

    first.resolve({ svg: "<svg>a</svg>" });
    await expect(a).resolves.toEqual({ ok: true, svg: "<svg>a</svg>" });
    await expect(b).resolves.toEqual({ ok: true, svg: "<svg>b</svg>" });
    expect(renderMock).toHaveBeenCalledTimes(2);
  });

  it("兩張之間讓出主執行緒：前一張畫完時排的 macrotask，會在下一張開始之前執行", async () => {
    // 這就是「使用者的輸入插得進兩張圖之間」：mermaid 自己的佇列在兩張之間只走 microtask。
    const order: string[] = [];
    renderMock.mockImplementation(async (_id: string, code: string) => {
      order.push(`render:${code}`);
      if (code === "a") setTimeout(() => order.push("macrotask"), 0);
      return { svg: "<svg></svg>" };
    });
    await Promise.all([renderMermaid("a", "light"), renderMermaid("b", "light")]);
    expect(order).toEqual(["render:a", "macrotask", "render:b"]);
  });

  it("每張之前先等一個 frame（畫好的圖先上螢幕、IntersectionObserver 先回報）：frame 沒來之前不開始", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    try {
      renderMock.mockResolvedValue({ svg: "<svg></svg>" });
      const a = renderMermaid("a", "light");
      const b = renderMermaid("b", "light");
      await until(() => frames.length === 1);
      expect(renderMock).not.toHaveBeenCalled();
      frames.shift()!(0);
      await a;
      expect(renderMock).toHaveBeenCalledTimes(1);

      await until(() => frames.length === 1);
      expect(renderMock).toHaveBeenCalledTimes(1);
      frames.shift()!(0);
      await b;
      expect(renderMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("分頁在背景（rAF 不跑）時不等 frame，佇列不會卡住", async () => {
    const raf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      renderMock.mockResolvedValue({ svg: "<svg></svg>" });
      await expect(renderMermaid("a", "light")).resolves.toEqual({ ok: true, svg: "<svg></svg>" });
      expect(raf).not.toHaveBeenCalled();
    } finally {
      visibility.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("排隊中被取消的項目輪到時不畫、以 AbortError reject，且不擋後面的項目", async () => {
    const first = deferred<{ svg: string }>();
    renderMock.mockImplementationOnce(() => first.promise).mockResolvedValue({ svg: "<svg>c</svg>" });

    const a = renderMermaid("a", "light");
    const controller = new AbortController();
    const b = renderMermaid("b", "light", { signal: controller.signal });
    const c = renderMermaid("c", "light");
    await until(() => renderMock.mock.calls.length === 1);
    controller.abort();
    first.resolve({ svg: "<svg>a</svg>" });

    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    await expect(c).resolves.toEqual({ ok: true, svg: "<svg>c</svg>" });
    await a;
    expect(renderMock.mock.calls.map((call) => call[1])).toEqual(["a", "c"]);
  });

  it("輪到時已被取消的項目直接跳過，不付讓出的那一個 frame", async () => {
    let frames = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames += 1;
      setTimeout(() => cb(0), 0);
      return frames;
    });
    try {
      renderMock.mockResolvedValue({ svg: "<svg></svg>" });
      const controller = new AbortController();
      controller.abort();
      const b = renderMermaid("b", "light", { signal: controller.signal });
      const c = renderMermaid("c", "light");
      await expect(b).rejects.toMatchObject({ name: "AbortError" });
      await c;
      expect(frames).toBe(1); // 只有 c 等了 frame
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rAF 一直沒來（等待途中分頁被切到背景）：100 ms 保底後照樣開始", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestAnimationFrame", () => 0); // 永遠不回呼
    try {
      renderMock.mockResolvedValue({ svg: "<svg></svg>" });
      const p = renderMermaid("a", "light");
      await vi.advanceTimersByTimeAsync(99);
      expect(renderMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(p).resolves.toEqual({ ok: true, svg: "<svg></svg>" });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("讓出主執行緒的那段期間被取消，也不畫", async () => {
    // 先排的 timer 先跑：abort 落在「通過第一次檢查之後、讓出結束之前」。
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);
    const p = renderMermaid("a", "light", { signal: controller.signal });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("下載 mermaid 期間被取消（捲走、卸載）：載完也不畫，以 AbortError reject", async () => {
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    const controller = new AbortController();
    loadHooks.onLoad = () => controller.abort(); // 取消落在「開始載入之後、載入完成之前」
    const p = renderMermaid("a", "light", { signal: controller.signal });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(renderMock).not.toHaveBeenCalled();
    expect(initializeMock).not.toHaveBeenCalled();
  });

  it("mermaid chunk 載入失敗：轉成 ok:false（不 reject——簡報模式不帶 signal，靠的是永不 reject）", async () => {
    loadHooks.loadError = new Error("Failed to fetch dynamically imported module");
    await expect(renderMermaid("a", "light")).resolves.toEqual({ ok: false, message: "Failed to fetch dynamically imported module" });
    expect(renderMock).not.toHaveBeenCalled();

    // 網路恢復後重畫要能成功（失敗沒有被快取、佇列沒有卡住）
    loadHooks.loadError = null;
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await expect(renderMermaid("a", "light")).resolves.toEqual({ ok: true, svg: "<svg></svg>" });
  });

  it("沒給 signal 的呼叫（簡報模式）照常 resolve", async () => {
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await expect(renderMermaid("a", "light")).resolves.toEqual({ ok: true, svg: "<svg></svg>" });
  });
});

describe("結果快取（#344 B）", () => {
  const idOf = (svg: string) => /<svg id="([^"]+)"/.exec(svg)![1]!;

  it("同主題同原始碼第二次直接拿快取、不再 render，而且 id 換成新的（同頁兩張不撞 id）", async () => {
    renderMock.mockImplementation(async (id: string) => ({ svg: svgFor(id) }));
    const first = await renderMermaid("graph TD; A-->B;", "light");
    const second = await renderMermaid("graph TD; A-->B;", "light");

    expect(renderMock).toHaveBeenCalledTimes(1);
    const firstId = renderMock.mock.calls[0]![0] as string;
    expect(first).toEqual({ ok: true, svg: svgFor(firstId) });
    expect(second.ok).toBe(true);
    const secondSvg = second.ok ? second.svg : "";
    const secondId = idOf(secondSvg);
    expect(secondId).not.toBe(firstId);
    // 每一處引用（根 id、style 選擇器、marker id、url() 引用）都換掉了
    expect(secondSvg).toBe(svgFor(secondId));
  });

  it("快取命中不排隊：前面有張圖正在畫，命中的照樣立即回來", async () => {
    renderMock.mockResolvedValueOnce({ svg: "<svg>x</svg>" });
    await renderMermaid("x", "light");

    const slow = deferred<{ svg: string }>();
    renderMock.mockImplementationOnce(() => slow.promise);
    const busy = renderMermaid("y", "light");
    await until(() => renderMock.mock.calls.length === 2);

    await expect(renderMermaid("x", "light")).resolves.toEqual({ ok: true, svg: "<svg>x</svg>" });
    slow.resolve({ svg: "<svg>y</svg>" });
    await busy;
  });

  it("同頁兩張相同原始碼同時請求：只 render 一次，第二張拿到換過 id 的副本", async () => {
    renderMock.mockImplementation(async (id: string) => ({ svg: svgFor(id) }));
    const [a, b] = await Promise.all([renderMermaid("same", "light"), renderMermaid("same", "light")]);
    expect(renderMock).toHaveBeenCalledTimes(1);
    const idA = idOf(a.ok ? a.svg : "");
    const idB = idOf(b.ok ? b.svg : "");
    expect(idA).not.toBe(idB);
    expect(b.ok && b.svg).toBe(svgFor(idB));
  });

  it("主題是鍵的一部分：同原始碼換主題要重畫", async () => {
    renderMock.mockResolvedValue({ svg: "<svg></svg>" });
    await renderMermaid("a", "light");
    await renderMermaid("a", "dark");
    expect(renderMock).toHaveBeenCalledTimes(2);
  });

  it("失敗不快取（chunk 載入失敗這類暫時性錯誤之後要能重試成功）", async () => {
    renderMock.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ svg: "<svg></svg>" });
    expect((await renderMermaid("a", "light")).ok).toBe(false);
    expect(await renderMermaid("a", "light")).toEqual({ ok: true, svg: "<svg></svg>" });
    expect(renderMock).toHaveBeenCalledTimes(2);
  });

  it(`LRU：上限 ${MERMAID_CACHE_LIMIT} 筆，最久沒用的先丟，命中會刷新順序`, async () => {
    renderMock.mockImplementation(async (id: string) => ({ svg: svgFor(id) }));
    for (let i = 0; i < MERMAID_CACHE_LIMIT; i++) await renderMermaid(`c${i}`, "light");
    await renderMermaid("c0", "light"); // 命中：c0 變最新，c1 變最舊
    await renderMermaid("fresh", "light"); // 超過上限：丟掉 c1
    expect(renderMock).toHaveBeenCalledTimes(MERMAID_CACHE_LIMIT + 1);

    expect(cachedMermaid("c0", "light")).not.toBeNull();
    expect(cachedMermaid("c1", "light")).toBeNull();
    expect(cachedMermaid("c2", "light")).not.toBeNull();
    expect(cachedMermaid("fresh", "light")).not.toBeNull();
  });

  it("cachedMermaid：沒畫過回 null，空原始碼回 null", () => {
    expect(cachedMermaid("never", "light")).toBeNull();
    expect(cachedMermaid("   ", "light")).toBeNull();
  });
});

describe("rewriteMermaidId", () => {
  it("⚠ 不吃後續數字：換 mermaid-1 不會動到 mermaid-12", () => {
    const svg = `<svg id="mermaid-1"><style>#mermaid-1 .a{}</style><g id="mermaid-12"/><path marker-end="url(#mermaid-1_arrow)"/></svg>`;
    expect(rewriteMermaidId(svg, "mermaid-1", "mermaid-40")).toBe(
      `<svg id="mermaid-40"><style>#mermaid-40 .a{}</style><g id="mermaid-12"/><path marker-end="url(#mermaid-40_arrow)"/></svg>`,
    );
  });

  it("前面緊接英數字的不換（不是這個 id 的引用）；字串開頭與相鄰兩處都換", () => {
    expect(rewriteMermaidId("xmermaid-1 chart-title-mermaid-1", "mermaid-1", "mermaid-2")).toBe("xmermaid-1 chart-title-mermaid-2");
    expect(rewriteMermaidId("mermaid-1 #mermaid-1,#mermaid-1", "mermaid-1", "mermaid-2")).toBe("mermaid-2 #mermaid-2,#mermaid-2");
  });

  it("⚠ 不用 lookbehind（Safari 16.0–16.3 不支援，寫在 new RegExp 字串裡也不會被轉譯）", () => {
    expect(rewriteMermaidId.toString()).not.toMatch(/\(\?<[!=]/);
  });
});

describe("directive 鎖定", () => {
  it("secure 清單鎖住會打開 HTML／CSS 注入面的鍵，且保留 mermaid 內建的六個", async () => {
    // ⚠ 這組鎖**不是**在承諾「圖表不會載入外部資源」——那個能力跟筆記裡用網址嵌入圖片
    // 同一等級，只擋 mermaid 沒有意義（見 `mermaidConfig` 的說明）。鎖它們是為了讓標籤
    // 維持 SVG `<text>`、不讓圖注入任意 CSS。
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
        "fontFamily",
        "altFontFamily",
      ]),
    );
    // ⚠ **不該**鎖的兩個：sanitize 會遞迴，巢狀鍵已被涵蓋；鎖整個物件只會讓
    // `flowchart.curve` 與官方文件教的 `theme:"base"` ＋ 自訂色靜默失效（實測）。
    expect(config.secure).not.toContain("flowchart");
    expect(config.secure).not.toContain("themeVariables");
  });
});
