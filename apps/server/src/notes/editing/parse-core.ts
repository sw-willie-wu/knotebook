/**
 * #398：markdown 寫入解析的共同核心——parse worker（`parse-worker.ts`）與同執行緒的 `InlineMarkdownParser`（只給直接 `new EditingRuntime`
 * 的單元測試用）都走這裡，所以兩邊的答案是同一支 `parseMarkdownForNote` 算的。
 *
 * 解析用的編輯器：headless note schema、**不 mount、不連協作**。`tryParseHTMLToBlocks` 只用 schema 與 DOM 剖析，不碰文件內容，
 * 所以一顆編輯器可以重複用（舊做法每次在 scratch Y.Doc 上 mount 一顆，結果相同：`test/unit/parse-core.test.ts` 逐 golden 比對）。
 */
import { BlockNoteEditor } from "@blocknote/core";
import { createHeadlessNoteSchema } from "@knotebook/shared";
import { trailingOpenFenceLine } from "../../transfer/regions.js";
import type { VisibleNoteTarget } from "./candidates.js";
import { DEFAULT_PARSE_TIMEOUT_MS, type ParseLimits } from "./parse-settings.js";
import type { AskFn, DocOp } from "./doc-jobs.js";
import { parseMarkdownForNote, type ParsedMarkdown, type ParseFailure } from "./markdown.js";

/** 一次解析的輸入（worker 訊息的本體；全是可 structured clone 的純資料）。 */
export interface ParseRequest {
  /** 排隊用的使用者鍵（每人同時至多佔一個 worker）；不進 worker。 */
  owner: string;
  markdown: string;
  candidates: readonly VisibleNoteTarget[];
  siteOrigin: string;
  /** 選配：這筆算在哪一份 worker 時間總預算裡（批次寫回一個檔的所有解析共用一份，見 {@link ParseBudget}）；不進 worker。 */
  budget?: ParseBudget;
}
/**
 * #398：一個檔的 worker 時間總預算（毫秒，會被扣）。批次寫回一個檔要解析很多次（邊界、各區、fence 判斷，指紋不符時整套重來），
 * 每次各有時限還不夠——預算用完，之後的解析不送進 worker、直接回太複雜；送進去的那次時限也不超過剩下的預算。
 */
export interface ParseBudget {
  remainingMs: number;
}
/** 一個檔的總預算＝這麼多倍的單次時限（跟著 `PARSE_TIMEOUT_MS` 走）。 */
export const PARSE_FILE_BUDGET_FACTOR = 3;
export type ParseOutcome = ParsedMarkdown | ParseFailure;

/** 解析入口（worker pool 或同執行緒）。worker 全忙、排隊等太久 → 丟 {@link ParserBusyError}。 */
export interface MarkdownParser {
  parse(req: ParseRequest): Promise<ParseOutcome>;
  /**
   * 批次寫回的未閉合 fence 判斷（`transfer/regions.ts` 的 `trailingOpenFenceLine`：整檔 `markdownToHTML`，對 `*a ` 重複這類輸入是平方級，
   * 256 KiB 約 64 秒）。回那一行的索引、沒有 → null；逾時、用完記憶體或堆疊 → `"too_complex"`。`owner` 同 {@link ParseRequest.owner}。
   */
  openFenceLine(owner: string, lines: readonly string[], budget?: ParseBudget): Promise<number | null | "too_complex">;
  /** 一份新的檔案總預算（{@link PARSE_FILE_BUDGET_FACTOR} × 目前的單次時限）。 */
  fileBudget(): ParseBudget;
  /** 目前的單次時限（毫秒，`PARSE_TIMEOUT_MS`）。 */
  timeoutMs(): number;
  /**
   * 選配：在 worker 裡跑一件轉換工作（`doc-jobs.ts`；`EditingRuntime.runDoc` 用）。沒有＝一律在主執行緒跑（同執行緒的解析入口）。
   * 逾時或 worker 掛掉回 `"too_complex"`；排隊逾時丟 {@link ParserBusyError}。
   */
  runDoc?(owner: string, op: DocOp, ask: AskFn, timeoutMs: number, queueWaitMs?: number): Promise<unknown>;
  /** 選配：執行期換設定（worker pool 有；同執行緒的解析入口沒有，跟著站台限制改時跳過）。語意見 `ParsePool.configure`。 */
  configure?(next: Partial<ParseLimits>): void;
  close(): Promise<void>;
}

