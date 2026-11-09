/**
 * bulk transfer spec 2026-11-02 §6.2、§6.3：下載包的目錄配置與檔名（純函式，不碰 DB）。
 *
 * - 頂層三目錄固定英文（§21 D7）；範圍縮小時路徑不變：命名在完整可見集合上算、再依範圍篩（見 `buildLayout`）。
 * - 檔名只是外觀：寫回只認 frontmatter 的 `id`。路徑長度不保證在 Windows 260 內。
 * - 標題經 `sanitizeTitle`；資料夾名、群組名經 `sanitizeSegment`（plan §0.1-5、gate r1 m10）。
 * - 判重（§6.3-7、-9；plan §0.1-6）：每個目錄一個 casefold 鍵集合；**先配檔案、再配資料夾**（撞名時資料夾讓）；
 *   同類依 `createdAt`、`id` 排序，撞名時在基名後加 ` (n)`（n 從 2 起找第一個空位）。檔與資料夾同一個命名空間。
 * - 排序：`dirs` 以完整路徑的 code unit 序（JS `<`）。
 */
import type { FolderSpaceDto } from "@knotebook/shared";
import type { BulkRange } from "../auth/transfer-token.js";

export const TOP_DIRS = { personal: "My notes", group: "Groups", shared: "Shared with me" } as const;
export type TopDirKey = keyof typeof TOP_DIRS;

/** §6.3-6：每段最多幾個 code point（截完再 trimEnd；尾碼另計）。 */
export const SEGMENT_MAX = 64;

/**
 * §6.3-1：換成 `_` 的字元——`< > : " / \ | ? *`、C0（U+0000–001F）、DEL、bidi 控制（U+202A–202E、U+2066–2069）、
 * 零寬（U+200B–200F、U+FEFF）；再加 `$`、反引號、`!`（8000 探索測試 N1：`next` 叫模型把路徑填進雙引號裡的 `"<file>"`，
 * 這三個字元在雙引號內仍會被 shell 展開——`$(…)`、反引號會執行指令，`$VAR` 會被換掉，`!` 在互動 bash 是歷史展開）。
 */
const ILLEGAL = /[<>:"/\\|?*$`!\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/gu;
/** §6.3-3：Windows 保留名（不分大小寫、含帶副檔名形）。 */
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/**
 * §6.3 規則 1–6（不含規則 8），順序寫死：① NFC ② 非法字元 → `_` ③ 開頭 `.` → `_` ④ 截到 64 code point（不切代理對）
 * 後 trimEnd ⑤ 去尾端 `.` 與空白、空了 → `_` ⑥ 保留名前加 `_`。
 */
export function sanitizeSegment(raw: string): string {
  let s = raw.normalize("NFC");
  s = s.replace(ILLEGAL, "_");
  if (s.startsWith(".")) s = "_" + s.slice(1);
  const cps = Array.from(s);
  if (cps.length > SEGMENT_MAX) s = cps.slice(0, SEGMENT_MAX).join("").trimEnd();
  s = s.replace(/[\s.]+$/u, "");
  if (s === "") s = "_";
  if (RESERVED.test(s)) s = "_" + s;
  return s;
}

/** `sanitizeSegment`＋§6.3-8：清洗後空或只由 `_` 組成 → `Untitled`。 */
export function sanitizeTitle(raw: string): string {
  const s = sanitizeSegment(raw);
  return /^_+$/.test(s) ? "Untitled" : s;
}

/** §6.3-7 的判重鍵：NFC 後以 `toUpperCase().toLowerCase()` 近似 casefold（`ß`→`ss` 會多判重，無害）。 */
export function casefoldKey(s: string): string {
  return s.normalize("NFC").toUpperCase().toLowerCase();
}

export interface LayoutNote {
  id: string;
  title: string;
  createdAt: Date;
  space: "personal" | "shared" | "group";
  groupId: string | null;
  /** personal／group：筆記的資料夾；shared：讀者的 placement（`viewerFolderId`）。 */
  folderId: string | null;
}
export interface LayoutFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
  space: FolderSpaceDto;
}
export interface LayoutGroup {
  id: string;
  name: string;
  createdAt: Date;
}
export interface Layout {
  /** 範圍內的目錄，依 path 排序；不帶尾斜線。頂層三目錄 `id: null, space: null`；群組目錄 `id: null, space: {kind:"group"}`。 */
  dirs: Array<{ path: string; id: string | null; space: FolderSpaceDto | null }>;
  /** 範圍內的筆記：noteId → 檔案路徑（含 `.md`）。 */
  files: Map<string, string>;
}

