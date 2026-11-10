/**
 * #398：markdown 寫入解析的 worker pool。所有 markdown 寫入（`edit_note`、`create_note`、REST `POST /api/notes` 帶 content、`/edits`、
 * 批次寫回與新增）的解析都在這裡的 worker 裡跑，主執行緒（HTTP、協作）不再被一次解析卡住。讀出與套用的轉換（Y 文件 ⇄ BlockNote／markdown：
 * `/content`、`read_note_section`／`read_note_outline`、單篇下載與整包匯出、`edit_note`／`/edits`／建立的套用、撤回、批次寫回）也是這裡的
 * 工作（`doc`，`doc-jobs.ts`；很小的文件由 `EditingRuntime.runDoc` 留在主執行緒）。
 *
 * - 常駐 `workers` 個 worker（`parse-worker.ts`），每個有 V8 記憶體上限（`workerMemoryMb`）與堆疊上限（{@link PARSE_WORKER_STACK_MB}）。
 * - 批次寫回的未閉合 fence 判斷（{@link ParsePool.openFenceLine}，整檔 `markdownToHTML`）也在這裡跑，規則相同。
 * - 每次解析有時限（`timeoutMs`，從交給 worker 起算，不含排隊）：逾時就 `terminate()` 那個 worker、回 {@link TOO_COMPLEX}、補開一個。
 *   worker 因記憶體用完或任何原因掛掉，正在解析的那一筆也回 {@link TOO_COMPLEX}、補開一個。
 * - 一個檔可帶一份 worker 時間總預算（{@link ParseBudget}；批次寫回用）：送進 worker 的時限不超過剩下的預算，做完扣掉實際花的時間，
 *   用完之後的解析直接回 {@link TOO_COMPLEX}。
 * - worker 全忙時排隊（先來先做，最多 {@link PARSE_QUEUE_MAX} 筆，再多直接 {@link ParserBusyError}）；**每個使用者（`owner`）同時至多佔
 *   {@link PER_OWNER_MAX} 個 worker**，第 2 個只在沒有別人在排時給（空出來的 worker 先給手上沒有工作的人）。排隊超過
 *   `queueWaitMs` 還沒輪到 → {@link ParserBusyError}（呼叫端映成 503 `server_busy`）。
 * - 解析與轉換都是純函式：worker 只回 blocks、markdown、diff 或錯誤，寫進筆記照舊在主執行緒、在結果回來之後——中途終止不會留下任何寫入。
 *   轉換工作要查 DB 時（連結標題、批次寫回的額度）送 `ask`，主執行緒回 `answer`（同一件工作、時限照算）。轉換工作的時限由呼叫端給
 *   （預設 `DOC_TIMEOUT_FACTOR` × `timeoutMs`），逾時或掛掉回 `"too_complex"`。
 * - 每個 worker 解析滿 {@link RECYCLE_AFTER_PARSES} 筆就換一個新的：jsdom／BlockNote 萬一有殘留，也不會累積到撞上記憶體上限、把下一筆
 *   正常內容誤判成太複雜。做完一件之後 heap 用量超過記憶體上限的 {@link RECYCLE_HEAP_SHARE} 也換（worker 每次回結果時帶上用量）：
 *   轉換搬進 worker 之後，一份大筆記的讀出、套用、解析接連落在同一個 worker，mount 過的編輯器殘留與沒收的垃圾疊起來會用完上限
 *   （實測 2–3 MB 狀態的筆記：套用完緊接著讀出 → `ERR_WORKER_OUT_OF_MEMORY`）。用量高也可能只是還沒收的垃圾（上限 2 GiB 時普通的
 *   256 KiB 筆記解析完 heap 約 470 MiB）——誤判的代價只是多開一個 worker（約 0.5 秒），做完的那件不受影響。
 * - 閒置的 worker `unref()`（不讓程序為它多留），解析中的 `ref()`。`close()` 終止全部（`buildApp` 的 `onClose`）。
 *
 * 四個設定（`ParseLimits`）開機時由環境變數決定（`parse-settings.ts`）；{@link ParsePool.configure} 可在執行期改（#397 管理頁用）：
 * 時限與排隊等待立即生效、worker 數增減立即開／收（忙的做完才收）、記憶體上限套用在之後開的 worker。
 */
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ParseLimits } from "./parse-settings.js";
import { DOC_TOO_COMPLEX, type AskFn, type DocAsk, type DocOp } from "./doc-jobs.js";
import { PARSE_FILE_BUDGET_FACTOR, ParserBusyError, TOO_COMPLEX, type MarkdownParser, type ParseBudget, type ParseOutcome, type ParseRequest } from "./parse-core.js";