/** 排隊超過上限還沒輪到 worker（呼叫端映成 503 `server_busy`）。 */
export class ParserBusyError extends Error {
  override name = "ParserBusyError";
}

/** 解析超過時限、用完記憶體或堆疊（worker 被終止或拋 `RangeError`）的答案：`400 unsupported_block`。 */
export const TOO_COMPLEX: ParseFailure = { error: "unsupported_block", detail: "too_complex" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 session.ts）
export type ParserEditor = BlockNoteEditor<any, any, any>;

/** 解析用的編輯器（呼叫前全域要有 `document`：worker 裡由 `EditingRuntime.installGlobals()` 掛上）。 */
export function createParserEditor(baseUrl: string): ParserEditor {
  return BlockNoteEditor.create({ schema: createHeadlessNoteSchema(baseUrl) }) as ParserEditor;
}

/**
 * 跑一次解析。`RangeError`（堆疊溢位 `Maximum call stack size exceeded`、陣列或字串長度超過上限）＝內容太複雜，回 {@link TOO_COMPLEX}；
 * 其他例外原樣丟出（是程式錯，呼叫端照舊 500）。`tryParseHTMLToBlocks` 自己的例外在 `parseMarkdownForNote` 裡已經接成 `editor_internal`。
 */
export function runParse(editor: ParserEditor, req: Omit<ParseRequest, "owner">): ParseOutcome {
  try {
    return parseMarkdownForNote(editor, req.markdown, req.candidates, req.siteOrigin);
  } catch (err) {
    if (err instanceof RangeError) return TOO_COMPLEX;
    throw err;
  }
}

/** {@link MarkdownParser.openFenceLine} 的本體（worker 與同執行緒共用）：`RangeError` → `"too_complex"`，其他例外原樣丟。 */
export function runOpenFenceLine(lines: readonly string[]): number | null | "too_complex" {
  try {
    return trailingOpenFenceLine(lines);
  } catch (err) {
    if (err instanceof RangeError) return "too_complex";
    throw err;
  }
}

/** 同執行緒版的預算：用完就不做、回 `tooComplex`；做了就扣掉實際花的時間（同執行緒沒辦法中途停，只能事後扣）。 */
function charged<T, F>(budget: ParseBudget | undefined, tooComplex: F, run: () => T): T | F {
  if (budget === undefined) return run();
  if (budget.remainingMs <= 0) return tooComplex;
  const t = performance.now();
  try {
    return run();
  } finally {
    budget.remainingMs -= performance.now() - t;
  }
}

/**
 * 同執行緒的解析（舊行為：會卡住事件迴圈）。只給直接 `new EditingRuntime(...)` 的單元測試用；生產與整合測試的 runtime 由
 * `createEditingRuntime` 建，一律是 worker pool（`test/unit/parse-pool.test.ts` 釘住）。`rebuilds` 變了（runtime 換過 window）就重建編輯器。
 */
export class InlineMarkdownParser implements MarkdownParser {
  private editor: ParserEditor | null = null;
  private builtAt = -1;
  constructor(private readonly runtime: { readonly baseUrl: string; readonly rebuilds: number }) {}
  async parse(req: ParseRequest): Promise<ParseOutcome> {
    if (this.editor === null || this.builtAt !== this.runtime.rebuilds) {
      this.editor = createParserEditor(this.runtime.baseUrl);
      this.builtAt = this.runtime.rebuilds;
    }
    const editor = this.editor;
    return charged(req.budget, TOO_COMPLEX, () => runParse(editor, req));
  }
  async openFenceLine(_owner: string, lines: readonly string[], budget?: ParseBudget): Promise<number | null | "too_complex"> {
    return charged(budget, "too_complex" as const, () => runOpenFenceLine(lines));
  }
  fileBudget(): ParseBudget {
    return { remainingMs: PARSE_FILE_BUDGET_FACTOR * DEFAULT_PARSE_TIMEOUT_MS };
  }
  timeoutMs(): number {
    return DEFAULT_PARSE_TIMEOUT_MS;
  }
  async close(): Promise<void> {}
}
