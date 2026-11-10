/**
 * 資料夾名稱。純函式。
 * 長度一律以 code point 計（與 DB `length()` 同單位，比照 `validateGroupName`）。
 */
import { FOLDER_NAME_MAX } from "@knotebook/shared";
import { hasUnstorableChar } from "../oauth/storable.js";

/**
 * 兩支正規化共用：C0（U+0000–U+001F）、DEL 與 C1（U+007F–U+009F）、行／段分隔（U+2028–U+2029）、
 * bidi 控制（U+202A–U+202E、U+2066–U+2069）。ZWNJ／ZWJ（U+200C／U+200D）保留——emoji 序列與部分文字需要。
 */
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
const CONTROL_CHAR_RE_G = new RegExp(CONTROL_CHAR_RE.source, "gu");
const LONE_SURROGATE_RE_G = /\p{Surrogate}/gu;

export type FolderNameResult = { ok: true; name: string } | { ok: false; reason: "unstorable" | "control" | "length" };

/** 截到 max 個 code point，再 trimEnd（截點落在空白上時不留尾端空白）。 */
function truncateCodePoints(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join("").trimEnd();
}

/** 使用者輸入：hasUnstorableChar → trim → 拒收上列控制字元 → NFC → 1–80 code point。 */
export function normalizeFolderName(raw: string): FolderNameResult {
  if (hasUnstorableChar(raw)) return { ok: false, reason: "unstorable" };
  const trimmed = raw.trim();
  if (CONTROL_CHAR_RE.test(trimmed)) return { ok: false, reason: "control" };
  const name = trimmed.normalize("NFC");
  const length = Array.from(name).length;
  if (length < 1 || length > FOLDER_NAME_MAX) return { ok: false, reason: "length" };
  return { ok: true, name };
}

/** 系統代建：去落單代理與上列控制字元 → NFC → trim → 空字串用 fallback → 截到 80 code point。永不失敗。 */
export function normalizeFolderNameLoose(raw: string, fallback: string): string {
  const cleaned = raw.replace(LONE_SURROGATE_RE_G, "").replace(CONTROL_CHAR_RE_G, "").normalize("NFC").trim();
  return truncateCodePoints(cleaned === "" ? fallback : cleaned, FOLDER_NAME_MAX);
}

/** n = 1 → base（≤ 80）；n ≥ 2 → `${截過的 base} (${n})` ≤ 80 code point；截完 trimEnd（不留「名  (2)」的雙空白）。 */
export function folderNameWithSuffix(base: string, n: number): string {
  if (n <= 1) return truncateCodePoints(base, FOLDER_NAME_MAX);
  const suffix = ` (${n})`;
  return `${truncateCodePoints(base, FOLDER_NAME_MAX - Array.from(suffix).length)}${suffix}`;
}

/** 刪群組轉移的固定名：`Accept-Language` 第一個語言標籤以 zh 開頭 →「群組」，其他（含沒帶）→「Group」。 */
export function fallbackGroupFolderName(acceptLanguage: string | undefined): string {
  const first = (acceptLanguage ?? "").split(",")[0]!.trim().toLowerCase();
  return first.startsWith("zh") ? "群組" : "Group";
}
