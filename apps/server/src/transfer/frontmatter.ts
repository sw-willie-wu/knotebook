/**
 * bulk transfer：一篇檔案的 frontmatter（寫出）；讀入（`readNoteFile`）。
 *
 * 鍵序固定（表）：`knotebook`、`id`、`title`、`role`、`base`、`url`。`title` 一律 `JSON.stringify`（逸出 `"`、`\`、
 * 換行，所以永遠單行；讀法以 `"` 開頭 → `JSON.parse`，逐字往返）。其餘值是 uuid／角色名／16 hex／站內路徑，原樣寫。
 * 本文原樣接在第二條 `---` 之後（就是整篇匯出原文，不正規化）。
 */
import { UUID_RE } from "@knotebook/shared";
import { normalizeBody } from "./normalize.js";

/** 檔案格式版本。 */
export const TRANSFER_FILE_VERSION = 1;

/** frontmatter 的結束行 `---` 必須在前幾行內（1 起算第 200 行以內）。 */
export const FRONTMATTER_SCAN_LINES = 200;

export type ReadFile =
  | { kind: "existing"; id: string; base: string; title: string | undefined; body: string }
  | { kind: "new"; title: string | undefined; folderId: string | undefined; body: string }
  | { kind: "error"; message: string };

/** 三種讀法：`"` 開頭 → JSON；`'…'` → YAML 單引號（`''` 還原成 `'`）；其他 → 原樣。`raw` 已去頭尾空白。 */
export function parseScalar(raw: string): { ok: true; value: string } | { ok: false } {
  if (raw.startsWith('"')) {
    try {
      const v: unknown = JSON.parse(raw);
      return typeof v === "string" ? { ok: true, value: v } : { ok: false };
    } catch {
      return { ok: false };
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return { ok: true, value: raw.slice(1, -1).replace(/''/g, "'") };
  return { ok: true, value: raw };
}

const READ_KEYS = ["id", "base", "title", "folder_id"] as const;
type ReadKey = (typeof READ_KEYS)[number];
const BASE_RE = /^[0-9a-f]{16}$/;
/** 不變量 S（全域 pg-unstorable-strings-drizzle-tx）：NUL 或落單代理。不用 `isWellFormed()`（它不管 NUL）。 */
const UNSTORABLE = /[\0]|\p{Surrogate}/u;

const bad = (message: string): ReadFile => ({ kind: "error", message });
/** 認得 front matter 的行（冒號前可以有空白或 tab，`id :` 也算；`base:` 也算，好讓「有 base 沒 id」能被擋下）。 */
const MARKER_LINE = /^(?:knotebook|id|base)[ \t]*:/;
/** 有 `base` 卻沒有（認得出的）`id`——當成新檔會多建一篇，改回 400。 */
export const BASE_WITHOUT_ID_MESSAGE = "The front matter has a base but no id. This is a downloaded file: keep its original id line and send it again.";
/** B（HTTP 層，#372 起英文）；觸發條件含 `base:` 與冒號前的空白（`MARKER_LINE`）。 */
export const UNCLOSED_FRONT_MATTER_MESSAGE =
  "The front matter has no closing `---`: the file starts with `---` and has a `knotebook:`, `id:` or `base:` line (spaces allowed before the colon) in its first 200 lines, but no `---` line closes it.";

/**
 * 讀入一篇檔（`text`＝已 UTF-8 解碼的整個 body）。全部是純計算、在任何 DB 查詢之前；錯誤訊息不帶任何值。
 * 順序：① 去 BOM、CRLF → LF ② 含 NUL → 錯 ③ 辨識 frontmatter ④ 只讀四鍵、重複 → 錯 ⑤ 三種讀法
 * ⑥ 值含 NUL／落單代理 → 錯 ⑦ 有 `id`：uuid（轉小寫）＋必須有 16 hex 的 `base` ⑧ 沒 `id`：新增，`folder_id` 轉小寫
 * ⑨ `title` 行存在但為空 → 錯 ⑩ 本文經 `normalizeBody`。
 */
export function readNoteFile(text: string): ReadFile {
  const s = text.replace(/^\ufeff/, "").replace(/\r\n/g, "\n");
  if (s.includes("\0")) return bad("The file contains a NUL character.");
  const lines = s.split("\n");
  let end = -1;
  if (s.startsWith("---\n")) {
    const limit = Math.min(lines.length, FRONTMATTER_SCAN_LINES);
    for (let i = 1; i < limit; i++) {
      if (lines[i] === "---") {
        end = i;
        break;
      }
    }
    if (end !== -1 && !lines.slice(1, end).some(l => MARKER_LINE.test(l))) end = -1;
    // 開頭 `---`、前 FRONTMATTER_SCAN_LINES 行內有 `knotebook:`／`id:`、卻找不到收尾的 `---` → 400（不再把整檔當內文、
    // 誤建一篇新筆記，或把 front matter 寫進既有筆記）。
    else if (end === -1 && lines.slice(1, limit).some(l => MARKER_LINE.test(l))) return bad(UNCLOSED_FRONT_MATTER_MESSAGE);
  }
  if (end === -1) return { kind: "new", title: undefined, folderId: undefined, body: normalizeBody(s) };

  const vals = new Map<ReadKey, string>();
  for (const l of lines.slice(1, end)) {
    const c = l.indexOf(":");
    if (c === -1) continue;
    const k = l.slice(0, c).trimEnd();
    if (!(READ_KEYS as readonly string[]).includes(k)) continue;
    const key = k as ReadKey;
    if (vals.has(key)) return bad(`The front matter has \`${key}\` more than once.`);
    const p = parseScalar(l.slice(c + 1).trim());
    if (!p.ok || UNSTORABLE.test(p.value)) return bad(`The front matter's \`${key}\` is malformed.`);
    vals.set(key, p.value);
  }
  const title = vals.get("title");
  if (title === "") return bad("The front matter's `title` can't be empty.");
  const body = normalizeBody(lines.slice(end + 1).join("\n"));
  const id = vals.get("id");
  if (id !== undefined) {
    const lid = id.toLowerCase();
    if (!UUID_RE.test(lid)) return bad("The front matter's `id` is malformed.");
    const base = vals.get("base");
    if (base === undefined) return bad("A file with an id must also have a base.");
    if (!BASE_RE.test(base)) return bad("The front matter's `base` is malformed.");
    return { kind: "existing", id: lid, base, title, body };
  }
  if (vals.has("base")) return bad(BASE_WITHOUT_ID_MESSAGE);
  const folder = vals.get("folder_id");
  let folderId: string | undefined;
  if (folder !== undefined) {
    folderId = folder.toLowerCase();
    if (!UUID_RE.test(folderId)) return bad("The front matter's `folder_id` is malformed.");
  }
  return { kind: "new", title, folderId, body };
}

export function writeNoteFile(fm: { id: string; title: string; role: string; base: string; url: string }, body: string): string {
  return (
    "---\n" +
    `knotebook: ${TRANSFER_FILE_VERSION}\n` +
    `id: ${fm.id}\n` +
    `title: ${JSON.stringify(fm.title)}\n` +
    `role: ${fm.role}\n` +
    `base: ${fm.base}\n` +
    `url: ${fm.url}\n` +
    "---\n" +
    body
  );
}
