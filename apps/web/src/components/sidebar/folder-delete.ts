import "@/i18n/folder-strings";
import type { FolderDto, NoteDto } from "@knotebook/shared";
import { liveNotesUnder, subtreeFolderIds, type FolderIndex, type FolderSpaceKey } from "./folder-index";

/**
 * 刪除／移除資料夾確認框的純函式（資料夾 spec §6.6、plan 讀碼發現 15）。只准被 FolderLazy 鏈與測試 import。
 * 篇數＝快取中落在子樹、而且空間相符的活筆記（client 端算，server 是權威）。
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface FolderDeleteFacts {
  /** 子資料夾數（不含自己）。 */
  subfolders: number;
  liveNotes: NoteDto[];
  shared: boolean;
  /** 開著的那篇在子樹裡（讀碼發現 11）。 */
  containsOpen: boolean;
}

/** `spaceOf`＝筆記所在空間（呼叫端傳 `tree.ts` 的 `noteSpaceKey`；本模組不 import `tree.ts`）。 */
export function folderDeleteFacts(
  index: FolderIndex,
  folder: FolderDto,
  notes: readonly NoteDto[],
  openNoteId: string | null,
  spaceOf: (note: NoteDto) => FolderSpaceKey,
): FolderDeleteFacts {
  const liveNotes = liveNotesUnder(index, folder.id, notes, spaceOf);
  return {
    subfolders: subtreeFolderIds(index, folder.id).length - 1,
    liveNotes,
    shared: folder.space.kind === "shared",
    containsOpen: openNoteId !== null && liveNotes.some((note) => note.id === openNoteId),
  };
}

/** 串接規則（與語系無關）：前一段以「，」或「。」結尾 → 直接接；否則以一個半形空白接。 */
function joinParts(parts: readonly string[]): string {
  return parts.reduce((acc, part) => (acc === "" ? part : /[，。]$/u.test(acc) ? acc + part : `${acc} ${part}`), "");
}

/**
 * 內文：依 §6.6 與讀碼發現 15 串段。`retentionDays`：number＝天數、null＝不會自動清除、undefined＝還沒載到（用通用句）。
 * 一句裡有子資料夾數、篇數、天數三個會變形的數量，所以拆成各帶自己 `count` 的段再串。
 */
export function folderDeleteBody(facts: FolderDeleteFacts, retentionDays: number | null | undefined, t: Translate): string {
  const count = facts.liveNotes.length;
  if (facts.shared) return count > 0 ? t("folderDialogs.removeBody", { count }) : t("folderDialogs.removeBodyEmpty");
  if (count === 0) return facts.subfolders > 0 ? t("folderDialogs.emptyWithSub", { count: facts.subfolders }) : t("folderDialogs.empty");
  const purge =
    retentionDays === undefined
      ? t("folderDialogs.purgeUnknown")
      : retentionDays === null
        ? t("folderDialogs.purgeNever")
        : t("folderDialogs.purgeDays", { count: retentionDays });
  return joinParts([
    facts.subfolders > 0 ? t("folderDialogs.subfoldersPart", { count: facts.subfolders }) : t("folderDialogs.noSubfoldersPart"),
    t("folderDialogs.notesPart", { count }),
    purge,
    t("folderDialogs.restoreRebuilds"),
  ]);
}
