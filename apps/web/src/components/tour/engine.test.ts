import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { AiActionDto } from "@knotebook/shared";
import { NARROW_QUERY } from "@/lib/sidebar-drawer";
import {
  fetchTourAiActions,
  focusReturnTarget,
  fullTourStops,
  measureTargets,
  planStops,
  RETURN_FOCUS_TIMEOUT_MS,
  samePath,
  TARGET_TIMEOUT_MS,
  TourEngine,
  waitForDrawerClosed,
  type TourStopEntry,
} from "./engine";
import { buildSequence } from "./sequence";
import { FULL_TOUR, STOPS, type StopContext, type StopDef, type StopId } from "./stops";

const CTX: StopContext = { searchQuery: "", aiActions: [], sampleNoteId: "n1", liveStops: false };
const AI_ACTION: AiActionDto = { id: "rewrite", name: "Rewrite", applyMode: "preview", kind: "quick" };

/** 一個有尺寸的目標元素；`visible=false` 時寬高是 0（＝還沒出現）。 */
function targetEl(visible = true): HTMLElement & { show: () => void } {
  let shown = visible;
  const el = Object.assign(document.createElement("button"), {
    show: () => {
      shown = true;
    },
  });
  el.getBoundingClientRect = () => (shown ? new DOMRect(10, 20, 30, 40) : new DOMRect(0, 0, 0, 0));
  document.body.append(el);
  return el;
}

interface FakeStop {
  entry: TourStopEntry;
  prepare: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  el: ReturnType<typeof targetEl> | null;
}

/** 假站點：`present=false` 的站目標一直是 0 尺寸（等不到）；`missing=true` 的站根本查不到元素。 */
function fakeStop(name: string, opts: { present?: boolean; missing?: boolean; precondition?: (ctx: StopContext) => boolean } = {}): FakeStop {
  const el = opts.missing ? null : targetEl(opts.present ?? true);
  const prepare = vi.fn();
  const leave = vi.fn();
  const stop: StopDef = {
    id: name as StopId,
    titleKey: `t.${name}`,
    bodyKey: `b.${name}`,
    target: () => (el === null ? [] : [el]),
    prepare,
    leave,
    precondition: opts.precondition,
  };
  return { entry: { stop }, prepare, leave, el };
}

function engineOf(stops: FakeStop[], ctx: StopContext = CTX): TourEngine {
  return new TourEngine(
    stops.map((s) => s.entry),
    ctx,
  );
}

const ids = (engine: TourEngine) => engine.getSnapshot().entry?.stop.id;

