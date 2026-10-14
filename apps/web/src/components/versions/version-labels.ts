import type { TFunction } from "i18next";
import { derivedVersionName, type VersionBaseRefDto, type VersionCurrentDto, type VersionEditorDto } from "@knotebook/shared";

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

/** #272 §10.1（D5）：短 id＝uuid 前 7 碼（小寫）。 */
export function shortVersionId(id: string): string {
  return id.slice(0, 7).toLowerCase();
}

/** 顯示名：使用者取的名稱；沒有就由 uuid 推出的英文名（D6'：不存 DB、不分語系，`name` 仍是 null）。 */
export function versionName(v: { id: string; name: string | null }): string {
  return v.name ?? derivedVersionName(v.id);
}

/**
 * 版本的標籤「名稱 (短 id)」（#272 D5，取代 `vN`）：列第一行、比較下拉的觸發鈕與選項、套用鈕、對話框標題與 toast 一律用它。
 * 未命名版本的推名會撞名（4096 種）——短 id 才是辨識依據。
 */
export function versionLabel(v: { id: string; name: string | null }): string {
  return `${versionName(v)} (${shortVersionId(v.id)})`;
}

/**
 * 「沿自 …」的對象（#272 §10.1、D12）：未刪 → 標籤；已刪且有 id → 推名＋短 id＋「(deleted)」（使用者取的名稱不保留）；
 * 升級前就已刪除、沒有 id 的舊資料 →「a deleted version」。
 */
export function baseLabel(t: TFunction, base: VersionBaseRefDto): string {
  if (base.id === null) return t("versions.deletedVersion");
  if (base.deleted) return t("versions.deletedSuffix", { label: `${derivedVersionName(base.id)} (${shortVersionId(base.id)})` });
  return versionLabel({ id: base.id, name: base.name });
}

/**
 * `baseSeq` 有值時的「沿自 …」對象（目前狀態副標與列第二行共用）：`base` 依 §9 跟著 `baseSeq` 有值；萬一是 null，
 * 當成已刪除的版本顯示，不留空白。
 */
export function baseLabelOrDeleted(t: TFunction, base: VersionBaseRefDto | null): string {
  return base === null ? t("versions.deletedVersion") : baseLabel(t, base);
}

/**
 * 「目前狀態」副標三種（#258，Willie 2026-10-11）：只看 `baseSeq`／`dirty`，**不看清單**——清單可能被「僅手動」篩過。
 * #272：基底以 `current.base` 顯示（基底不在這一頁也有名稱；已刪除時標「(deleted)」）。
 */
export function currentSubtitle(t: TFunction, current: VersionCurrentDto): string {
  if (current.baseSeq === null) return t("versions.current.noBase");
  const label = baseLabelOrDeleted(t, current.base);
  return t(current.dirty ? "versions.current.dirty" : "versions.current.clean", { label });
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
