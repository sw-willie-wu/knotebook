import type { QueryClient } from "@tanstack/react-query";
import type { AiActionDto } from "@knotebook/shared";
import { fetchAiActions } from "@/api/ai";
import { unionRect, type Rect } from "./geometry";
import { buildSequence } from "./sequence";
import { FULL_TOUR, prepareStop, STOPS, stopTarget, type StopContext, type StopDef } from "./stops";

/**
 * 功能導覽的引擎：站序、換站、等目標、結束後找回焦點。不碰 React，畫面與導頁由 `TourRunner` 處理。
 */

/** 進站後等目標出現（而且有尺寸）的上限；等不到就跳過這一站。 */
export const TARGET_TIMEOUT_MS = 3000;
/** 結束後找使用者選單觸發鈕的上限；導回原頁後新的側欄要一兩格畫面才掛上。 */
export const RETURN_FOCUS_TIMEOUT_MS = 1000;

export interface TourStartOptions {
  /** 結束後要回到的位置（路徑＋search＋hash）。由打開導覽的地方傳入：打開當下的位置。 */
  returnTo: string;
  /**
   * 結束後要聚焦的元素的查找函式，不是元素本身：從首頁打開時那份側欄會隨導頁卸載、
   * 窄視窗的觸發鈕在已經關掉的抽屜裡，開始時記下的元素到結束時多半已經不在了。
   */
  returnFocus: () => Element | null;
}

export interface TourStopEntry {
  stop: StopDef;
}

/** 完整導覽要走的站。 */
export function fullTourStops(): TourStopEntry[] {
  return buildSequence(FULL_TOUR).map((e) => ({ stop: STOPS[e.id] }));
}

/** 開始時算一次前置條件：不成立的站整站拿掉，總站數只算留下的，中途不會跳號。 */
export function planStops(entries: readonly TourStopEntry[], ctx: StopContext): TourStopEntry[] {
  return entries.filter((e) => e.stop.precondition?.(ctx) ?? true);
}

/**
 * 向 server 讀一次 AI 動作（與 AI 工具列共用 `["ai-actions"]` 這個查詢）。`staleTime: 0` 讓快取裡已經有的資料也重抓：
 * 從首頁打開時快取可能還沒有資料或是舊的。讀取失敗當成沒有 AI；不重試，失敗時不讓使用者多等。
 */
export function fetchTourAiActions(queryClient: QueryClient): Promise<AiActionDto[]> {
  return queryClient
    .fetchQuery({ queryKey: ["ai-actions"], queryFn: fetchAiActions, staleTime: 0, retry: false })
    .catch(() => []);
}

/** 全部元素都有寬高才回它們的聯集；只挖亮其中一部分會讓說明對不上。 */
export function measureTargets(els: readonly Element[]): Rect | null {
  if (els.length === 0) return null;
  const rects = els.map((el) => el.getBoundingClientRect());
  if (rects.some((r) => r.width <= 0 || r.height <= 0)) return null;
  return unionRect(rects.map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height })));
}

/**
 * 每格畫面呼叫 `check`，回非 null 就 resolve 那個值；超過 `timeoutMs` 或中止就 resolve null。
 * 第一次在呼叫當下就查。`check` 拋錯當成還沒好。
 */
export function waitForFrames<T>(check: () => T | null, signal: AbortSignal, timeoutMs = Infinity): Promise<T | null> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: T | null) => {
      cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(null);
    const tick = () => {
      let value: T | null = null;
      try {
        value = check();
      } catch {
        value = null;
      }
      if (value !== null) finish(value);
      else frame = requestAnimationFrame(tick);
    };
    signal.addEventListener("abort", onAbort);
    if (Number.isFinite(timeoutMs)) timer = setTimeout(() => finish(null), timeoutMs);
    tick();
  });
}

/**
 * 等側欄抽屜從 DOM 消失。抽屜是會鎖焦點、把外面標成 `aria-hidden` 的 modal：開著時導覽卡片按不到，
 * 要指的目標也全都查不到。沒有上限：開始流程整體的逾時由呼叫端處理。
 */
export async function waitForDrawerClosed(signal: AbortSignal): Promise<void> {
  await waitForFrames(() => (document.querySelector("[data-sidebar-drawer]") === null ? true : null), signal);
}

/** 路徑比對：瀏覽器的 pathname 對非 ASCII 的 slug 是百分比編碼形，`canonicalNotePath` 回的是未編碼的字。 */
export function samePath(pathname: string, path: string): boolean {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // 畸形的 % 序列：照原字串比。
  }
  return decoded === path;
}

function interactive(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && el.isConnected && el.closest('[aria-hidden="true"], [inert]') === null;
}

/**
 * 結束後的焦點：每格畫面呼叫一次 `returnFocus()`，查到還掛在 DOM 上的元素就聚焦它（最多 `RETURN_FOCUS_TIMEOUT_MS`）；
 * 查不到退到筆記標題框，再退到主內容區（`<main>` 本來不能聚焦，補 `tabindex="-1"`）。回傳聚焦的元素。
 */