/** 讓 rAF 輪詢與 promise 都跑完一輪。 */
async function frames(ms = 50): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function stubViewport(narrow: boolean) {
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("濾站與總站數", () => {
  it("前置條件不成立的站在開始時拿掉，總站數只算留下的；前置條件讀開始時給的情境", () => {
    const seen: StopContext[] = [];
    const a = fakeStop("a");
    const b = fakeStop("b", { precondition: (ctx) => (seen.push(ctx), ctx.searchQuery === "") });
    const c = fakeStop("c", { precondition: () => true });
    const ctx: StopContext = { searchQuery: "x", aiActions: [], sampleNoteId: "n1", liveStops: false };
    const planned = planStops([a, b, c].map((s) => s.entry), ctx);
    expect(planned.map((e) => e.stop.id)).toEqual(["a", "c"]);
    expect(seen).toEqual([ctx]);
    expect(new TourEngine(planned, ctx).getSnapshot().total).toBe(2);
  });

  it("完整導覽：站點表照 buildSequence 的順序", () => {
    const expected = buildSequence(FULL_TOUR);
    expect(fullTourStops().map((e) => e.stop)).toEqual(expected.map((e) => STOPS[e.id]));
  });

  it("站台沒有 AI 動作：完整導覽少掉 AI 站；有就在 [[ 站與 / 站之間", () => {
    const ids = (aiActions: StopContext["aiActions"]) => planStops(fullTourStops(), { ...CTX, aiActions }).map((e) => e.stop.id);
    expect(ids([])).not.toContain("ai");
    const withAi = ids([{ id: "rewrite", name: "Rewrite", applyMode: "preview", kind: "quick" }]);
    expect(withAi.slice(withAi.indexOf("wikilink"), withAi.indexOf("slash") + 1)).toEqual(["wikilink", "ai", "slash"]);
  });

  it("搜尋框有字：完整導覽少掉 tab 列、資料夾、搜尋三站", () => {
    const planned = planStops(fullTourStops(), { ...CTX, searchQuery: "ab" });
    expect(planned.map((e) => e.stop.id)).toEqual(["newNote", "header", "versions", "wikilink", "slash", "userMenu"]);
  });
});

describe("站序與換站", () => {
  it("begin 進第一站：先跑 prepare、等到目標才算進站；之前沒有畫面上的站", async () => {
    const a = fakeStop("a", { present: false });
    const engine = engineOf([a, fakeStop("b")]);
    void engine.begin();
    expect(engine.getSnapshot()).toMatchObject({ phase: "running", entry: null, pending: true, index: -1 });
    expect(a.prepare).toHaveBeenCalledTimes(1);
    a.el!.show();
    await frames();
    expect(engine.getSnapshot()).toMatchObject({ phase: "running", index: 0, total: 2, pending: false });
    expect(ids(engine)).toBe("a");
  });

  it("下一步、上一步；第一站不能再往前、最後一站不能再往後", async () => {
    const engine = engineOf([fakeStop("a"), fakeStop("b"), fakeStop("c")]);
    await engine.begin();
    engine.back();
    await frames();
    expect(ids(engine)).toBe("a");
    engine.next();
    await frames();
    expect(ids(engine)).toBe("b");
    engine.next();
    await frames();
    expect(ids(engine)).toBe("c");
    engine.next();
    await frames();
    expect(ids(engine)).toBe("c");
    engine.back();
    await frames();
    expect(ids(engine)).toBe("b");
  });

  it("換站中（還在等目標）再按下一步不動作", async () => {
    const b = fakeStop("b", { present: false });
    const c = fakeStop("c");
    const engine = engineOf([fakeStop("a"), b, c]);
    await engine.begin();
    engine.next();
    expect(engine.getSnapshot().pending).toBe(true);
    engine.next();
    engine.back();
    b.el!.show();
    await frames();
    expect(ids(engine)).toBe("b");
    expect(c.prepare).not.toHaveBeenCalled();
  });

  it("窄視窗不跑 prepare，仍照常進站", async () => {
    stubViewport(true);
    const a = fakeStop("a");
    const engine = engineOf([a, fakeStop("b")]);
    await engine.begin();
    expect(ids(engine)).toBe("a");
    expect(a.prepare).not.toHaveBeenCalled();
  });

  it("prepare 拋錯只記 console，照樣等目標、進站", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = fakeStop("a");
    a.prepare.mockImplementation(() => {
      throw new Error("boom");
    });
    const engine = engineOf([a, fakeStop("b")]);
    await engine.begin();
    expect(ids(engine)).toBe("a");
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("等不到目標就跳站", () => {
  it(`目標 ${TARGET_TIMEOUT_MS} ms 內沒出現（尺寸一直是 0）→ 跳到下一站；差 1 ms 時還在等`, async () => {
    const b = fakeStop("b", { present: false });
    const engine = engineOf([fakeStop("a"), b, fakeStop("c")]);
    await engine.begin();
    engine.next();
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS - 1);
    expect(engine.getSnapshot()).toMatchObject({ index: 0, pending: true });
    await vi.advanceTimersByTimeAsync(1);
    await frames();
    expect(engine.getSnapshot()).toMatchObject({ index: 2, pending: false });
    expect(ids(engine)).toBe("c");
  });

  it("查不到元素也一樣跳", async () => {
    const engine = engineOf([fakeStop("a"), fakeStop("b", { missing: true }), fakeStop("c")]);
    await engine.begin();
    engine.next();
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS + 50);
    expect(ids(engine)).toBe("c");
  });

  it("等待中途出現就進那一站（每格畫面重查，不是只查一次）", async () => {
    const b = fakeStop("b", { present: false });
    const engine = engineOf([fakeStop("a"), b, fakeStop("c")]);
    await engine.begin();
    engine.next();
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS - 500);
    b.el!.show();
    await frames();
    expect(ids(engine)).toBe("b");
  });

  it("第一站等不到也跳", async () => {
    const engine = engineOf([fakeStop("a", { present: false }), fakeStop("b")]);
    void engine.begin();
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS + 50);
    expect(ids(engine)).toBe("b");
    expect(engine.getSnapshot().index).toBe(1);
  });

  it("最後一站等不到不跳（它帶著結束的選擇）：照樣進站、卡片置中", async () => {
    const last = fakeStop("z", { present: false });
    const engine = engineOf([fakeStop("a"), last]);
    await engine.begin();
    engine.next();
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS + 50);
    expect(engine.getSnapshot()).toMatchObject({ index: 1, pending: false });
    expect(last.leave).not.toHaveBeenCalled();
  });
});

