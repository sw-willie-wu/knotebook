import type { TFunction } from "i18next";
import type { VersionCurrentDto, VersionEditorDto } from "@knotebook/shared";

/**
 * 切換鈕的按下態（橫幅、整頁共用）。rev 10：橫幅底色是品牌色 tint `bg-brand-soft`（14%），按下態要在它上面看得出，
 * 所以是再深一階的 `bg-brand/25`（整頁頁首是 `bg-card`，同一組在白底上也只是淡品牌色，不另開常數）。
 * 用 brand 而非 primary：`--primary` 是中性近黑，會渲染成灰。
 * 一定要連 `hover:` 一起給（final fix 2）：ghost 變體的 `hover:bg-accent` 會在滑鼠停在按下鈕上時蓋過按下底色、
 * 看起來像沒按下。帶上 `hover:bg-brand/35` 後，`cn`（tailwind-merge）會把 ghost 的 `hover:bg-accent` 換掉。
 *
 * 閒置鈕的 hover 也不能用 ghost 的 `hover:bg-accent`：亮色 `--accent` 是 oklch L 0.94 的灰，而橫幅（`bg-brand-soft`，
 * 14% 品牌 tint 疊在頁面底色上）的合成色約 L 0.93，兩者幾乎一樣，hover 看不出變化；所以在這種底色上 hover 改成品牌 tint
 * （`TINT_HOVER_CLASS`，同樣靠 `cn` 換掉 ghost 的 `hover:bg-accent`）。
 * 階梯：閒置 → hover 15% → 按下 25% → 按下後 hover 35%（相鄰兩階的 alpha 差拉大，5 個百分點的差距看不出來）。
 */
export const TINT_HOVER_CLASS = "hover:bg-brand/15";
export const PRESSED_CLASS = "bg-brand/25 hover:bg-brand/35";

/** 版本的短標籤：`vN`，有名稱時 `vN 名稱`（同 `VersionRowContent` 第一行；比較對象下拉的觸發鈕與選項用）。 */
export function versionLabel(version: { seq: number; name: string | null }): string {
  return version.name !== null ? `v${version.seq} ${version.name}` : `v${version.seq}`;
}

/** 「目前狀態」副標五種（spec §8.2；判斷順序照 spec 逐字）。`latestSeq`＝已載入清單的第一列 seq（清單空＝null）。 */
export function currentSubtitle(t: TFunction, current: VersionCurrentDto, latestSeq: number | null): string {
  if (latestSeq === null) return t("versions.current.none");
  if (current.baseSeq === null) return t("versions.current.noBase");
  if (!current.dirty) return t("versions.current.clean", { seq: current.baseSeq });
  if (current.baseSeq === latestSeq) return t("versions.current.dirtyLatest", { seq: current.baseSeq });
  return t("versions.current.dirtyFrom", { seq: current.baseSeq });
}

/** 「handle (agent)」逗號相接；刪除的使用者（handle ""）換成替代字。 */
export function editorsText(t: TFunction, editors: VersionEditorDto[]): string {
  return editors
    .map((e) => {
      const who = e.handle === "" ? t("versions.deletedUser") : e.handle;
      return e.agentLabel === null ? who : `${who} (${e.agentLabel})`;
    })
    .join(", ");
}

export function formatVersionTime(iso: string, language: string): string {
  return new Date(iso).toLocaleString(language, { dateStyle: "short", timeStyle: "short" });
}

/** 綠點色：沿用 ConnectionBadge 的語意綠（起草裁定 7）——版本 UI 唯一的顏色。 */
export const BASE_DOT_COLOR = "oklch(0.8 0.17 152)";