/** 主執行緒 → worker。 */
export type WorkerInbound =
  | { id: number; kind: "parse"; markdown: string; candidates: ParseRequest["candidates"]; siteOrigin: string }
  | { id: number; kind: "fence"; lines: string[] }
  | { id: number; kind: "doc"; op: DocOp }
  /** 轉換工作問的（`ask`）答案；`ok: false`＝主執行緒那邊丟了例外，worker 裡的工作跟著失敗（`failed`）。 */
  | { id: number; kind: "answer"; ok: boolean; value?: unknown };
/** worker → 主執行緒。`failed`＝程式錯（不是內容太複雜），主執行緒丟例外（500）。 */
export type WorkerOutbound =
  | { type: "ready" }
  | { type: "doc"; id: number; result: unknown; heapMb?: number }
  /** 轉換工作要問主執行緒（連結標題、批次寫回的額度）；工作仍佔著這個 worker、時限照算。 */
  | { type: "ask"; id: number; q: DocAsk }
  | { type: "result"; id: number; result: ParseOutcome; heapMb?: number }
  | { type: "fence"; id: number; line: number | null | "too_complex"; heapMb?: number }
  | { type: "failed"; id: number; name: string; frames: string[] };
export interface WorkerData {
  baseUrl: string;
}

/** worker 的堆疊上限（MiB，`resourceLimits.stackSizeMb`；Node 預設 4）。超過在 worker 裡丟 `RangeError` → {@link TOO_COMPLEX}。 */
export const PARSE_WORKER_STACK_MB = 4;
/** 排隊最多幾筆；超過的直接 `ParserBusyError`（503）。 */
export const PARSE_QUEUE_MAX = 100;
/** 每個 worker 解析滿這麼多筆就換新的（見檔頭）。換一個約 0.5 秒 CPU（量測見 `docs/self-hosting.md`），500 筆攤下來可忽略。 */
export const RECYCLE_AFTER_PARSES = 500;
/** 做完一件之後 heap 用量（worker 自己量的 `used_heap_size`）超過記憶體上限的這個比例就換掉那個 worker（見檔頭）。 */
export const RECYCLE_HEAP_SHARE = 0.5;
/** worker 還沒 `ready` 就掛掉時，下一次補開前等多久（毫秒；連續失敗加倍，至多 {@link RESPAWN_DELAY_MAX_MS}）。 */
export const RESPAWN_DELAY_MS = 1_000;
export const RESPAWN_DELAY_MAX_MS = 30_000;
/**
 * 每個使用者（`owner`）同時至多佔幾個 worker。轉換搬進 pool 之後，同一個人的瀏覽器下載與 MCP 讀寫會同時來，1 個太緊；但第 2 個只在
 * **沒有別人在排**時才給（`dispatch` 先挑手上沒有工作的人），所以別人最多等一件工作做完（≤ 一件工作的時限，比 `queueWaitMs` 短）。
 */
export const PER_OWNER_MAX = 2;
/** 文件狀態至少這麼大才 transfer 給 worker（不複製）；更小的複製（便宜，且呼叫端之後仍可用）。 */
export const TRANSFER_MIN_BYTES = 64 * 1024;

/** pool 用到的 worker 介面（`node:worker_threads` 的 `Worker`；測試可注入假的）。 */
export interface PoolWorker {
  postMessage(m: WorkerInbound, transfer?: ArrayBuffer[]): void;
  on(event: "message", fn: (m: WorkerOutbound) => void): unknown;
  on(event: "error", fn: (err: Error) => void): unknown;
  on(event: "exit", fn: (code: number) => void): unknown;
  terminate(): Promise<number>;
  ref(): void;
  unref(): void;
}
export type SpawnWorker = (opts: { baseUrl: string; workerMemoryMb: number; stackSizeMb: number }) => PoolWorker;

