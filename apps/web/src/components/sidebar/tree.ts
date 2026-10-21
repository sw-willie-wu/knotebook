import type { GroupDto, NoteDto } from "@knotebook/shared";
import type { SidebarTab } from "@/lib/sidebar-tab";

/** 面板節點樹：群組節點（工作坊 tab）或筆記節點。 */
export type SidebarNode =
  | { kind: "group"; id: string; group: GroupDto; children: SidebarNode[] }
  | { kind: "note"; id: string; note: NoteDto };

export type NoteBucket = { kind: "group"; groupId: string } | { kind: "myNotes" } | { kind: "shared" };

/**
 * #175 spec §8.2 的分段表（搜尋與各 tab 共用同一份歸類）：
 * - `group` 非 null 且那個群組在 `groupIds`（＝我是成員）→ 該群組（不標角色，#182）；
 * - `group` 非 null 但群組不在 `groupIds`（剛被移出、清單未 refetch）→ 與我共享（兜底）；
 * - `role === "owner"` → 我的筆記；
 * - 其餘（逐人分享給我的個人筆記）→ 與我共享。
 * 群組筆記的 `role` 從不是 `owner`（群組持有、沒有個人 owner），所以第 2 列不必另寫分支——
 * 程式碼只要「在 `groupIds` 裡就進群組，否則看 role」。四列互斥且完整，所以 `aria-current` 至多命中一列。
 */
export function noteBucket(note: NoteDto, groupIds: ReadonlySet<string>): NoteBucket {
  if (note.group && groupIds.has(note.group.id)) return { kind: "group", groupId: note.group.id };
  return note.role === "owner" ? { kind: "myNotes" } : { kind: "shared" };
}

export interface SidebarPartition {
  myNotes: NoteDto[];
  shared: NoteDto[];
  /** 依 `groups` 的順序，每個群組一個桶（空桶也在，工作坊 tab 要渲染空群組）。 */
  byGroup: Map<string, NoteDto[]>;
}

export function partitionNotes(notes: NoteDto[], groups: GroupDto[]): SidebarPartition {
  const groupIds = new Set(groups.map((group) => group.id));
  const byGroup = new Map<string, NoteDto[]>(groups.map((group) => [group.id, []]));
  const myNotes: NoteDto[] = [];
  const shared: NoteDto[] = [];
  for (const note of notes) {
    const bucket = noteBucket(note, groupIds);
    if (bucket.kind === "group") byGroup.get(bucket.groupId)?.push(note);
    else if (bucket.kind === "myNotes") myNotes.push(note);
    else shared.push(note);
  }
  return { myNotes, shared, byGroup };
}

export const RECENT_TAB_LIMIT = 20;

function editedAtMs(note: NoteDto): number {
  const ms = Date.parse(note.lastEdited?.at ?? note.updatedAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** 依最後編輯時間（`lastEdited.at ?? updatedAt`）新到舊取前 `RECENT_TAB_LIMIT` 篇；
 * 同時間保持輸入順序、無法解析的排最後、不改動輸入陣列。 */
export function recentNotes(notes: NoteDto[]): NoteDto[] {
  return [...notes]
    .sort((a, b) => {
      const ka = editedAtMs(a);
      const kb = editedAtMs(b);
      return ka === kb ? 0 : ka > kb ? -1 : 1;
    })
    .slice(0, RECENT_TAB_LIMIT);
}

const noteNode = (note: NoteDto): SidebarNode => ({ kind: "note", id: note.id, note });

export function buildTabNodes(tab: SidebarTab, notes: NoteDto[], groups: GroupDto[]): SidebarNode[] {
  if (tab === "recent") return recentNotes(notes).map(noteNode);
  const parts = partitionNotes(notes, groups);
  if (tab === "myNotes") return parts.myNotes.map(noteNode);
  if (tab === "shared") return parts.shared.map(noteNode);
  return groups.map((group) => ({
    kind: "group",
    id: group.id,
    group,
    children: (parts.byGroup.get(group.id) ?? []).map(noteNode),
  }));
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * 筆記的位置標籤（spec §9-2）：搜尋結果與最近 tab 的第二行都只經這一支，
 * 步驟 3 在這裡加資料夾段。
 */
export function noteLocationLabel(note: NoteDto, groupIds: ReadonlySet<string>, t: Translate): string {
  const bucket = noteBucket(note, groupIds);
  if (bucket.kind === "myNotes") return t("sidebar.myNotes");
  if (bucket.kind === "group") return t("sidebar.locationGroup", { group: note.group?.name });
  return t("sidebar.locationShared", { role: t(`roles.${note.role}`) });
}
