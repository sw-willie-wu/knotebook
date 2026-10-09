import { vi } from "vitest";

/**
 * #229 元件測試用的瀏覽器形全螢幕假實作，裝在 jsdom 真 document 上（jsdom 沒有 Fullscreen API）。
 * - requestFullscreen／exitFullscreen 回**未決**的 Promise，由測試決定何時、以何種順序完成；
 * - fullscreenElement 由這裡控制、晚於呼叫才變；fullscreenchange 由這裡派送。
 * - performance.now 換成可控時鐘（每次安裝往前跳 100 萬毫秒），測試用 advance() 推進。
 * 用完一定要 `await fake.uninstall()`（afterEach）：把未決請求 reject，並**在時鐘 0 派一次「離開」**——
 *   present/fullscreen.ts 的 owned／exitWanted 歸 false、lastExitAt 歸 0（＝從未離開，msSinceFullscreenExit() 回 Infinity）。
 *   不歸 0 的話，模組會留著百萬級的假時間，下一案若**沒裝**假全螢幕，真時鐘減它是負數 < 300，Esc 全被防連退吃掉（gate r1-p2 M1 實跑）。
 */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

interface Deferred {
  resolve: () => void;
  reject: (err: unknown) => void;
}

export interface FakeFullscreen {
  readonly requestFullscreen: ReturnType<typeof vi.fn>;
  readonly exitFullscreen: ReturnType<typeof vi.fn>;
  /** 規範順序：先 fullscreenchange、後 resolve。 */
  grantEventFirst(): Promise<void>;
  /** 先 resolve、後 fullscreenchange。 */
  grantResolveFirst(): Promise<void>;
  deny(): Promise<void>;
  /** 完成最早一個 exitFullscreen：清 element、派事件、resolve。 */
  completeExit(): Promise<void>;
  /** 瀏覽器自己退出（例如 Esc 被瀏覽器吃掉）：清 element、派事件。 */
  userExit(): Promise<void>;
  advance(ms: number): void;
  uninstall(): Promise<void>;
}

let clockBase = 1_000_000;

export function installFakeFullscreen({ enabled = true }: { enabled?: boolean } = {}): FakeFullscreen {
  clockBase += 1_000_000;
  let now = clockBase;
  const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
  let element: Element | null = null;
  let request: Deferred | null = null;
  const exits: Deferred[] = [];
  const fire = () => document.dispatchEvent(new Event("fullscreenchange"));

  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => enabled });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });
  const requestFullscreen = vi.fn(() => new Promise<void>((resolve, reject) => { request = { resolve, reject }; }));
  const exitFullscreen = vi.fn(() => new Promise<void>((resolve, reject) => { exits.push({ resolve, reject }); }));
  Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: requestFullscreen });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });

  return {
    requestFullscreen,
    exitFullscreen,
    async grantEventFirst() {
      element = document.documentElement;
      fire();
      request?.resolve();
      request = null;
      await flushMicrotasks();
    },
    async grantResolveFirst() {
      element = document.documentElement;
      request?.resolve();
      request = null;
      await flushMicrotasks();
      fire();
      await flushMicrotasks();
    },
    async deny() {
      request?.reject(new TypeError("denied"));
      request = null;
      await flushMicrotasks();
    },
    async completeExit() {
      element = null;
      fire();
      exits.shift()?.resolve();
      await flushMicrotasks();
    },
    async userExit() {
      element = null;
      fire();
      await flushMicrotasks();
    },
    advance(ms: number) {
      now += ms;
    },
    async uninstall() {
      request?.reject(new TypeError("uninstalled"));
      request = null;
      await flushMicrotasks();
      element = null;
      now = 0; // 讓模組記下的 lastExitAt 為 0（見檔頭）
      fire();
      while (exits.length > 0) exits.shift()?.resolve();
      await flushMicrotasks();
      delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
      delete (document as unknown as Record<string, unknown>).fullscreenElement;
      delete (document as unknown as Record<string, unknown>).exitFullscreen;
      delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
      nowSpy.mockRestore();
    },
  };
}
