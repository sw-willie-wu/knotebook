// 未 mount 的 collaborative editor 是空文件（by-id 操作 throw），所以每個 session 都要 mount 進 jsdom；
// mount 過的 editor 即使 unmount 也殘留約 0.53 MB/顆、GC 收不回。對策：每 N 次 mount 或 heap
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
import { patchJsdomForLargeTrees } from "./jsdom-perf.js";
import { DOC_INLINE_MAX_BYTES, DOC_TIMEOUT_FACTOR, docWeight, executeDocOp, type AskFn, type DocOp, type DocOpOf, type DocResults, type DocTooComplex } from "./doc-jobs.js";
import { InlineMarkdownParser, type MarkdownParser } from "./parse-core.js";
import { ParsePool, type PoolLog } from "./parse-pool.js";
import type { ParseLimits } from "./parse-settings.js";

export interface EditingRuntimeOptions {
  baseUrl: string;
  rebuildEvery?: number;
  heapGrowthLimit?: number;
  readHeapUsed?: () => number;
  /**
   * #398：markdown 寫入解析的入口。`createEditingRuntime` 給 worker pool（生產與整合測試）；不給＝同執行緒的
   * `InlineMarkdownParser`（只給直接 `new EditingRuntime` 的單元測試）。
   */
  parser?: MarkdownParser;
  /** 轉換工作（`runDoc`）在主執行緒直接跑的上限（位元組；預設 {@link DOC_INLINE_MAX_BYTES}）。測試縫：0＝一律送 worker。 */
  inlineMaxBytes?: number;
}
export interface SessionLease {
  release(): void;
}

const DEFAULT_REBUILD_EVERY = 50;
const DEFAULT_HEAP_LIMIT = 64 * 1024 * 1024;
const noAsk: AskFn = async q => {
  throw new Error(`EditingRuntime.runDoc: no answer for ask ${q.kind}`);
};

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
  /** #398：markdown 寫入解析（見 `EditingRuntimeOptions.parser`）。 */
  readonly parser: MarkdownParser;
  readonly inlineMaxBytes: number;

  constructor(opts: EditingRuntimeOptions) {
    this.baseUrl = opts.baseUrl;
    this.inlineMaxBytes = opts.inlineMaxBytes ?? DOC_INLINE_MAX_BYTES;
    this.parser = opts.parser ?? new InlineMarkdownParser(this);
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

  /**
   * 讀出與套用的轉換（`doc-jobs.ts`）：解析入口是 worker pool 時送 worker（時限 {@link DOC_TIMEOUT_FACTOR} × `PARSE_TIMEOUT_MS`，
   * 可由 `timeoutMs` 指定），工作很小（{@link docWeight} 小於 `inlineMaxBytes`）或解析入口是同執行緒時在這裡直接跑——兩邊同一支
   * `executeDocOp`。worker 全忙排太久 → `ParserBusyError`；逾時、用完記憶體或堆疊 → `"too_complex"`。`ask`：工作要問 DB 時的答案。
   */
  runDoc<K extends DocOp["kind"]>(owner: string, op: DocOpOf<K>, opts: { ask?: AskFn; extraWeight?: number; timeoutMs?: number; queueWaitMs?: number } = {}): Promise<DocResults[K] | DocTooComplex> {
    const ask = opts.ask ?? noAsk;
    const pool = this.parser.runDoc?.bind(this.parser);
    if (pool === undefined || docWeight(op, opts.extraWeight) < this.inlineMaxBytes) return executeDocOp<K>(this, op, ask);
    return pool(owner, op, ask, opts.timeoutMs ?? DOC_TIMEOUT_FACTOR * this.parser.timeoutMs(), opts.queueWaitMs) as Promise<DocResults[K] | DocTooComplex>;
  }

  /** 收掉解析的 worker（`buildApp` 的 `onClose`；只收它自己建的 runtime）。 */
  async close(): Promise<void> {
    await this.parser.close();
  }

  installGlobals(): void {
    // #398：拿掉 jsdom 在大的子節點清單上的三處平方（活清單立即重算、插入／移除時多算的索引；見 `jsdom-perf.ts`）。
    if (!patchJsdomForLargeTrees()) console.warn("EditingRuntime: could not patch jsdom for large node lists; exporting large paragraphs may be slow");
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

  /**
   * 轉換工作做完（worker 裡，`parse-worker.ts`）：heap 比基線多出 `heapGrowthLimit` 就**現在**換 window（沒有 session 在用時）。
   * `noteMount` 的檢查在 mount 之前，量不到剛做完那件留下的東西：mount 過的編輯器 unmount 後仍掛在 window 上（檔頭），一份大筆記
   * 讀完緊接著套用，兩份疊在 worker 的記憶體上限裡會用完（實測 2 MB 狀態的筆記：讀完再套用 → `ERR_WORKER_OUT_OF_MEMORY`）。
   */
  settleAfterJob(): void {
    if (this.readHeapUsed() - this.heapBaseline > this.heapGrowthLimit) this.pending = true;
    this.maybeRebuild();
  }

  noteMount(): void {
    this.mountCount += 1;
    this.mountsSinceRebuild += 1;
    if (this.mountsSinceRebuild >= this.rebuildEvery || this.readHeapUsed() - this.heapBaseline > this.heapGrowthLimit) this.pending = true;
  }

  private maybeRebuild(): void {
    if (!this.pending || this.inFlightCount > 0) return;
    // installGlobals() 若 throw：pending 與 waiters 一定要在 finally 放掉，否則所有排隊中
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

/**
 * 生產（`buildApp`）與整合測試的 runtime：解析一律走 worker pool（#398）。`limits` 是 pool 的初始設定（`buildApp` 傳
 * `siteLimits.parseLimits()`；之後的變動由 `buildApp` 訂閱 `siteLimits.onChange` 再 `configure`）。`close()` 收掉 pool。
 */
export function createEditingRuntime(config: AppConfig, limits: ParseLimits, log?: PoolLog): EditingRuntime {
  const baseUrl = `${publicUrlIssuer(config.publicUrl)}/`;
  const { workers, workerMemoryMb, timeoutMs, queueWaitMs } = limits;
  const rt = new EditingRuntime({ baseUrl, parser: new ParsePool({ baseUrl, workers, workerMemoryMb, timeoutMs, queueWaitMs, log }) });
  rt.installGlobals();
  return rt;
}
