// 讀取零副作用：live doc 有就 fork 一份來讀，沒有就解 `note_states` 的快照——**絕不開直連**
// （`withDirectConnection` 的 `disconnect()` 就是落盤點，會 store／backup／unload，讀一下筆記
// 不該改到任何 server 狀態）。`hocuspocus.documents.get` 到 `Y.encodeStateAsUpdate` 之間
// **不得有 `await`**：unload 是 `documents.delete` 後緊接 `document.destroy()`（@hocuspocus/server
// 4.5.0 `hocuspocus-server.cjs` 的 `unloadDocument` → `actualUnloadingLogic`，:1611-1613），
// 讓出一次 microtask 就可能拿到已 destroy 的文件。反向的競態不存在：`documents.set` 只發生在
// 載入完成之後（同檔 `createDocument`，:1459），所以 get 到的一定是載好的文件。
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, type NoteContentDto, type NoteSectionDto } from "@knotebook/shared";
import type { CollabServer } from "../../collab/server.js";
import type { Db } from "../../db/index.js";
import { noteStates } from "../../db/schema.js";
import { outlineOf } from "./fingerprint.js";
import type { EditingRuntime } from "./runtime.js";
import { EditorSession, forkFrom } from "./session.js";

export interface ReadDeps {
  db: Db;
  collab?: CollabServer;
}

/** `loaded`＝這份內容來自記憶體中的 live doc（有人在線）；false＝來自 DB 快照。 */
export async function loadNoteDoc(deps: ReadDeps, noteId: string): Promise<{ doc: Y.Doc; loaded: boolean }> {
  const live = deps.collab?.hocuspocus.documents.get(noteId);
  // ⚠ 下一行與上一行之間不得插入 await（見檔頭）：forkFrom 內的 encodeStateAsUpdate 是同步的。
  if (live) return { doc: forkFrom(live).fork, loaded: true };
  const [row] = await deps.db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, noteId)).limit(1);
  const doc = new Y.Doc();
  // 從未開過的筆記沒有 note_states 列——空 Y.Doc 就是正確答案（回空文件形，不是錯誤）。
  if (row) Y.applyUpdate(doc, row.ydoc);
  return { doc, loaded: false };
}

/** mount 只為匯出 markdown；`ids` 為 undefined＝整篇。呼叫端已保證至少有一個 block（見下）。 */
async function exportMarkdown(runtime: EditingRuntime, doc: Y.Doc, ids?: Set<string>): Promise<string> {
  const s = await EditorSession.open(runtime, doc);
  try {
    // blocksToMarkdownLossy 在 @blocknote/core 0.52.1 是同步函式；await 無害，留著防上游改成 async。
    return await s.editor.blocksToMarkdownLossy(ids ? s.editor.document.filter(b => ids.has(b.id)) : s.editor.document);
  } finally {
    s.close();
  }
}

/**
 * 指紋／大綱一律算在**未 mount** 的結構上（mount 會正規化空文件），算完才 mount 匯出 markdown。
 * `section` 指定了但大綱裡沒有 → 回哨兵字串 `"section_not_found"`（呼叫端轉 404），不 throw：
 * 這是正常的「段落已被刪掉」，不是故障。
 */
export async function readNoteContentFromDoc(
  runtime: EditingRuntime,
  doc: Y.Doc,
  section?: string
): Promise<Omit<NoteContentDto, "lastEdited"> | Omit<NoteSectionDto, "lastEdited"> | "section_not_found"> {
  const { outline, whole } = outlineOf(doc.getXmlFragment(YDOC_FRAGMENT)); // 先算（未 mount）
  const target = section === undefined ? undefined : outline.find(o => o.sectionId === section);
  if (section !== undefined && !target) return "section_not_found";
  // spec §5「空文件形」：真空文件（無頂層 block，例如從未開過的筆記）的 markdown 恆為 ""。
  // 這一支**不 mount**——mount 會把真空文件正規化出一個空 paragraph，匯出就成了 "\n"；順帶讓
  // 最常見的冷讀路徑完全不碰 jsdom。零 block 的 `_top` 段（文件以 heading 開頭）同理。
  const blockIds = target ? target.blockIds : outline.flatMap(o => o.blockIds);
  const markdown = blockIds.length === 0 ? "" : await exportMarkdown(runtime, doc, target && new Set(blockIds));
  if (target) {
    const { blockIds: _ignored, sectionId, ...entry } = target;
    return { section: { id: sectionId, ...entry, markdown } }; // spec §5：段落形的鍵是 id
  }
  // blockIds 是內部欄位，對外的 NoteOutlineEntry 不帶（note-content.test.ts 釘住）。
  return { markdown, fingerprint: whole, outline: outline.map(({ blockIds: _b, ...e }) => e) };
}

export async function readNoteContent(deps: ReadDeps, runtime: EditingRuntime, noteId: string, section?: string) {
  const { doc } = await loadNoteDoc(deps, noteId);
  return readNoteContentFromDoc(runtime, doc, section);
}
