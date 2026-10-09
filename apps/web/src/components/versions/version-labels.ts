import type { TFunction } from "i18next";
import type { VersionCurrentDto, VersionEditorDto } from "@knotebook/shared";

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
