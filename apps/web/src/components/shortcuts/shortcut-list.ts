/**
 * 快捷鍵介紹頁的條目資料與站台能力篩選（plan 2026-11-02-shortcuts-modal）。
 *
 * ⚠ 只准被 `ShortcutsLazy.tsx` 與測試 import（首包上限：清單資料不進首包）。
 * ⚠ 這裡的每個 id 都要有一支在真瀏覽器跑過的 e2e，test 名稱尾端帶 `[sc:<id>]`（K15；`shortcut-e2e-coverage.test.ts` 雙向核對）；
 *   說明文字（`i18n/shortcuts.*.json` 的 `items.<id>.desc`）只寫 e2e 量到的行為。見 e2e/tests/43-shortcuts.spec.ts。
 */
export const SHORTCUT_CATEGORIES = ["global", "typing", "markdown", "formatting", "columns", "sidebar", "presentation", "ai", "mouse"] as const;
export type ShortcutCategory = (typeof SHORTCUT_CATEGORIES)[number];

/** `Mod`＝Ctrl（Mac 顯示 ⌘）；其餘單字母直接寫字母。`Click` 是滑鼠點擊（文字走字串包）。 */
export type KeyToken =
  | "Mod"
  | "Shift"
  | "Alt"
  | "Enter"
  | "Space"
  | "Esc"
  | "Tab"
  | "Backspace"
  | "Delete"
  | "Click"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | (string & {});

/**
 * 一個「按法」。combo＝同時按（每個 token 一個 <kbd>）；typed＝依序打出的字（一個 <kbd>，後面可接 Space）；
 * action＝滑鼠動作（沒有 <kbd>，名稱本身就是說明）。
 */
export type ShortcutKeys = { kind: "combo"; keys: readonly KeyToken[] } | { kind: "typed"; text: string; thenSpace?: boolean } | { kind: "action" };

/** 站台能力：`ai`＝有可用的 AI 動作；`aiInstruct`＝其中有「自由指令」（kind === "instruct"）。 */
export type SiteCapability = "ai" | "aiInstruct";

export interface ShortcutEntry {
  /** i18n：`shortcutsGuide.items.<id>.name`／`.desc`；e2e 標籤 `[sc:<id>]`。 */
  id: string;
  category: ShortcutCategory;
  /** 多種按法並列（例：Mod+Y、Mod+Shift+Z）。 */
  keys: readonly ShortcutKeys[];
  /** Mac 另列（redo 只列 ⌘⇧Z）。 */
  macKeys?: readonly ShortcutKeys[];
  /** keys 有兩個以上時必填：or＝同一件事的不同按法；pair＝各按法是不同動作（K9）。 */
  sep?: "or" | "pair";
  requires?: SiteCapability;
}

const combo = (...keys: KeyToken[]): ShortcutKeys => ({ kind: "combo", keys });
const typed = (text: string, thenSpace = false): ShortcutKeys => ({ kind: "typed", text, thenSpace });
const action: ShortcutKeys = { kind: "action" };