export interface PoolLog {
  info(o: object, m: string): void;
  warn(o: object, m: string): void;
  error(o: object, m: string): void;
}

export interface ParsePoolOptions extends ParseLimits {
  baseUrl: string;
  log?: PoolLog;
  /** 測試縫：開 worker 的方式（預設 {@link spawnParseWorker}）。 */
  spawn?: SpawnWorker;
}

/**
 * 開一個真的 parse worker。build 後（`.js`）直接開同目錄的 `parse-worker.js`；從原始碼跑（tsx 的 dev、vitest）時 `import.meta.url`
 * 是 `.ts`，worker 是另一個 Node 執行緒、不經 vite，所以用一段 eval 啟動碼先註冊 tsx 的 loader（`tsx/esm/api` 的 `register()`）再載入
 * `parse-worker.ts`。tsx 是 server 的 devDependency，正式 image（`pnpm deploy --prod`）裡沒有、也用不到。
 */
export const spawnParseWorker: SpawnWorker = ({ baseUrl, workerMemoryMb, stackSizeMb }) => {
  const resourceLimits = { maxOldGenerationSizeMb: workerMemoryMb, stackSizeMb };
  const workerData: WorkerData = { baseUrl };
  const here = import.meta.url;
  if (!here.endsWith(".ts")) return new Worker(new URL("./parse-worker.js", here), { workerData, resourceLimits });
  const api = pathToFileURL(createRequire(here).resolve("tsx/esm/api")).href;
  const entry = new URL("./parse-worker.ts", here).href;
  const boot = `import(${JSON.stringify(api)}).then(m => { m.register(); return import(${JSON.stringify(entry)}); })`;
  return new Worker(boot, { eval: true, workerData, resourceLimits });
};

/** 一件工作：markdown 解析或未閉合 fence 判斷（`job` 不含 `id`，送出時補上）。 */
type Job = { kind: "parse"; markdown: string; candidates: ParseRequest["candidates"]; siteOrigin: string } | { kind: "fence"; lines: string[] } | { kind: "doc"; op: DocOp };
interface Task {
  id: number;
  owner: string;
  job: Job;
  resolve(r: unknown): void;
  reject(e: Error): void;
  /** 逾時或 worker 掛掉時回的值（解析＝{@link TOO_COMPLEX}；fence＝`"too_complex"`）。 */
  tooComplex: unknown;
  queueTimer: ReturnType<typeof setTimeout> | null;
  /** 這筆算進的檔案總預算（選配）。 */
  budget: ParseBudget | undefined;
  /** 交給 worker 的時刻（`performance.now()`）；扣預算用。 */
  startedAt: number;
  /** 這件的時限（毫秒；轉換工作用，不給＝`timeoutMs`）。 */
  timeoutMs?: number;
  /** 轉換工作問主執行緒時的答案。 */
  ask?: AskFn;
}
interface Slot {
  worker: PoolWorker;
  state: "starting" | "idle" | "busy" | "gone";
  task: Task | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** 這個 slot 做完手上的就收掉（worker 數調小、或解析滿 {@link RECYCLE_AFTER_PARSES} 筆）。 */
  retire: boolean;
  parses: number;
}

export interface ParsePoolStats {
  workers: number;
  ready: number;
  busy: number;
  queued: number;
  /** 開過幾個 worker（含補開）。 */
  spawned: number;
  /** 因逾時被終止的次數。 */
  timedOut: number;
  /** 解析中掛掉（記憶體用完等）的次數。 */
  crashed: number;
  /** 解析滿 {@link RECYCLE_AFTER_PARSES} 筆、或做完一件 heap 用量過高（{@link RECYCLE_HEAP_SHARE}）換掉的次數。 */
  recycled: number;
  /** 收到幾件轉換工作（`runDoc`：讀出、套用、試套…；在主執行緒直接跑的小工作不算）。測試據此確認重工作確實送進了 worker。 */
  docJobs: number;
}

export class ParsePool implements MarkdownParser {
  private limitsNow: ParseLimits;
  private readonly baseUrl: string;
  private readonly spawnFn: SpawnWorker;
  private readonly log: PoolLog | undefined;
  private readonly slots = new Set<Slot>();
  private readonly queue: Task[] = [];
  private readonly running = new Map<string, number>();
  private nextId = 1;
  private closed = false;
  private respawnDelay = RESPAWN_DELAY_MS;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly counters = { spawned: 0, timedOut: 0, crashed: 0, recycled: 0, docJobs: 0 };

