import { FOLDER_DEPTH_MAX, type FolderDto, type GroupDto, type NoteDto } from "@knotebook/shared";
import { canCreateAndEdit } from "@/lib/group-role";
import { folderDepth, folderPath, isInSubtree, spaceKeyOf, subtreeHeight, type FolderIndex, type FolderSpaceKey } from "./folder-index";

/**
 * 逐層目的地清單（資料夾 spec §6.11.1；⋮「移動到…／複製到…」子選單與選取模式目的地框共用）。
 * 首包模組：不 import 字串包（字串全在主檔 `folders.dest.*`、`note.menu.makeCopy`、`sidebar.*`）、不 import sidebar 畫面模組。
 * 一次只產一層：path 空＝第一層（上半部＝目前空間、分隔線、下半部＝其他空間）；點進空間或資料夾逐層堆疊。
 */

export type Translate = (key: string, options?: Record<string, unknown>) => string;

export type DestMode = "move" | "copy";
export type DestSpace = { kind: "personal" } | { kind: "shared" } | { kind: "group"; groupId: string; name: string };
/** 送出用的目的地。folder null＝該空間根層。makeCopy＝「建立副本」（落在各來源自己的資料夾）。 */
export type DestTarget = { kind: "makeCopy" } | { kind: "place"; space: DestSpace; folder: FolderDto | null };
export type DestPathStep = { kind: "space"; space: DestSpace } | { kind: "folder"; folderId: string };
export type DestDisabledReason = "current" | "self" | "tooDeep" | "crossSpace";
export type DestItem =
  | { kind: "back"; key: "back"; label: string; accessibleName: string }
  | { kind: "here" | "root" | "makeCopy"; key: string; label: string; accessibleName: string; target: DestTarget; disabled: DestDisabledReason | null }
  | {
      kind: "folder" | "space";
      key: string;
      label: string;
      accessibleName: string;
      target: DestTarget;
      drill: DestPathStep | null;
      disabled: DestDisabledReason | null;
    }
  | { kind: "separator"; key: string };

export interface DestSource {
  mode: DestMode;
  /** 上半部的空間；null＝沒有上半部。 */
  current: DestSpace | null;
  /** 上半部有沒有「建立副本」（只 copy 用）。 */
  makeCopy: boolean;
  /** 下半部，依序。 */
  others: readonly DestSpace[];
  /** 每個選取項目目前在 current 空間的位置（筆記＝folderId、資料夾＝parentId；null＝根層）。 */
  locations: readonly (string | null)[];
  /** 批次要搬的資料夾（單篇恆空）。 */
  movingFolders: readonly FolderDto[];
}

export function spaceKey(space: DestSpace): FolderSpaceKey {
  return space.kind === "group" ? `group:${space.groupId}` : space.kind;
}

const PERSONAL: DestSpace = { kind: "personal" };
const SHARED: DestSpace = { kind: "shared" };
const NO_FOLDERS: readonly FolderDto[] = [];

function groupSpace(group: GroupDto): DestSpace {
  return { kind: "group", groupId: group.id, name: group.name };
}

/**
 * 單篇（spec §6.11.2、§6.11.3 兩張表）。恆回 DestSource（不判空：判空要 index，呼叫端用 `isEmptyDestination`）。
 * groups＝useGroups() 的資料（未到給 []）；候選群組＝`canCreateAndEdit`，順序照 groups。
 */
export function noteDestSource(note: NoteDto, mode: DestMode, groups: readonly GroupDto[]): DestSource {
  const candidates = groups.filter(canCreateAndEdit);
  const base = { mode, locations: [note.folderId], movingFolders: NO_FOLDERS };
  // 自己的個人筆記：上半部＝我的筆記；下半部＝候選群組（copy 不列「我的筆記」，與上半部重複）。
  if (note.groupId === null && note.permissions.moveToGroup) {
    return { ...base, current: PERSONAL, makeCopy: mode === "copy", others: candidates.map(groupSpace) };
  }
  if (note.groupId !== null) {
    const groupId = note.groupId;
    const own = groups.find((group) => group.id === groupId);
    const ownSpace: DestSpace = { kind: "group", groupId, name: own?.name ?? note.group?.name ?? "" };
    // 群組筆記不能離開群組；本群組內移動的判準＝permissions.edit（§5.6 放置權）。
    if (mode === "move") return { ...base, current: note.permissions.edit ? ownSpace : null, makeCopy: false, others: [] };
    const others = [PERSONAL, ...candidates.filter((group) => group.id !== groupId).map(groupSpace)];
    const ownIsCandidate = own !== undefined && canCreateAndEdit(own);
    return { ...base, current: ownIsCandidate ? ownSpace : null, makeCopy: ownIsCandidate, others };
  }
  // 共享筆記：move＝自己的共享私人資料夾（只是自己的分類）；copy＝沒有上半部，「我的筆記」＋候選群組。
  if (mode === "move") return { ...base, current: SHARED, makeCopy: false, others: [] };
  return { ...base, current: null, makeCopy: false, others: [PERSONAL, ...candidates.map(groupSpace)] };
}

