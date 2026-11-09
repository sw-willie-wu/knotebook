/**
 * #398：markdown 解析在 worker 裡跑之後多出的兩種 HTTP 答案（REST `/edits`、`POST /api/notes` 帶 content、批次寫回與新增共用）。
 * MCP 的模型面字串在 `mcp/write-messages.ts`。
 */
import type { FastifyReply } from "fastify";
import { ParserBusyError } from "../notes/editing/parse-core.js";
import { NoteReadTooComplexError } from "../notes/editing/read.js";
import { sendError } from "./errors.js";

/** 解析的 worker 全忙、排隊超過 `PARSE_QUEUE_WAIT_MS` 時 503 帶的 `Retry-After`（秒）。 */
export const PARSER_BUSY_RETRY_AFTER_S = 5;
export const PARSER_BUSY_MESSAGE = "The server is busy processing other writes. Try again in a moment.";
/** 讀出的轉換排不進 parse worker（`/content`、兩個 409 的 `current`、單篇下載與整包匯出）。 */
export const READ_BUSY_MESSAGE = "The server is busy processing other requests. Try again in a moment.";
/** 500 `too_complex`：把寫入或撤回套進一篇既有筆記的轉換在 parse worker 裡逾時或用完記憶體——是筆記本身太大或太複雜，不是寫入的內容（審查 r4 M4）。 */
export const NOTE_WRITE_TOO_COMPLEX_MESSAGE = "This note is too large or too complex to change within the server's time and memory limits, so nothing was written. Retrying won't help; split the note to keep editing it this way.";
/** 500 `too_complex`：讀出一篇筆記的轉換在 parse worker 裡逾時或用完記憶體。 */
export const READ_TOO_COMPLEX_MESSAGE = "This note is too large or too complex to read within the server's time and memory limits.";

/** 400 `unsupported_block`、成因 `too_complex`：解析超過時限，或用完 worker 的記憶體或堆疊。 */
export const TOO_COMPLEX_MESSAGE =
  "The content is too complex to process within the server's time and memory limits, so nothing was written. Split it into smaller parts or simplify its formatting.";

/** 503 `server_busy`＋`Retry-After`（解析排隊逾時）。 */
export function sendParserBusy(reply: FastifyReply, message = PARSER_BUSY_MESSAGE): FastifyReply {
  reply.header("retry-after", String(PARSER_BUSY_RETRY_AFTER_S));
  return sendError(reply, 503, "server_busy", message);
}

/** 讀出轉換的兩種失敗 → 503 `server_busy`＋`Retry-After`／500 `too_complex`；其他例外回 null（呼叫端照舊丟出）。 */
export function sendDocReadError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof ParserBusyError) return sendParserBusy(reply, READ_BUSY_MESSAGE);
  if (err instanceof NoteReadTooComplexError) return sendError(reply, 500, "too_complex", READ_TOO_COMPLEX_MESSAGE);
  return null;
}
