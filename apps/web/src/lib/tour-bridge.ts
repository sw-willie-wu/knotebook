import type { BlockNoteEditor } from "@blocknote/core";
import type { SidebarTab } from "@/lib/sidebar-tab";
// 只 import 開關那支：外掛本體（`collab/tour-transaction-filter.ts`）會把 tiptap 與 ProseMirror 拉進首包。
import { setTourTransactionFilter } from "@/collab/tour-filter-flag";

/**
 * 功能導覽的登記處：導覽的遮罩與狀態住在 App 層（`AppShell` 會隨首頁↔筆記頁、筆記頁整頁載入換殼），
 * 拿不到 AppShell 裡的側欄控制、也拿不到只活在 `NoteEditor` 裡的編輯器，所以由它們掛載時登記上來。
 *
 * - 規則一致：先後掛上兩份時以最後登記的為準；撤銷只撤自己那份（比對登記時的物件），
 *   所以換殼時舊殼晚一步卸載也不會把新殼的登記清掉。
 * - 這支在首包（AppShell、NoteEditor 都會 import），所以只放登記狀態與幾支小函式，導覽本體不放這裡。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，repo 慣例（同 wikilink/menu.ts 的 EditorRef）
export type TourEditor = BlockNoteEditor<any, any, any>;

/** AppShell 交出的側欄控制。全部是穩定函式，呼叫當下才讀狀態。 */
export interface ShellControls {
  /** 切側欄 tab。⚠ 窄視窗時會順便打開抽屜（`SidebarTabActions.showTab`）。 */
  showTab: (tab: SidebarTab) => void;
  /** 在選取模式就結束並回 true；否則回 false。 */
  endSelectionIfActive: () => boolean;
  closeDrawer: () => void;
  /** 目前的側欄 tab。 */
  getTab: () => SidebarTab;
}

let shellControls: ShellControls | null = null;

/** 回傳撤銷函式；撤銷時登記處已換成別份就不動。 */
export function registerShellControls(controls: ShellControls): () => void {
  shellControls = controls;
  return () => {
    if (shellControls === controls) shellControls = null;
  };
}

export function getShellControls(): ShellControls | null {
  return shellControls;
}

export type EditorListener = (noteId: string, editor: TourEditor) => void;

interface EditorEntry {
  noteId: string;
  editor: TourEditor;
}

let editorEntry: EditorEntry | null = null;
const editableListeners = new Set<EditorListener>();
/** 已經通知過「第一次可編輯」的編輯器實例。 */
const notifiedEditable = new WeakSet<TourEditor>();

/**
 * 回傳撤銷函式；撤銷時登記處已換成別份就不動。撤銷一律關掉這份編輯器的交易過濾（不論登記處是否已換手）：
 * 撤登記之後導覽就拿不到這份編輯器，也就沒辦法再關掉它。直接改編輯器上的旗標、不 dispatch：撤銷時編輯器可能已經卸載。
 */
export function registerEditor(noteId: string, editor: TourEditor): () => void {
  const entry: EditorEntry = { noteId, editor };
  editorEntry = entry;
  return () => {
    setTourTransactionFilter(editor._tiptapEditor, false);
    if (editorEntry === entry) editorEntry = null;
  };
}

/** 只有登記的 noteId 等於傳入的 id 才回編輯器：導覽只能動它自己建的那篇。 */
export function getDemoEditor(noteId: string): TourEditor | null {
  return editorEntry !== null && editorEntry.noteId === noteId ? editorEntry.editor : null;
}

/**
 * 開關登記中編輯器的交易過濾（`collab/tour-transaction-filter.ts`：開著時擋下使用者改文件的交易，含輸入法組字）。
 * 守衛同 `getDemoEditor`：只有登記的 noteId 等於傳入的 id 才生效。回傳是否生效。
 */
export function setDemoTransactionFilter(noteId: string, on: boolean): boolean {
  const editor = getDemoEditor(noteId);
  if (editor === null) return false;
  setTourTransactionFilter(editor._tiptapEditor, on);
  return true;
}

/**
 * 每個編輯器實例第一次變成可編輯時呼叫一次；唯讀的永遠不呼叫。登記當下文件通常還沒同步，
 * 要等可編輯（＝已同步、角色可編輯）才看得到真正的內容。訂閱前就已可編輯的實例不會補通知，
 * 呼叫端要自己先看 `editor.isEditable`。回傳取消訂閱函式。
 */
export function onEditorEditable(fn: EditorListener): () => void {
  editableListeners.add(fn);
  return () => {
    editableListeners.delete(fn);
  };
}

/**
 * NoteEditor 在 `editable` 為 true 時呼叫；同一個實例只有第一次會轉給訂閱者。
 * 每支訂閱者各自接住錯誤、記到 console 再跑下一支：這裡在 NoteEditor 的 effect 裡跑，
 * 往外拋會讓筆記頁的錯誤邊界把整頁換成錯誤卡。
 */
export function notifyEditorEditable(noteId: string, editor: TourEditor): void {
  if (notifiedEditable.has(editor)) return;
  notifiedEditable.add(editor);
  for (const fn of [...editableListeners]) {
    try {
      fn(noteId, editor);
    } catch (err) {
      console.error(err);
    }
  }
}