  constructor(opts: ParsePoolOptions) {
    this.baseUrl = opts.baseUrl;
    this.spawnFn = opts.spawn ?? spawnParseWorker;
    this.log = opts.log;
    this.limitsNow = { workers: opts.workers, workerMemoryMb: opts.workerMemoryMb, timeoutMs: opts.timeoutMs, queueWaitMs: opts.queueWaitMs };
    this.fill();
  }

  get limits(): ParseLimits {
    return { ...this.limitsNow };
  }

  stats(): ParsePoolStats {
    const live = [...this.slots].filter(s => s.state !== "gone" && !s.retire);
    return {
      workers: live.length,
      ready: live.filter(s => s.state === "idle" || s.state === "busy").length,
      busy: [...this.slots].filter(s => s.state === "busy").length,
      queued: this.queue.length,
      ...this.counters,
    };
  }

  /** 執行期換設定（#397）：時限與排隊等待立即生效（已在跑／已在排的照舊）；worker 數增減立即開／收；記憶體上限套用在之後開的 worker。 */
  configure(next: Partial<ParseLimits>): void {
    this.limitsNow = { ...this.limitsNow, ...next };
    const live = [...this.slots].filter(s => s.state !== "gone" && !s.retire);
    for (const s of live.slice(this.limitsNow.workers)) this.retireSlot(s);
    this.fill();
  }

  parse(req: ParseRequest): Promise<ParseOutcome> {
    const { owner, markdown, candidates, siteOrigin, budget } = req;
    return this.enqueue<ParseOutcome>(owner, { kind: "parse", markdown, candidates, siteOrigin }, TOO_COMPLEX, budget);
  }

  openFenceLine(owner: string, lines: readonly string[], budget?: ParseBudget): Promise<number | null | "too_complex"> {
    return this.enqueue<number | null | "too_complex">(owner, { kind: "fence", lines: [...lines] }, "too_complex", budget);
  }

  fileBudget(): ParseBudget {
    return { remainingMs: PARSE_FILE_BUDGET_FACTOR * this.limitsNow.timeoutMs };
  }

  timeoutMs(): number {
    return this.limitsNow.timeoutMs;
  }

