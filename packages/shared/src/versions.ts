/**
 * 筆記版本歷史（spec 2026-10-09-note-versions-design.md §4、§6）。server 與 web 共用的常數、DTO 與名稱正規化。
 * 「基底」＝目前內容是從哪一版接著改（`notes.version_base_seq`）；null＝沒有基底（還沒存過、或套用後基底寫不回去）。
 */
/** A12：自動切版的安靜時間（有改動後 5 分鐘沒有新的落盤就切）。server 以 `idleMs` 注入覆寫。 */
export const VERSION_IDLE_MS = 5 * 60_000;
/** §6.3：版本名稱上限（code point）。 */
export const VERSION_NAME_MAX = 120;
/** §6.1：清單分頁。 */
export const VERSION_LIST_LIMIT_DEFAULT = 50;
export const VERSION_LIST_LIMIT_MAX = 100;
/** A11：站台清除設定 1 ≤ 全部保留天數 ≤ 每日一版天數 ≤ 3650（DB CHECK `site_settings_version_days_chk` 同值）。 */
export const VERSION_DAYS_MAX = 3650;
export const VERSION_KEEP_ALL_DAYS_DEFAULT = 7;
export const VERSION_DAILY_UNTIL_DAYS_DEFAULT = 30;

export type VersionKind = "auto" | "manual";

/** 每版一份編輯者名單（D2）；`handle` 是現值（刪除的使用者為 `""`），`agentLabel` 是切版當下的快照（AI 寫入才有）。 */
export interface VersionEditorDto {
  handle: string;
  agentLabel: string | null;
}

/** §6.1 清單的一列。`baseSeq`＝「從 vX 接著改」（只在基底不是當時最新版時有值）。 */
export interface VersionDto {
  id: string;
  seq: number;
  kind: VersionKind;
  name: string | null;
  editors: VersionEditorDto[];
  baseSeq: number | null;
  createdAt: string;
}

/** §6.1／§6.4：目前內容與版本的關係。`autoEnabled`＝A13 生效值（站台且空間）。 */
export interface VersionCurrentDto {
  baseSeq: number | null;
  dirty: boolean;
  nextSeq: number;
  autoEnabled: boolean;
}

/** `GET /api/notes/:id/versions`。`nextBefore` 非 null 時帶 `?before=` 取下一頁。 */
export interface VersionListDto {
  versions: VersionDto[];
  current: VersionCurrentDto;
  nextBefore: number | null;
}

/** `GET /api/notes/:id/versions/:seq`：只回快照；名稱等一律從清單取（§6.2）。`ydoc` 是 base64 的 `encodeStateAsUpdate`。 */
export interface VersionSnapshotDto {
  id: string;
  seq: number;
  ydoc: string;
}

/** `POST /api/notes/:id/versions`。`upgraded: true`＝內容與基底相同，沒有建新列，基底那版轉為手動並套名稱（A4）。 */
export type SavedVersionDto = VersionDto & { upgraded: boolean };

/** `POST /api/notes/:id/versions/:seq/apply` 的 body（§6.4，兩欄必填；`versionId` 是清單列的 `id`）。 */
export interface ApplyVersionBody {
  versionId: string;
  discardUnsaved: boolean;
}

/** `POST /api/notes/:id/versions/:seq/apply` 的回應。 */
export interface ApplyVersionResultDto {
  current: VersionCurrentDto;
}

/** `GET/PATCH /api/admin/versions/settings`（§6.7）。 */
export interface VersionSettingsDto {
  keepAllDays: number;
  dailyUntilDays: number;
  autoVersionsEnabled: boolean;
}

const UNSTORABLE = /\u0000|\p{Surrogate}/u;

/**
 * §6.3／§6.5：版本名稱正規化。去頭尾空白（`String.prototype.trim`，含全形空白）；空字串＝NULL；上限以 **code point** 計；
 * NUL 與落單代理拒絕（PostgreSQL text 存不下 → 22021，必須在進 SQL 前擋）。web 先驗、server 為準。
 */
export function normalizeVersionName(raw: string | null): { ok: true; name: string | null } | { ok: false } {
  if (raw === null) return { ok: true, name: null };
  const name = raw.trim();
  if (name === "") return { ok: true, name: null };
  if (UNSTORABLE.test(name) || [...name].length > VERSION_NAME_MAX) return { ok: false };
  return { ok: true, name };
}