interface DirNode {
  /** 這一段的最終名字（已清洗、已判重）；頂層目錄是固定英文。 */
  name: string;
  parent: DirNode | null;
  id: string | null;
  space: FolderSpaceDto | null;
  path: string;
  childFolders: Array<{ folder: LayoutFolder; node: DirNode }>;
  childNotes: LayoutNote[];
  childGroups: Array<{ group: LayoutGroup; node: DirNode }>;
}

const byCreated = <T extends { createdAt: Date; id: string }>(a: T, b: T): number => {
  const d = a.createdAt.getTime() - b.createdAt.getTime();
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** 在一個目錄的鍵集合裡為 `base`（＋`ext`）找第一個不撞的名字，並登記鍵。 */
function claim(taken: Set<string>, base: string, ext: string): string {
  let name = base + ext;
  for (let n = 2; taken.has(casefoldKey(name)); n++) name = `${base} (${n})${ext}`;
  taken.add(casefoldKey(name));
  return name;
}

/** `node` 是 `anc` 本身或在它底下。 */
function within(node: DirNode, anc: DirNode): boolean {
  for (let p: DirNode | null = node; p !== null; p = p.parent) if (p === anc) return true;
  return false;
}

/**
 * **命名一律在完整的可見集合上算，再依範圍篩輸出**（plan §0.1-5；T1–T6 審查 I1）：範圍縮小時，範圍內每一項的路徑與
 * `all` 那份逐字相同（同名群組、清洗後撞名、規則 9 都一樣）——否則先抓全部、再抓某個群組的 agent，會讓兩篇不同的筆記
 * 落到同一個本機路徑而靜默覆蓋。
 *
 * 呼叫端（T9／T10）一律傳**讀者可見的完整集合**：全部可見筆記的中繼資料（`all` 範圍那一支查詢）、全部可見資料夾、
 * 全部可讀群組；`range` 決定輸出哪些。範圍所指的群組／資料夾不在輸入裡 → 丟錯（呼叫端先判「範圍已看不到」→ 403）。
 *
 * 範圍涵蓋（plan §0.1-5）：`all`＝三個頂層目錄與全部；`personal`／`shared`＝該頂層目錄與其下；`group`＝`Groups`＋該群組
 * 目錄與其下；`folder`＝該資料夾的祖先鏈（含頂層目錄與群組目錄）＋子樹，筆記只取放在子樹裡的（shared 筆記看讀者的 placement）。
 */
export function buildLayout(input: { notes: LayoutNote[]; folders: LayoutFolder[]; groups: LayoutGroup[]; range: BulkRange }): Layout {
  const mk = (name: string, parent: DirNode | null, id: string | null, space: FolderSpaceDto | null): DirNode => ({
    name,
    parent,
    id,
    space,
    path: "",
    childFolders: [],
    childNotes: [],
    childGroups: [],
  });
  const tops: Record<TopDirKey, DirNode> = {
    personal: mk(TOP_DIRS.personal, null, null, null),
    group: mk(TOP_DIRS.group, null, null, null),
    shared: mk(TOP_DIRS.shared, null, null, null),
  };

  const groupNodes = new Map<string, DirNode>();
  for (const g of input.groups) {
    const node = mk("", tops.group, null, { kind: "group", groupId: g.id });
    groupNodes.set(g.id, node);
    tops.group.childGroups.push({ group: g, node });
  }
  const spaceRoot = (space: FolderSpaceDto): DirNode => {
    if (space.kind === "personal") return tops.personal;
    if (space.kind === "shared") return tops.shared;
    const g = groupNodes.get(space.groupId);
    if (g === undefined) throw new Error("buildLayout: group folder whose group is not in the layout input");
    return g;
  };

  const folderNodes = new Map<string, DirNode>();
  for (const f of input.folders) folderNodes.set(f.id, mk("", null, f.id, f.space));
  for (const f of input.folders) {
    const node = folderNodes.get(f.id)!;
    // 父資料夾不在輸入裡（理論上不會：呼叫端給完整的可見集合）→ 放空間頂層。
    const parent = (f.parentId !== null ? folderNodes.get(f.parentId) : undefined) ?? spaceRoot(f.space);
    node.parent = parent;
    parent.childFolders.push({ folder: f, node });
  }
  // 父鏈不得成環（資料夾樹由 DB trigger 保證；這裡只防呼叫端給錯）。
  for (const node of folderNodes.values()) {
    let depth = 0;
    for (let p: DirNode | null = node; p !== null; p = p.parent) {
      if (++depth > folderNodes.size + 3) throw new Error("buildLayout: folder parent chain has a cycle");
    }
  }

  const noteDir = new Map<string, DirNode>();
  for (const n of input.notes) {
    const inFolder = n.folderId !== null ? folderNodes.get(n.folderId) : undefined;
    let dir: DirNode;
    if (inFolder !== undefined) dir = inFolder;
    else if (n.space === "group") {
      const g = n.groupId !== null ? groupNodes.get(n.groupId) : undefined;
      if (g === undefined) throw new Error("buildLayout: group note whose group is not in the layout input");
      dir = g;
    } else dir = tops[n.space];
    dir.childNotes.push(n);
    noteDir.set(n.id, dir);
  }

  // ① 命名：在完整的樹上由上而下，每個目錄先配檔案、再配子目錄（群組目錄只在 Groups/ 底下）。
  const notePath = new Map<string, string>();
  const allDirs: DirNode[] = [];
  const visit = (dir: DirNode, path: string): void => {
    dir.path = path;
    allDirs.push(dir);
    const taken = new Set<string>();
    for (const n of [...dir.childNotes].sort(byCreated)) notePath.set(n.id, `${path}/${claim(taken, sanitizeTitle(n.title), ".md")}`);
    const subdirs: DirNode[] = [];
    for (const { group, node } of [...dir.childGroups].sort((a, b) => byCreated(a.group, b.group))) {
      node.name = claim(taken, sanitizeSegment(group.name), "");
      subdirs.push(node);
    }
    for (const { folder, node } of [...dir.childFolders].sort((a, b) => byCreated(a.folder, b.folder))) {
      node.name = claim(taken, sanitizeSegment(folder.name), "");
      subdirs.push(node);
    }
    for (const sub of subdirs) visit(sub, `${path}/${sub.name}`);
  };
  for (const key of ["personal", "group", "shared"] as const) visit(tops[key], tops[key].name);

  // ② 依範圍篩：`dirIn` 決定哪些目錄寫成目錄項，`noteIn` 決定哪些筆記的目錄（放的位置）落在範圍裡。
  const range = input.range;
  let dirIn: (d: DirNode) => boolean;
  let noteIn: (d: DirNode) => boolean;
  if (range.kind === "all") {
    dirIn = () => true;
    noteIn = () => true;
  } else if (range.kind === "personal" || range.kind === "shared") {
    const top = tops[range.kind];
    dirIn = d => within(d, top);
    noteIn = dirIn;
  } else if (range.kind === "group") {
    const g = groupNodes.get(range.groupId);
    if (g === undefined) throw new Error("buildLayout: range group is not in the layout input");
    dirIn = d => d === tops.group || within(d, g);
    noteIn = d => within(d, g);
  } else {
    const f = folderNodes.get(range.folderId);
    if (f === undefined) throw new Error("buildLayout: range folder is not in the layout input");
    dirIn = d => within(f, d) || within(d, f);
    noteIn = d => within(d, f);
  }

  const dirs: Layout["dirs"] = allDirs.filter(dirIn).map(d => ({ path: d.path, id: d.id, space: d.space }));
  dirs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files = new Map<string, string>();
  for (const n of input.notes) if (noteIn(noteDir.get(n.id)!)) files.set(n.id, notePath.get(n.id)!);
  return { dirs, files };
}