describe("往回走也跳站", () => {
  it("上一站等不到 → 再往前一站", async () => {
    const b = fakeStop("b");
    const engine = engineOf([fakeStop("a"), b, fakeStop("c")]);
    await engine.begin();
    engine.next();
    await frames();
    engine.next();
    await frames();
    expect(ids(engine)).toBe("c");
    b.el!.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    engine.back();
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS + 50);
    expect(ids(engine)).toBe("a");
    expect(engine.getSnapshot().index).toBe(0);
  });

  it("前面都等不到 → 回到原本那站（不卡在換站中）", async () => {
    const a = fakeStop("a");
    const engine = engineOf([a, fakeStop("b"), fakeStop("c")]);
    await engine.begin();
    engine.next();
    await frames();
    a.el!.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    engine.back();
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS + 50);
    expect(engine.getSnapshot()).toMatchObject({ index: 1, pending: false });
  });
});

describe("每次離站 leave 恰一次", () => {
  it("下一步、上一步、結束：離開的那站各一次；還在畫面上的站不呼叫", async () => {
    const [a, b, c] = [fakeStop("a"), fakeStop("b"), fakeStop("c")];
    const engine = engineOf([a, b, c]);
    await engine.begin();
    expect(a.leave).not.toHaveBeenCalled();
    engine.next();
    await frames();
    expect([a.leave.mock.calls.length, b.leave.mock.calls.length]).toEqual([1, 0]);
    engine.back();
    await frames();
    expect([a.leave.mock.calls.length, b.leave.mock.calls.length]).toEqual([1, 1]);
    engine.end("close");
    expect([a.leave.mock.calls.length, b.leave.mock.calls.length, c.leave.mock.calls.length]).toEqual([2, 1, 0]);
    expect(a.leave).toHaveBeenCalledWith(CTX);
  });

  it("離站先呼叫 leave、再 prepare 下一站（演示站的選單要先收掉）", async () => {
    const order: string[] = [];
    const [a, b] = [fakeStop("a"), fakeStop("b")];
    a.leave.mockImplementation(() => order.push("leave a"));
    b.prepare.mockImplementation(() => order.push("prepare b"));
    const engine = engineOf([a, b]);
    await engine.begin();
    engine.next();
    await frames();
    expect(order).toEqual(["leave a", "prepare b"]);
  });

  it.each(["keep", "delete", "close", "left", "unmount"] as const)("結束（%s）：畫面上那站一次；再結束不重複", async (reason) => {
    const [a, b] = [fakeStop("a"), fakeStop("b")];
    const engine = engineOf([a, b]);
    await engine.begin();
    engine.end(reason);
    engine.end("close");
    expect(a.leave).toHaveBeenCalledTimes(1);
    expect(engine.getSnapshot()).toMatchObject({ phase: "ended", endReason: reason });
  });

  it("跳過的站（跑過 prepare、等不到目標）也呼叫一次", async () => {
    const [a, b, c] = [fakeStop("a"), fakeStop("b", { present: false }), fakeStop("c")];
    const engine = engineOf([a, b, c]);
    await engine.begin();
    engine.next();
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS + 50);
    expect(ids(engine)).toBe("c");
    expect([a.leave.mock.calls.length, b.leave.mock.calls.length, c.leave.mock.calls.length]).toEqual([1, 1, 0]);
  });

  it("等目標時結束：等待中的那站（已 prepare）一次；之後不會再進站", async () => {
    const [a, b] = [fakeStop("a"), fakeStop("b", { present: false })];
    const engine = engineOf([a, b, fakeStop("c")]);
    await engine.begin();
    engine.next();
    await frames();
    engine.end("close");
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS + 50);
    expect([a.leave.mock.calls.length, b.leave.mock.calls.length]).toEqual([1, 1]);
    expect(engine.getSnapshot()).toMatchObject({ phase: "ended", index: 0 });
  });

  it("leave 拋錯只記 console，照樣換站", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const [a, b] = [fakeStop("a"), fakeStop("b")];
    a.leave.mockImplementation(() => {
      throw new Error("boom");
    });
    const engine = engineOf([a, b]);
    await engine.begin();
    engine.next();
    await frames();
    expect(ids(engine)).toBe("b");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("還沒進第一站就結束：第一站（已 prepare）一次", async () => {
    const a = fakeStop("a", { present: false });
    const engine = engineOf([a, fakeStop("b")]);
    void engine.begin();
    engine.end("unmount");
    await frames();
    expect(a.leave).toHaveBeenCalledTimes(1);
  });
});