export const SHORTCUTS: readonly ShortcutEntry[] = [
  // 通用
  { id: "search", category: "global", keys: [combo("Mod", "K")] },
  { id: "searchClear", category: "global", keys: [combo("Esc")] },
  { id: "saveVersion", category: "global", keys: [combo("Mod", "S")] },
  { id: "openSettings", category: "global", keys: [combo("Mod", ",")] },
  { id: "openShortcuts", category: "global", keys: [combo("Mod", "/")] },
  // 打字觸發
  { id: "slashMenu", category: "typing", keys: [typed("/")] },
  { id: "wikilink", category: "typing", keys: [typed("[[")] },
  { id: "markdownLink", category: "typing", keys: [typed("[…](…)")] },
  // Markdown 速記
  { id: "heading", category: "markdown", keys: [typed("#", true), typed("##", true), typed("###", true)], sep: "pair" },
  { id: "bullet", category: "markdown", keys: [typed("-", true), typed("*", true), typed("+", true)], sep: "or" },
  { id: "numbered", category: "markdown", keys: [typed("1.", true)] },
  { id: "checklist", category: "markdown", keys: [typed("[]", true), typed("[x]", true)], sep: "pair" },
  { id: "quote", category: "markdown", keys: [typed(">", true)] },
  { id: "codeBlock", category: "markdown", keys: [typed("```", true)] },
  { id: "divider", category: "markdown", keys: [typed("---")] },
  { id: "inlineCode", category: "markdown", keys: [typed("`…`")] },
  { id: "inlineMarks", category: "markdown", keys: [typed("**…**"), typed("*…*"), typed("~~…~~")], sep: "pair" },
  // 文字格式
  { id: "bold", category: "formatting", keys: [combo("Mod", "B")] },
  { id: "italic", category: "formatting", keys: [combo("Mod", "I")] },
  { id: "underline", category: "formatting", keys: [combo("Mod", "U")] },
  { id: "strike", category: "formatting", keys: [combo("Mod", "Shift", "S")] },
  { id: "codeMark", category: "formatting", keys: [combo("Mod", "E")] },
  { id: "link", category: "formatting", keys: [combo("Mod", "K")] },
  { id: "undo", category: "formatting", keys: [combo("Mod", "Z")] },
  { id: "redo", category: "formatting", keys: [combo("Mod", "Y"), combo("Mod", "Shift", "Z")], macKeys: [combo("Mod", "Shift", "Z")], sep: "or" },
  { id: "indent", category: "formatting", keys: [combo("Tab"), combo("Shift", "Tab")], sep: "pair" },
  { id: "lineBreak", category: "formatting", keys: [combo("Shift", "Enter")] },
  { id: "moveBlock", category: "formatting", keys: [combo("Mod", "Shift", "ArrowUp"), combo("Mod", "Shift", "ArrowDown")], sep: "pair" },
  // 並排
  { id: "columnsInsert", category: "columns", keys: [typed("/grid")] },
  { id: "columnBackspace", category: "columns", keys: [combo("Backspace")] },
  { id: "columnDelete", category: "columns", keys: [combo("Delete")] },
  { id: "columnUngroup", category: "columns", keys: [action] },
  { id: "columnsDragBeside", category: "columns", keys: [action] },
  { id: "columnResizeKeys", category: "columns", keys: [combo("ArrowLeft"), combo("ArrowRight")], sep: "pair" },
  // 側欄（選取模式）
  { id: "selectEsc", category: "sidebar", keys: [combo("Esc")] },
  { id: "selectRange", category: "sidebar", keys: [combo("Shift", "Click")] },
  // 簡報模式
  {
    id: "presentNav",
    category: "presentation",
    keys: [combo("ArrowRight"), combo("ArrowLeft"), combo("ArrowDown"), combo("ArrowUp")],
    sep: "pair",
  },
  { id: "presentOverview", category: "presentation", keys: [combo("O")] },
  { id: "presentFullscreen", category: "presentation", keys: [combo("F")] },
  { id: "presentExit", category: "presentation", keys: [combo("Esc")] },
  // AI（站台有設定才列）
  { id: "aiSelect", category: "ai", keys: [action], requires: "ai" },
  { id: "aiSend", category: "ai", keys: [combo("Enter"), combo("Shift", "Enter")], sep: "pair", requires: "aiInstruct" },
  { id: "aiClose", category: "ai", keys: [combo("Esc")], requires: "ai" },
  // 滑鼠
  { id: "dragBlock", category: "mouse", keys: [action] },
  { id: "dragNoteToEditor", category: "mouse", keys: [action] },
  { id: "dragNoteToFolder", category: "mouse", keys: [action] },
];

/** 依站台能力篩掉用不到的條目，並丟掉因此變空的分類；分類順序照 `SHORTCUT_CATEGORIES`。 */
export function visibleShortcuts(site: { aiAvailable: boolean; aiInstruct: boolean }): { category: ShortcutCategory; entries: ShortcutEntry[] }[] {
  const allowed = (e: ShortcutEntry): boolean => {
    if (e.requires === "ai") return site.aiAvailable;
    if (e.requires === "aiInstruct") return site.aiAvailable && site.aiInstruct;
    return true;
  };
  return SHORTCUT_CATEGORIES.map((category) => ({ category, entries: SHORTCUTS.filter((e) => e.category === category && allowed(e)) })).filter(
    (group) => group.entries.length > 0,
  );
}