/** 「整項不渲染／disabled」的唯一判準（總管裁定 2026-10-29 I2）。 */
export function isEmptyDestination(source: DestSource, index: FolderIndex, t: Translate): boolean {
  return buildDestinationLevel({ source, path: [], index, t }).length === 0;
}

function spaceLabel(space: DestSpace, t: Translate): string {
  if (space.kind === "personal") return t("sidebar.myNotes");
  if (space.kind === "shared") return t("sidebar.shared");
  return space.name;
}

/**
 * 反灰（只對 move；copy 一律可按）。target folder null＝某空間根層（深度 0）。
 * `leafOrHere`：只有「放進這裡」與沒有子資料夾的資料夾項才會因「就是所在處」反灰（有子資料夾的要能點進去）。
 */
function disabledFor(source: DestSource, index: FolderIndex, folder: FolderDto | null, leafOrHere: boolean): DestDisabledReason | null {
  if (source.mode !== "move") return null;
  if (source.movingFolders.length > 0) {
    if (folder !== null && source.movingFolders.some((moving) => isInSubtree(index, moving.id, folder.id))) return "self";
    const height = Math.max(...source.movingFolders.map((moving) => subtreeHeight(index, moving.id)));
    const depth = folder === null ? 0 : folderDepth(index, folder.id);
    if (depth + height > FOLDER_DEPTH_MAX) return "tooDeep";
  }
  if (folder !== null && leafOrHere && source.locations.length > 0 && source.locations.every((location) => location === folder.id)) {
    return "current";
  }
  return null;
}

function withDrill(
  base: { kind: "folder" | "space"; key: string; label: string; target: DestTarget; disabled: DestDisabledReason | null },
  canDrill: boolean,
  drillTo: DestPathStep,
  t: Translate,
): DestItem {
  const drill = canDrill && base.disabled === null ? drillTo : null;
  const accessibleName = drill === null ? base.label : t("folders.dest.openLevel", { name: base.label });
  return { ...base, accessibleName, drill };
}

function folderItem(source: DestSource, index: FolderIndex, space: DestSpace, folder: FolderDto, t: Translate): DestItem {
  const hasChildren = index.children(spaceKey(space), folder.id).length > 0;
  return withDrill(
    {
      kind: "folder",
      key: `folder:${folder.id}`,
      label: folder.name,
      target: { kind: "place", space, folder },
      disabled: disabledFor(source, index, folder, !hasChildren),
    },
    hasChildren,
    { kind: "folder", folderId: folder.id },
    t,
  );
}

function rootItem(source: DestSource, index: FolderIndex, space: DestSpace, t: Translate): DestItem {
  const label = t("folders.dest.topLevel");
  return {
    kind: "root",
    key: "root",
    label,
    accessibleName: label,
    target: { kind: "place", space, folder: null },
    disabled: disabledFor(source, index, null, false),
  };
}

function backItem(t: Translate): DestItem {
  const label = t("folders.dest.back");
  return { kind: "back", key: "back", label, accessibleName: label };
}

function firstLevel(source: DestSource, index: FolderIndex, t: Translate): DestItem[] {
  const upper: DestItem[] = [];
  if (source.mode === "copy" && source.makeCopy) {
    const label = t("note.menu.makeCopy");
    upper.push({ kind: "makeCopy", key: "makeCopy", label, accessibleName: label, target: { kind: "makeCopy" }, disabled: null });
  }
  const current = source.current;
  if (current !== null) {
    if (!source.locations.every((location) => location === null)) upper.push(rootItem(source, index, current, t));
    for (const folder of index.children(spaceKey(current), null)) upper.push(folderItem(source, index, current, folder, t));
  }
  // 資料夾只能在同一個空間內移動（D4）：批次搬資料夾時下半部空間反灰、不能點進。
  const crossSpace = source.mode === "move" && source.movingFolders.length > 0;
  const lower = source.others.map((space) =>
    withDrill(
      {
        kind: "space",
        key: `space:${spaceKey(space)}`,
        label: spaceLabel(space, t),
        target: { kind: "place", space, folder: null },
        disabled: crossSpace ? "crossSpace" : null,
      },
      index.children(spaceKey(space), null).length > 0,
      { kind: "space", space },
      t,
    ),
  );
  if (upper.length > 0 && lower.length > 0) return [...upper, { kind: "separator", key: "separator" }, ...lower];
  return [...upper, ...lower];
}

