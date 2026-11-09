/**
 * #398：parse worker 的進入點（`parse-pool.ts` 開；build 後是 `dist/notes/editing/parse-worker.js`，與 `parse-pool.js` 同目錄）。
 *
 * 啟動：建一個 worker 自己的 `EditingRuntime`（掛 jsdom 全域，同主執行緒；解析入口是同執行緒的 `InlineMarkdownParser`）→ 建一顆解析用
 * 編輯器 → 送 `ready`。之後每則訊息做一件事、回結果：markdown 解析（`parse`）、批次寫回的未閉合 fence 判斷（`fence`），或讀出與套用的
 * 轉換（`doc`，`doc-jobs.ts`；要問 DB 時送 `ask`、等主執行緒回 `answer`）。不碰 DB、不碰筆記、不開任何連線。
 * 被 `terminate()`（逾時）或 V8 堆滿（`resourceLimits`）時整個 worker 消失，主執行緒照樣在跑。pool 一次只交一件工作給一個 worker。
 */
import { getHeapStatistics } from "node:v8";
import { parentPort, workerData } from "node:worker_threads";
import { executeDocOp, type DocAsk } from "./doc-jobs.js";
import { createParserEditor, runOpenFenceLine, runParse, type ParserEditor } from "./parse-core.js";
import { EditingRuntime } from "./runtime.js";
import type { WorkerInbound, WorkerOutbound, WorkerData } from "./parse-pool.js";

const port = parentPort;
if (port === null) throw new Error("parse-worker：只能當 worker 執行");
const { baseUrl } = workerData as WorkerData;
const runtime = new EditingRuntime({ baseUrl });
runtime.installGlobals();
let editor: ParserEditor = createParserEditor(baseUrl);
let editorBuiltAt = runtime.rebuilds;
const send = (m: WorkerOutbound) => port.postMessage(m);
/** 這個 worker 的 heap 用量（MiB；pool 據以決定做完要不要換掉它，`RECYCLE_HEAP_SHARE`）。 */
const heapMb = () => Math.round(getHeapStatistics().used_heap_size / 1048576);
/** 等主執行緒回答的那一問（一次只有一件工作，所以至多一筆；鍵＝工作 id）。 */
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

/** 程式錯（不是內容太複雜）：只回類名與呼叫框，不回 message（可能夾帶內容片段，同 `parseMarkdownForNote` 的 warn）。 */
function failed(id: number, err: unknown): WorkerOutbound {
  const frames = err instanceof Error ? (err.stack ?? "").split("\n").slice(err.message.split("\n").length).filter(l => /^\s+at /.test(l)) : [];
  return { type: "failed", id, name: err instanceof Error ? err.name : typeof err, frames };
}

async function runDocJob(m: Extract<WorkerInbound, { kind: "doc" }>): Promise<void> {
  const ask = (q: DocAsk) =>
    new Promise<unknown>((resolve, reject) => {
      pending.set(m.id, { resolve, reject });
      send({ type: "ask", id: m.id, q });
    });
  let out: WorkerOutbound;
  try {
    out = { type: "doc", id: m.id, result: await executeDocOp(runtime, m.op, ask), heapMb: 0 };
  } catch (err) {
    out = failed(m.id, err);
  } finally {
    pending.delete(m.id);
  }
  runtime.settleAfterJob();
  if (out.type === "doc") out.heapMb = heapMb();
  send(out);
}

port.on("message", (m: WorkerInbound) => {
  if (m.kind === "answer") {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (p) {
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error("parse worker: the main thread could not answer"));
    }
    return;
  }
  if (m.kind === "doc") return void runDocJob(m);
  let out: WorkerOutbound;
  try {
    if (m.kind === "fence") out = { type: "fence", id: m.id, line: runOpenFenceLine(m.lines), heapMb: heapMb() };
    else {
      // runtime 換過 window（轉換工作 mount 滿 N 次）→ 解析用編輯器跟著換（同 `InlineMarkdownParser`）。
      if (editorBuiltAt !== runtime.rebuilds) {
        editor = createParserEditor(baseUrl);
        editorBuiltAt = runtime.rebuilds;
      }
      out = { type: "result", id: m.id, result: runParse(editor, m), heapMb: heapMb() };
    }
  } catch (err) {
    out = failed(m.id, err);
  }
  send(out);
});
send({ type: "ready" });