  /** 轉換工作（`doc-jobs.ts`）：排隊、時限、掛掉的處理同解析；逾時或掛掉回 `"too_complex"`。 */
  runDoc(owner: string, op: DocOp, ask: AskFn, timeoutMs: number, queueWaitMs?: number): Promise<unknown> {
    this.counters.docJobs++;
    return this.enqueue<unknown>(owner, { kind: "doc", op }, DOC_TOO_COMPLEX, undefined, { timeoutMs, ask, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) });
  }

  private enqueue<R>(owner: string, job: Job, tooComplex: R, budget: ParseBudget | undefined, extra: { timeoutMs?: number; ask?: AskFn; queueWaitMs?: number } = {}): Promise<R> {
    if (this.closed) return Promise.reject(new Error("parse pool is closed"));
    // 預算已用完：不排隊、不送進 worker。
    if (budget !== undefined && budget.remainingMs <= 0) return Promise.resolve(tooComplex);
    // 佇列有上限，超過直接回忙碌（不讓佇列無限長、每筆都掛著一顆計時器等到逾時）。
    if (this.queue.length >= PARSE_QUEUE_MAX) return Promise.reject(new ParserBusyError());
    return new Promise<R>((resolve, reject) => {
      const { queueWaitMs, ...taskExtra } = extra;
      const task: Task = { id: this.nextId++, owner, job, resolve: resolve as (r: unknown) => void, reject, tooComplex, queueTimer: null, budget, startedAt: 0, ...taskExtra };
      task.queueTimer = setTimeout(() => {
        const i = this.queue.indexOf(task);
        if (i === -1) return;
        this.queue.splice(i, 1);
        reject(new ParserBusyError());
      }, queueWaitMs ?? this.limitsNow.queueWaitMs);
      this.queue.push(task);
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.respawnTimer !== null) clearTimeout(this.respawnTimer);
    for (const t of this.queue.splice(0)) {
      if (t.queueTimer !== null) clearTimeout(t.queueTimer);
      t.reject(new Error("parse pool is closed"));
    }
    const slots = [...this.slots];
    this.slots.clear();
    await Promise.all(
      slots.map(async s => {
        if (s.timer !== null) clearTimeout(s.timer);
        s.state = "gone";
        if (s.task !== null) s.task.reject(new Error("parse pool is closed"));
        s.task = null;
        await s.worker.terminate().catch(() => 0);
      })
    );
  }

  private fill(): void {
    if (this.closed || this.respawnTimer !== null) return;
    let live = [...this.slots].filter(s => s.state !== "gone" && !s.retire).length;
    while (live < this.limitsNow.workers) {
      this.spawnSlot();
      live++;
    }
  }

  private spawnSlot(): void {
    const memoryMb = this.limitsNow.workerMemoryMb;
    let worker: PoolWorker;
    try {
      worker = this.spawnFn({ baseUrl: this.baseUrl, workerMemoryMb: memoryMb, stackSizeMb: PARSE_WORKER_STACK_MB });
    } catch (err) {
      this.log?.error({ err }, "parse worker: spawn failed");
      this.scheduleRespawn();
      return;
    }
    this.counters.spawned++;
    const slot: Slot = { worker, state: "starting", task: null, timer: null, retire: false, parses: 0 };
    this.slots.add(slot);
    worker.unref();
    worker.on("message", m => this.onMessage(slot, m));
    worker.on("error", err => this.onGone(slot, err));
    worker.on("exit", code => this.onGone(slot, null, code));
  }

  private scheduleRespawn(): void {
    if (this.closed || this.respawnTimer !== null) return;
    const delay = this.respawnDelay;
    this.respawnDelay = Math.min(RESPAWN_DELAY_MAX_MS, this.respawnDelay * 2);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      this.fill();
    }, delay);
    this.respawnTimer.unref();
  }

  private onMessage(slot: Slot, m: WorkerOutbound): void {
    if (slot.state === "gone") return;
    if (m.type === "ready") {
      this.respawnDelay = RESPAWN_DELAY_MS;
      if (slot.retire) return void this.endSlot(slot);
      slot.state = "idle";
      this.dispatch();
      return;
    }
    const task = slot.task;
    if (task === null || task.id !== m.id) return;
    if (m.type === "ask") return void this.answer(slot, task, m.q);
    this.finishTask(slot);
    if (m.type === "failed") {
      this.log?.error({ name: m.name, frames: m.frames }, "parse worker: parse threw");
      task.reject(new Error(`parse worker: ${m.name}`));
    } else {
      task.resolve(m.type === "result" ? m.result : m.type === "doc" ? m.result : m.line);
    }
    const heavy = m.type !== "failed" && m.heapMb !== undefined && m.heapMb > RECYCLE_HEAP_SHARE * this.limitsNow.workerMemoryMb;
    if ((++slot.parses >= RECYCLE_AFTER_PARSES || heavy) && !slot.retire) {
      this.counters.recycled++;
      slot.retire = true;
    }
    if (slot.retire) {
      this.endSlot(slot);
      this.fill();
    } else {
      slot.state = "idle";
      slot.worker.unref();
    }
    this.dispatch();
  }

  /** 轉換工作問的：在主執行緒算答案、回給同一個 worker（那時它若已逾時被換掉、或在做別件，答案丟掉）。 */
  private answer(slot: Slot, task: Task, q: DocAsk): void {
    const reply = (ok: boolean, value?: unknown) => {
      if (slot.task !== task || slot.state !== "busy") return;
      slot.worker.postMessage({ id: task.id, kind: "answer", ok, ...(ok ? { value } : {}) });
    };
    if (task.ask === undefined) return reply(false);
    task.ask(q).then(
      v => reply(true, v),
      err => {
        this.log?.error({ err: err instanceof Error ? { name: err.name, message: err.message } : String(err), ask: q.kind }, "parse worker: answering a doc job failed");
        reply(false);
      }
    );
  }

  /** worker 掛掉或結束（逾時的 terminate 也會走到這裡，但那時 slot 已是 gone）。 */
  private onGone(slot: Slot, err: Error | null, code?: number): void {
    if (slot.state === "gone") return;
    const wasStarting = slot.state === "starting";
    const task = slot.task;
    slot.state = "gone";
    this.slots.delete(slot);
    if (task !== null) {
      this.finishTask(slot);
      this.counters.crashed++;
      this.log?.warn({ err: err ? { name: err.name, code: (err as { code?: string }).code } : null, exitCode: code ?? null }, "parse worker: died while parsing; answered too_complex");
      task.resolve(task.tooComplex);
    } else if (!slot.retire) {
      this.log?.error({ err: err ? { name: err.name, message: err.message } : null, exitCode: code ?? null, starting: wasStarting }, "parse worker: exited");
    }
    if (this.closed) return;
    if (wasStarting && !slot.retire) this.scheduleRespawn();
    else this.fill();
    this.dispatch();
  }

  private finishTask(slot: Slot): void {
    const task = slot.task!;
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timer = null;
    slot.task = null;
    if (task.budget !== undefined) task.budget.remainingMs -= performance.now() - task.startedAt;
    const n = (this.running.get(task.owner) ?? 1) - 1;
    if (n <= 0) this.running.delete(task.owner);
    else this.running.set(task.owner, n);
  }

  private retireSlot(slot: Slot): void {
    slot.retire = true;
    if (slot.state === "idle" || slot.state === "starting") this.endSlot(slot);
  }

  private endSlot(slot: Slot): void {
    slot.state = "gone";
    this.slots.delete(slot);
    void slot.worker.terminate().catch(() => 0);
  }

  private dispatch(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.state !== "idle") continue;
      // 先挑手上沒有工作的人；沒有才讓已有工作的人用第 2 個（{@link PER_OWNER_MAX}）。
      let i = this.queue.findIndex(t => !this.running.has(t.owner));
      if (i === -1) i = this.queue.findIndex(t => (this.running.get(t.owner) ?? 0) < PER_OWNER_MAX);
      if (i === -1) return;
      const [task] = this.queue.splice(i, 1) as [Task];
      if (task.queueTimer !== null) clearTimeout(task.queueTimer);
      task.queueTimer = null;
      this.running.set(task.owner, (this.running.get(task.owner) ?? 0) + 1);
      slot.state = "busy";
      slot.task = task;
      slot.worker.ref();
      task.startedAt = performance.now();
      // 時限＝單次時限與檔案總預算剩下的取小（預算在排隊時可能已被同一檔的其他解析扣光：直接回太複雜，不送進 worker）。
      const own = task.timeoutMs ?? this.limitsNow.timeoutMs;
      const limit = task.budget === undefined ? own : Math.min(own, task.budget.remainingMs);
      if (limit <= 0) {
        this.finishTask(slot);
        slot.state = "idle";
        slot.worker.unref();
        task.resolve(task.tooComplex);
        queueMicrotask(() => this.dispatch()); // 這個 worker 又空了：再派一次（這一輪已經走過它）
        continue;
      }
      slot.timer = setTimeout(() => this.onTimeout(slot, task), limit);
      if (task.job.kind === "doc") {
        const op = task.job.op;
        const st = op.state;
        // 文件狀態夠大、且自己佔整個 ArrayBuffer（`encodeStateAsUpdate` 的結果、pg 的大 bytea）才 transfer；pg 的小 Buffer 可能切自共用池，不能 transfer。
        const own = st.byteLength >= TRANSFER_MIN_BYTES && st.byteOffset === 0 && st.byteLength === st.buffer.byteLength && st.buffer instanceof ArrayBuffer;
        slot.worker.postMessage({ id: task.id, kind: "doc", op: own ? op : { ...op, state: new Uint8Array(st) } }, own ? [st.buffer as ArrayBuffer] : []);
      } else {
        slot.worker.postMessage({ id: task.id, ...task.job });
      }
    }
  }

  private onTimeout(slot: Slot, task: Task): void {
    if (slot.task !== task) return;
    this.finishTask(slot);
    this.counters.timedOut++;
    slot.state = "gone";
    this.slots.delete(slot);
    void slot.worker.terminate().catch(() => 0);
    this.log?.warn({ timeoutMs: this.limitsNow.timeoutMs, kind: task.job.kind }, "parse worker: parse timed out; worker terminated, answered too_complex");
    task.resolve(task.tooComplex);
    this.fill();
    this.dispatch();
  }
}
