// 未 mount 的 collaborative editor 是空文件（by-id 操作 throw），所以每個 session 都要 mount 進 jsdom；
// mount 過的 editor 即使 unmount 也殘留約 0.53 MB/顆、GC 收不回（spike）。對策：每 N 次 mount 或 heap
// 較基線 +64 MiB 就重建 window——只在 in-flight 歸零時重建，旗標一設下新 session 就排隊等。這道防線
// 壓不住（單顆行程的常駐量仍漲）時的退路是把整個 runtime 搬進 worker_threads，讓行程可整個換掉。
// ⚠ `acquire()` 不可重入：持有 lease 期間不得再 `acquire()`／`EditorSession.open()`。重建旗標一設下，
// 內層的 `acquire()` 會等 in-flight 歸零，而外層要等內層回來才會 `release()` → 死鎖，症狀是無訊息逾時。
// 寫入路徑的作法見 `apply.ts` 的 `prepareEdit`（取完 diff 立刻 close，之後才合併、記錄、更新索引）。
// jsdom 的 url ＝ `PUBLIC_URL` 的 origin ＋ "/"，因為 schema 的媒體守衛會拿它當相對網址的 base。
// ⚠ 掛上 window/document 之後，靠 `typeof window !== "undefined"` 判斷環境的套件會誤判成瀏覽器：
// `@anthropic-ai/sdk` 就是（editing-runtime.test.ts 釘住嗅探與旗標）；yjs／hocuspocus 一族靠 lib0
// 的 `!isNode` 守著、installGlobals() 後仍正常（editing-session.test.ts 整檔都在其後操作 yjs）。
import { JSDOM } from "jsdom";
import type { AppConfig } from "../../config.js";
import { publicUrlIssuer } from "../../config.js";

export interface EditingRuntimeOptions {
  baseUrl: string;
  rebuildEvery?: number;
  heapGrowthLimit?: number;
  readHeapUsed?: () => number;
}
export interface SessionLease {
  release(): void;
}

const DEFAULT_REBUILD_EVERY = 50;
const DEFAULT_HEAP_LIMIT = 64 * 1024 * 1024;
/** 只掛 BlockNote／ProseMirror mount 需要的全域；不掛 navigator（Node ≥ 21 的 getter-only 內建，
 * 覆寫會讓環境嗅探拿到瀏覽器值）。 */
const GLOBAL_KEYS = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "Range",
  "DOMRect",
  "MutationObserver",
  "getComputedStyle",
  "DocumentFragment",
  "Text",
  "DOMParser",
  "XMLSerializer",
] as const;

export class EditingRuntime {
  readonly baseUrl: string;
  private readonly rebuildEvery: number;
  private readonly heapGrowthLimit: number;
  private readonly readHeapUsed: () => number;
  private dom: JSDOM | null = null;
  private heapBaseline = 0;
  private mountsSinceRebuild = 0;
  private inFlightCount = 0;
  private pending = false;
  private waiters: Array<() => void> = [];
  private rebuildCount = 0;
  private mountCount = 0;

  constructor(opts: EditingRuntimeOptions) {
    this.baseUrl = opts.baseUrl;
    this.rebuildEvery = opts.rebuildEvery ?? DEFAULT_REBUILD_EVERY;
    this.heapGrowthLimit = opts.heapGrowthLimit ?? DEFAULT_HEAP_LIMIT;
    this.readHeapUsed = opts.readHeapUsed ?? (() => process.memoryUsage().heapUsed);
  }

  get inFlight(): number {
    return this.inFlightCount;
  }
  get rebuildPending(): boolean {
    return this.pending;
  }
  get rebuilds(): number {
    return this.rebuildCount;
  }
  get mounts(): number {
    return this.mountCount;
  }

  installGlobals(): void {
    this.dom?.window.close();
    const dom = new JSDOM("", { url: this.baseUrl });
    this.dom = dom;
    const w = dom.window as unknown as Record<string, unknown>;
    for (const key of GLOBAL_KEYS) {
      Object.defineProperty(globalThis, key, { value: w[key], configurable: true, writable: true, enumerable: false });
    }
    // 同 apps/web/src/test/setup.ts 的三個 rect polyfill：ProseMirror 量幾何時會叫。
    const rect = (): DOMRect => new dom.window.DOMRect(0, 0, 0, 0);
    dom.window.Element.prototype.getBoundingClientRect = rect;
    dom.window.Range.prototype.getBoundingClientRect = rect;
    dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    this.heapBaseline = this.readHeapUsed();
    this.mountsSinceRebuild = 0;
  }

  async acquire(): Promise<SessionLease> {
    while (this.pending) await new Promise<void>(resolve => this.waiters.push(resolve));
    this.inFlightCount += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.inFlightCount -= 1;
        this.maybeRebuild();
      },
    };
  }

  noteMount(): void {
    this.mountCount += 1;
    this.mountsSinceRebuild += 1;
    if (this.mountsSinceRebuild >= this.rebuildEvery || this.readHeapUsed() - this.heapBaseline > this.heapGrowthLimit) this.pending = true;
  }

  private maybeRebuild(): void {
    if (!this.pending || this.inFlightCount > 0) return;
    // installGlobals() 若 throw（m3）：pending 與 waiters 一定要在 finally 放掉，否則所有排隊中
    // 與之後的 acquire() 永遠不會 settle（整台 server 的 AI 編輯靜默停擺）。錯誤不吞：console.error
    // 留痕（同 collab/hooks-impl.ts 慣例），下一次 mount 會因全域仍是舊/壞的狀態再次冒出問題。
    const waiters = this.waiters;
    this.waiters = [];
    try {
      this.installGlobals();
      this.rebuildCount += 1;
    } catch (err) {
      console.error("EditingRuntime: installGlobals() failed during rebuild", err);
    } finally {
      this.pending = false;
      for (const w of waiters) w();
    }
  }
}

export function createEditingRuntime(config: AppConfig): EditingRuntime {
  const rt = new EditingRuntime({ baseUrl: `${publicUrlIssuer(config.publicUrl)}/` });
  rt.installGlobals();
  return rt;
}
