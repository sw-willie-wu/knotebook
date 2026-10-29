import "@/i18n/select-strings";
import type { GroupDto, NoteDto } from "@knotebook/shared";
import { canCreateAndEdit } from "@/lib/group-role";
import { selectionKey } from "@/lib/sidebar-selection";
import type { SidebarSectionKey } from "./collapse";
import type { SidebarNode } from "./tree";

/**
 * 一般 tab 選取模式的純函式（#181 PR-2c，spec §6.11、§9-4、§9-7；資料夾 spec §6.10 的「可見列」）。
 * 只准被 SelectLazy 鏈與測試 import（首包上限）。
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type SelectableTab = "recent" | "myNotes" | "workspace" | "shared";
export type SelectActionId = "move" | "copy" | "delete";

/** spec §6.11 的表（D-M3、D-W6）。PR-3b：workspace／shared 加 "move"（資料夾目的地）。 */
export const SELECT_ACTIONS: Readonly<Record<SelectableTab, readonly SelectActionId[]>> = {
  recent: ["copy", "delete"],
  myNotes: ["move", "copy", "delete"],
  workspace: ["copy", "delete"],
  shared: ["copy"],
};

/** 樹序的全部筆記（含收合群組裡的）。 */
export function tabNotes(nodes: readonly SidebarNode[]): NoteDto[] {
  return nodes.flatMap((node) => (node.kind === "note" ? [node.note] : tabNotes(node.children)));
}

/** 畫面上可見的筆記列的選取鍵（樹序）：「全選」與 Shift 範圍用；收合群組／資料夾的子樹跳過（群組查 `group:<id>`、資料夾查 `folder:<id>`）。 */
export function visibleNoteKeys(nodes: readonly SidebarNode[], isCollapsed: (key: SidebarSectionKey) => boolean): string[] {
  return nodes.flatMap((node) => {
    if (node.kind === "note") return [selectionKey({ kind: "note", id: node.id })];
    const sectionKey: SidebarSectionKey = node.kind === "folder" ? `folder:${node.id}` : `group:${node.id}`;
    return isCollapsed(sectionKey) ? [] : visibleNoteKeys(node.children, isCollapsed);
  });
}

/** 已選的筆記（樹序；**不看收合**——先勾再收合的仍算、仍會被處理）；不在樹裡的鍵不算。 */
export function selectedTabNotes(nodes: readonly SidebarNode[], keys: ReadonlySet<string>): NoteDto[] {
  return tabNotes(nodes).filter((note) => keys.has(selectionKey({ kind: "note", id: note.id })));
}

/** client 端預先排除：delete 看 `permissions.delete`；move 看 `permissions.moveToGroup && groupId === null`；copy 一律可。 */
export function partitionEligible(action: SelectActionId, notes: readonly NoteDto[]): { eligible: NoteDto[]; skipped: number } {
  const can = (note: NoteDto): boolean => {
    if (action === "delete") return note.permissions.delete;
    if (action === "move") return note.permissions.moveToGroup && note.groupId === null;
    return true;
  };
  const eligible = notes.filter(can);
  return { eligible, skipped: notes.length - eligible.length };
}

/** 目的地（spec §9-7：步驟 2 只有根）。PR-3b：加資料夾（根層一律省略 folderId，`null` 會 400）。 */
export type Destination = { kind: "personal" } | { kind: "group"; groupId: string; name: string };

export interface DestinationNode {
  /** "personal"、"g:<id>"；PR-3b "f:<id>"。 */
  key: string;
  destination: Destination;
  label: string;
  /** 步驟 2 根層＝label；PR-3b 完整路徑。 */
  accessibleName: string;
  /** 步驟 2 恆 false。 */
  disabled: boolean;
  /** 步驟 2 恆 []。 */
  children: readonly DestinationNode[];
}

function destinationNode(key: string, destination: Destination, t: Translate): DestinationNode {
  const label = destinationLabel(destination, t);
  return { key, destination, label, accessibleName: label, disabled: false, children: [] };
}

/** move：可移入的群組（`canCreateAndEdit`）；copy：我的筆記＋可用群組（我的筆記在前）。D2：move 不列我的筆記。 */
export function buildDestinationTree(input: { mode: "move" | "copy"; groups: readonly GroupDto[]; t: Translate }): DestinationNode[] {
  const groups = input.groups
    .filter(canCreateAndEdit)
    .map((group) => destinationNode(`g:${group.id}`, { kind: "group", groupId: group.id, name: group.name }, input.t));
  if (input.mode === "move") return groups;
  return [destinationNode("personal", { kind: "personal" }, input.t), ...groups];
}

/** 送 `/move`、`/copy` 的 body：personal → `{}`（沒有 groupId 鍵）。 */
export function destinationBody(dest: Destination): { groupId?: string } {
  return dest.kind === "group" ? { groupId: dest.groupId } : {};
}

export function destinationLabel(dest: Destination, t: Translate): string {
  return dest.kind === "group" ? dest.name : t("sidebar.myNotes");
}

/** 結果 toast 標題。done === 0 → `select.noneDone`（count＝skipped）；否則動作句＋（skipped > 0 時）略過後綴。 */
export function selectionResultTitle(
  input: { action: SelectActionId; done: number; skipped: number; destination: Destination | null },
  t: Translate,
): string {
  const { action, done, skipped, destination } = input;
  if (done === 0) return t("select.noneDone", { count: skipped });
  let title: string;
  if (action === "delete") title = t("select.trashed", { count: done });
  else if (destination === null) throw new Error(`selectionResultTitle: ${action} needs a destination`);
  else if (destination.kind === "personal") title = t("select.copiedToPersonal", { count: done });
  else title = t(action === "move" ? "select.moved" : "select.copiedToGroup", { count: done, group: destination.name });
  return skipped > 0 ? title + t("select.skippedSuffix", { count: skipped }) : title;
}
