/**
 * 資料夾 PR-3d：`list_trash`（tag `t`）與 `list_folders`（tag `f`）的 keyset 游標。`list_notes` 的既有游標（`tools/list-notes.ts`）不搬（無 tag、格式不變），只共用 `BASE64URL_RE` 的字元集檢查。
 * 不變量 S：這裡只擋「不是本站發的」（字元集、NUL、tag、段數）；各段的格式（UUID_RE、Date、kind 列舉）由呼叫端驗，
 * 參數化交給 drizzle。
 */
import { noNul } from "../notes/schemas.js";

const SEP = "|";
/** base64url 字元集（無 padding）。`list_notes` 的游標（`tools/list-notes.ts`）也用它先擋。 */
export const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

/** base64url(`${tag}|${parts.join("|")}`)。各段不得含 `|`（呼叫端只放 ISO 時間、UUID、kind）。 */
export function encodeKeysetCursor(tag: "t" | "f", parts: readonly string[]): string {
  return Buffer.from([tag, ...parts].join(SEP), "utf8").toString("base64url");
}

/**
 * 解不回來（非 base64url 內容、含 NUL、tag 不符、段數不符）→ null。各段的格式由呼叫端驗（UUID_RE、Date、kind 列舉）。
 * `Buffer.from(…, "base64url")` 會靜默略過字元集外的字元，所以字元集要先自己擋。
 */
export function decodeKeysetCursor(raw: string, tag: "t" | "f", n: number): string[] | null {
  if (!BASE64URL_RE.test(raw)) return null;
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  if (!noNul(decoded)) return null;
  const parts = decoded.split(SEP);
  if (parts.length !== n + 1 || parts[0] !== tag) return null;
  return parts.slice(1);
}

const CURSOR_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * 游標裡的時間段（本站只發 `Date#toISOString()` 的四位數年份形）→ Date；不是那個形就 null。
 * 往返檢查（`toISOString() === ts`）擋掉寬鬆格式與溢位的日期；四位數年份且 ≥ 1 擋掉 `+275760-…`、`-000001-…`、`0000-…` 這類
 * JS 收、pg `::timestamptz` 不收（或語意不同）的形——不擋的話它們會進 keyset 述詞，pg 報錯 → 模型收到 `internal` 而不是「游標壞了」。
 * `list_notes`、`list_trash`（與之後的 `list_folders`）共用。
 */
export function parseCursorTimestamp(ts: string): Date | null {
  if (!CURSOR_ISO_RE.test(ts)) return null;
  const at = new Date(ts);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== ts || at.getUTCFullYear() < 1) return null;
  return at;
}

/** 自 list-notes.ts 抽出的同一句（list_notes 改引用它，字面不變）。 */
export const BAD_CURSOR_MESSAGE = "The `cursor` value is not one this server issued. Omit it to start over.";