export async function focusReturnTarget(returnFocus: () => Element | null, signal: AbortSignal): Promise<HTMLElement | null> {
  const found = await waitForFrames(() => {
    const el = returnFocus();
    return interactive(el) ? el : null;
  }, signal, RETURN_FOCUS_TIMEOUT_MS);
  if (signal.aborted) return null;
  const target =
    found ??
    Array.from(document.querySelectorAll("input[data-note-title-input]")).find(interactive) ??
    Array.from(document.querySelectorAll("main")).find(interactive) ??
    null;
  if (target === null) return null;
  if (target.tagName === "MAIN" && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus();
  return target;
}

function runLeave(entry: TourStopEntry, ctx: StopContext): void {
  try {
    entry.stop.leave?.(ctx);
  } catch (err) {
    console.error(err);
  }
}

function runPrepare(entry: TourStopEntry, ctx: StopContext): void {
  try {
    prepareStop(entry.stop, ctx);
  } catch (err) {
    console.error(err);
  }
}

/** 等這一站的目標出現而且有尺寸，最多 `TARGET_TIMEOUT_MS`。目標每格畫面重查（prepare 切 tab 之後要下一格才畫出來）。 */
export async function waitForStopTarget(entry: TourStopEntry, ctx: StopContext, signal: AbortSignal): Promise<boolean> {
  return (await waitForFrames(() => measureTargets(stopTarget(entry.stop, ctx)), signal, TARGET_TIMEOUT_MS)) !== null;
}

export type EndReason =
  /** 最後一站〔保留示範筆記〕。 */
  | "keep"
  /** 最後一站〔刪除〕。 */
  | "delete"
  /** ✕、Esc、第 1 站的「跳過」。 */
  | "close"
  /** 位置離開了示範筆記（上一頁、重新整理、被導到登入頁、筆記在別處被刪）。 */
  | "left"
  /** 導覽元件卸載。 */
  | "unmount";

export interface EngineSnapshot {
  phase: "idle" | "running" | "ended";
  /** 畫面上那一站在站序裡的位置；還沒進第一站是 -1。 */
  index: number;
  total: number;
  /** 畫面上那一站；換站等目標的期間仍是上一站。 */
  entry: TourStopEntry | null;
  /** 正在換站（等下一站的目標）：這段期間的下一步、上一步不動作。 */
  pending: boolean;
  endReason: EndReason | null;
}

export type WaitForTarget = (entry: TourStopEntry, ctx: StopContext, signal: AbortSignal) => Promise<boolean>;

/**
 * 導覽的狀態機。站序在建立時就定好（`planStops` 濾過）；`ctx` 也是開始時那一份。
 *
 * - 進站：先 `prepare`，再等目標（`waitForTarget`），等到才算進站；等不到就往同一個方向跳下一站。
 *   往回走一路都等不到，就從原本那站往後找。最後一站不跳：它帶著〔保留示範筆記〕〔刪除〕，等不到目標也照樣進站（卡片置中）。
 * - 離站：先呼叫畫面上那站的 `leave`，再 `prepare` 下一站——演示站開的選單要先收掉，下一站才開得了自己的。
 *   開始進一站（呼叫 `prepareStop`）就一定會再呼叫一次 `leave`，跳過的、等目標等到一半就結束的也一樣。
 *   窄視窗下 `prepareStop` 不跑站點的 `prepare`，`leave` 仍會被呼叫，所以站點的 `leave` 要能在 `prepare` 沒跑過時安全執行。
 */
export class TourEngine {
  private snapshot: EngineSnapshot;
  private readonly listeners = new Set<() => void>();
  /** 每次換站或結束都加一：換站等目標時被結束打斷，等到的結果就不算數。 */
  private generation = 0;
  private waiting: AbortController | null = null;
  /** 畫面上、還沒呼叫過 `leave` 的那一站。 */
  private shown: TourStopEntry | null = null;

  constructor(
    private readonly stops: readonly TourStopEntry[],
    private readonly ctx: StopContext,
    private readonly waitForTarget: WaitForTarget = waitForStopTarget,
  ) {
    this.snapshot = { phase: "idle", index: -1, total: stops.length, entry: null, pending: false, endReason: null };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): EngineSnapshot => this.snapshot;

  private set(patch: Partial<EngineSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** 進第一站。 */
  begin(): Promise<void> {
    if (this.snapshot.phase !== "idle") return Promise.resolve();
    if (this.stops.length === 0) {
      this.end("close");
      return Promise.resolve();
    }
    this.set({ phase: "running" });
    return this.seek(0, 1, 0);
  }

  next(): void {
    const { phase, pending, index, total } = this.snapshot;
    if (phase !== "running" || pending || index < 0 || index >= total - 1) return;
    void this.seek(index + 1, 1, index);
  }

  back(): void {
    const { phase, pending, index } = this.snapshot;
    if (phase !== "running" || pending || index <= 0) return;
    void this.seek(index - 1, -1, index);
  }

  end(reason: EndReason): void {
    if (this.snapshot.phase === "ended") return;
    this.generation += 1;
    this.waiting?.abort();
    this.waiting = null;
    this.leaveShown();
    this.set({ phase: "ended", pending: false, endReason: reason });
  }

  private leaveShown(): void {
    const shown = this.shown;
    this.shown = null;
    if (shown !== null) runLeave(shown, this.ctx);
  }

  private async seek(start: number, direction: 1 | -1, from: number): Promise<void> {
    const generation = ++this.generation;
    const waiting = new AbortController();
    this.waiting = waiting;
    this.leaveShown();
    this.set({ pending: true });
    let i = start;
    let dir = direction;
    for (;;) {
      if (i < 0) {
        i = from;
        dir = 1;
      }
      const entry = this.stops[i]!;
      runPrepare(entry, this.ctx);
      const found = await this.waitForTarget(entry, this.ctx, waiting.signal);
      if (generation !== this.generation) {
        runLeave(entry, this.ctx);
        return;
      }
      if (found || i === this.stops.length - 1) {
        this.waiting = null;
        this.shown = entry;
        this.set({ index: i, entry, pending: false });
        return;
      }
      runLeave(entry, this.ctx);
      i += dir;
    }
  }
}