describe("訂閱", () => {
  it("每次狀態改變通知一次；快照是新物件、舊快照不被改", async () => {
    const engine = engineOf([fakeStop("a"), fakeStop("b")]);
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);
    const before = engine.getSnapshot();
    await engine.begin();
    expect(listener).toHaveBeenCalled();
    expect(before).toMatchObject({ phase: "idle", index: -1 });
    unsubscribe();
    listener.mockClear();
    engine.next();
    await frames();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("開始時向 server 讀 AI 動作", () => {
  it("快取裡是空陣列、server 回非空 → 用 server 的結果（查詢的預設 staleTime 再長也重抓）", async () => {
    vi.useRealTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(["ai-actions"], []);
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ actions: [AI_ACTION] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchTourAiActions(qc)).resolves.toEqual([AI_ACTION]);
    expect(urls).toEqual(["/api/ai/actions"]);
    expect(qc.getQueryData(["ai-actions"])).toEqual([AI_ACTION]);
  });

  it("讀取失敗 → 空陣列，不拋錯；查詢預設會重試也不重試", async () => {
    vi.useRealTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 0 } } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "internal", message: "x" } }), { status: 500, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchTourAiActions(qc)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("measureTargets", () => {
  it("全部有尺寸才回聯集；有一個是 0 或沒有元素回 null", () => {
    const a = document.createElement("div");
    a.getBoundingClientRect = () => new DOMRect(10, 10, 20, 20);
    const b = document.createElement("div");
    b.getBoundingClientRect = () => new DOMRect(50, 5, 10, 10);
    expect(measureTargets([a, b])).toEqual({ left: 10, top: 5, width: 50, height: 25 });
    const flat = document.createElement("div");
    flat.getBoundingClientRect = () => new DOMRect(10, 10, 20, 0);
    expect(measureTargets([a, flat])).toBeNull();
    expect(measureTargets([])).toBeNull();
  });
});

describe("waitForDrawerClosed", () => {
  it("抽屜元素還在就一直等，消失的那一格才 resolve", async () => {
    const drawer = document.createElement("div");
    drawer.setAttribute("data-sidebar-drawer", "");
    document.body.append(drawer);
    const done = vi.fn();
    void waitForDrawerClosed(new AbortController().signal).then(done);
    await vi.advanceTimersByTimeAsync(5000);
    expect(done).not.toHaveBeenCalled();
    drawer.remove();
    await frames();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("本來就沒有抽屜 → 馬上 resolve", async () => {
    const done = vi.fn();
    void waitForDrawerClosed(new AbortController().signal).then(done);
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe("samePath", () => {
  it("瀏覽器的 pathname 對非 ASCII slug 是百分比編碼形，比對前先 decode", () => {
    expect(samePath("/n/alice/%E6%AD%A1%E8%BF%8E", "/n/alice/歡迎")).toBe(true);
    expect(samePath("/n/alice/歡迎", "/n/alice/歡迎")).toBe(true);
    expect(samePath("/n/alice/other", "/n/alice/歡迎")).toBe(false);
    expect(samePath("/login", "/n/alice/歡迎")).toBe(false);
  });

  it("畸形的 % 序列不拋錯、照原字串比", () => {
    expect(samePath("/n/alice/%E6", "/n/alice/%E6")).toBe(true);
    expect(samePath("/n/alice/%E6", "/n/alice/x")).toBe(false);
  });
});

describe("focusReturnTarget", () => {
  function button(label: string): HTMLButtonElement {
    const el = document.createElement("button");
    el.textContent = label;
    document.body.append(el);
    return el;
  }

  it("查找函式每格畫面都重查，查到（而且還掛在 DOM 上）就聚焦它", async () => {
    let found: Element | null = null;
    const lookup = vi.fn(() => found);
    const done = focusReturnTarget(lookup, new AbortController().signal);
    await frames(100);
    const calls = lookup.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    const account = button("Ann");
    found = account;
    await frames();
    await expect(done).resolves.toBe(account);
    expect(document.activeElement).toBe(account);
  });

  it("查到的元素已經不在 DOM 上 → 不算，繼續查", async () => {
    const stale = document.createElement("button");
    let found: Element = stale;
    const done = focusReturnTarget(() => found, new AbortController().signal);
    await frames(100);
    const fresh = button("Ann");
    found = fresh;
    await frames();
    await expect(done).resolves.toBe(fresh);
    expect(document.activeElement).toBe(fresh);
  });

  it(`查找函式一直回 null → ${RETURN_FOCUS_TIMEOUT_MS} ms 後退到筆記標題框`, async () => {
    const title = document.createElement("input");
    title.setAttribute("data-note-title-input", "");
    document.body.append(title);
    const main = document.createElement("main");
    document.body.append(main);
    const done = vi.fn();
    void focusReturnTarget(() => null, new AbortController().signal).then(done);
    await vi.advanceTimersByTimeAsync(RETURN_FOCUS_TIMEOUT_MS - 50);
    expect(done).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toHaveBeenCalledWith(title);
    expect(document.activeElement).toBe(title);
  });

  it("沒有標題框 → 主內容區（本來不能聚焦，補 tabindex=-1）", async () => {
    const main = document.createElement("main");
    document.body.append(main);
    const done = focusReturnTarget(() => null, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(RETURN_FOCUS_TIMEOUT_MS + 50);
    await expect(done).resolves.toBe(main);
    expect(document.activeElement).toBe(main);
    expect(main.getAttribute("tabindex")).toBe("-1");
  });

  it("標題框在 inert 範圍內（背景不可互動）不算", async () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("inert", "");
    const title = document.createElement("input");
    title.setAttribute("data-note-title-input", "");
    wrapper.append(title);
    const main = document.createElement("main");
    document.body.append(wrapper, main);
    const done = focusReturnTarget(() => null, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(RETURN_FOCUS_TIMEOUT_MS + 50);
    await expect(done).resolves.toBe(main);
  });

  it("中止 → 不聚焦任何東西", async () => {
    const account = button("Ann");
    const ac = new AbortController();
    ac.abort();
    await expect(focusReturnTarget(() => account, ac.signal)).resolves.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