type Resolved = { kind: "space"; space: DestSpace } | { kind: "folder"; space: DestSpace; folder: FolderDto };

/** 走 path；遇到已不存在的資料夾、或已不在 source 的空間 → 截到最後一個仍有效的前綴。 */
function resolvePath(source: DestSource, path: readonly DestPathStep[], index: FolderIndex): Resolved | null {
  let last: Resolved | null = null;
  for (const step of path) {
    if (step.kind === "space") {
      const key = spaceKey(step.space);
      const space = source.others.find((other) => spaceKey(other) === key);
      if (space === undefined) break;
      last = { kind: "space", space };
      continue;
    }
    const folder = index.byId.get(step.folderId);
    if (folder === undefined) break;
    const folderKey = spaceKeyOf(folder.space);
    const space =
      [source.current, ...source.others].find((candidate): candidate is DestSpace => candidate !== null && spaceKey(candidate) === folderKey) ??
      null;
    if (space === null) break;
    last = { kind: "folder", space, folder };
  }
  return last;
}

/** 某一層的項目。path 指到已不存在的資料夾 → 截到最後一個仍存在的前綴（快取重抓後）。 */
export function buildDestinationLevel(input: {
  source: DestSource;
  path: readonly DestPathStep[];
  index: FolderIndex;
  t: Translate;
}): DestItem[] {
  const { source, path, index, t } = input;
  const at = resolvePath(source, path, index);
  if (at === null) return firstLevel(source, index, t);
  // 第二層起：「‹ 返回」恆第一項、不加分隔線。
  if (at.kind === "space") {
    return [
      backItem(t),
      rootItem(source, index, at.space, t),
      ...index.children(spaceKey(at.space), null).map((folder) => folderItem(source, index, at.space, folder, t)),
    ];
  }
  const label = t(source.mode === "move" ? "folders.dest.moveHere" : "folders.dest.copyHere");
  return [
    backItem(t),
    {
      kind: "here",
      key: "here",
      label,
      accessibleName: label,
      target: { kind: "place", space: at.space, folder: at.folder },
      disabled: disabledFor(source, index, at.folder, true),
    },
    ...index.children(spaceKey(at.space), at.folder.id).map((folder) => folderItem(source, index, at.space, folder, t)),
  ];
}

/**
 * path 裡仍有效的前綴。`buildDestinationLevel` 遇到失效的步（資料夾被刪、群組不見）會**靜默截斷**到最後一個有效的前綴，
 * 所以「目前在第幾層」不能看 `path.length`（T2 交接）：「返回」「點進」一律從這個前綴接，「返回」才恰好退一個看得到的層。
 * 判法：第 k 層建出來的「‹ 返回」下一項（空間層＝根目錄、資料夾層＝移動到這裡／複製到這裡）就是第 k 步本身。
 * ⋮ 的逐層子選單（`GroupTransfer`）與選取模式的目的地框（`SelectActionBar`）共用。
 */
export function livePath(source: DestSource, path: readonly DestPathStep[], index: FolderIndex, t: Translate): readonly DestPathStep[] {
  for (let k = 0; k < path.length; k += 1) {
    const step = path[k];
    const [first, anchor] = buildDestinationLevel({ source, path: path.slice(0, k + 1), index, t });
    const at =
      first?.kind === "back" &&
      anchor !== undefined &&
      (anchor.kind === "root" || anchor.kind === "here") &&
      anchor.target.kind === "place" &&
      (step.kind === "space"
        ? anchor.kind === "root" && spaceKey(anchor.target.space) === spaceKey(step.space)
        : anchor.kind === "here" && anchor.target.folder?.id === step.folderId);
    if (!at) return path.slice(0, k);
  }
  return path;
}

/** 完整路徑字串（確認框、可及名稱）：個人「我的筆記 › A › B」、群組「研發組 › A」、共享「與我共享 › A」；根層＝空間名。 */
export function destinationPathLabel(space: DestSpace, folder: FolderDto | null, index: FolderIndex, t: Translate): string {
  const head = spaceLabel(space, t);
  if (folder === null) return head;
  const names = folderPath(index, folder.id) ?? [folder.name];
  return [head, ...names].join(" › ");
}

/** toast「已移到「{{name}}」」的 name：資料夾名；根層＝「根目錄」。 */
export function destinationShortLabel(folder: FolderDto | null, t: Translate): string {
  return folder === null ? t("folders.dest.topLevel") : folder.name;
}
