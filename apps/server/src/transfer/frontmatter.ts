/**
 * bulk transfer spec 2026-11-02 §6.4：一篇檔案的 frontmatter（寫出）；§9.1：讀入（`readNoteFile`，PR-2）。
 *
 * 鍵序固定（§6.4 的表）：`knotebook`、`id`、`title`、`role`、`base`、`url`。`title` 一律 `JSON.stringify`（逸出 `"`、`\`、
 * 換行，所以永遠單行；讀法以 `"` 開頭 → `JSON.parse`，逐字往返）。其餘值是 uuid／角色名／16 hex／站內路徑，原樣寫。
 * 本文原樣接在第二條 `---` 之後（就是整篇匯出原文，不正規化）。
 */
import { UUID_RE } from "@knotebook/shared";
import { normalizeBody } from "./normalize.js";

/** §21 D4：檔案格式版本。 */
export const TRANSFER_FILE_VERSION = 1;

/** §9.1：frontmatter 的結束行 `---` 必須在前幾行內（1 起算第 200 行以內）。 */
export const FRONTMATTER_SCAN_LINES = 200;

export type ReadFile =
  | { kind: "existing"; id: string; base: string; title: string | undefined; body: string }
  | { kind: "new"; title: string | undefined; folderId: string | undefined; body: string }
  | { kind: "error"; message: string };

/** §9.1 三種讀法：`"` 開頭 → JSON；`'…'` → YAML 單引號（`''` 還原成 `'`）；其他 → 原樣。`raw` 已去頭尾空白。 */
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

/**
 * §9.1：讀入一篇檔（`text`＝已 UTF-8 解碼的整個 body）。全部是純計算、在任何 DB 查詢之前；錯誤訊息不帶任何值。
 * 順序（plan T2）：① 去 BOM、CRLF → LF ② 含 NUL → 錯 ③ 辨識 frontmatter ④ 只讀四鍵、重複 → 錯 ⑤ 三種讀法
 * ⑥ 值含 NUL／落單代理 → 錯 ⑦ 有 `id`：uuid（轉小寫）＋必須有 16 hex 的 `base` ⑧ 沒 `id`：新增，`folder_id` 轉小寫
 * ⑨ `title` 行存在但為空 → 錯 ⑩ 本文經 `normalizeBody`。
 */
export function readNoteFile(text: string): ReadFile {
  const s = text.replace(/^\ufeff/, "").replace(/\r\n/g, "\n");
  if (s.includes("\0")) return bad("檔案含 NUL 字元");
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
    if (end !== -1 && !lines.slice(1, end).some(l => l.startsWith("knotebook:") || l.startsWith("id:"))) end = -1;
  }
  if (end === -1) return { kind: "new", title: undefined, folderId: undefined, body: normalizeBody(s) };

  const vals = new Map<ReadKey, string>();
  for (const l of lines.slice(1, end)) {
    const c = l.indexOf(":");
    if (c === -1) continue;
    const k = l.slice(0, c);
    if (!(READ_KEYS as readonly string[]).includes(k)) continue;
    const key = k as ReadKey;
    if (vals.has(key)) return bad(`front matter 的 \`${key}\` 重複`);
    const p = parseScalar(l.slice(c + 1).trim());
    if (!p.ok || UNSTORABLE.test(p.value)) return bad(`front matter 的 \`${key}\` 格式不對`);
    vals.set(key, p.value);
  }
  const title = vals.get("title");
  if (title === "") return bad("title 不能是空的");
  const body = normalizeBody(lines.slice(end + 1).join("\n"));
  const id = vals.get("id");
  if (id !== undefined) {
    const lid = id.toLowerCase();
    if (!UUID_RE.test(lid)) return bad("front matter 的 `id` 格式不對");
    const base = vals.get("base");
    if (base === undefined) return bad("有 id 的檔案必須有 base");
    if (!BASE_RE.test(base)) return bad("front matter 的 `base` 格式不對");
    return { kind: "existing", id: lid, base, title, body };
  }
  const folder = vals.get("folder_id");
  let folderId: string | undefined;
  if (folder !== undefined) {
    folderId = folder.toLowerCase();
    if (!UUID_RE.test(folderId)) return bad("front matter 的 `folder_id` 格式不對");
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
