// 讀取零副作用：live doc 有就 fork 一份來讀，沒有就解 `note_states` 的快照——**絕不開直連**
// （`withDirectConnection` 的 `disconnect()` 就是落盤點，會 store／backup／unload，讀一下筆記
// 不該改到任何 server 狀態；#387 的行程內記憶體記錄 `ReadDeps.shownLinks` 除外——不落 DB、不動文件）。`hocuspocus.documents.get` 到 `Y.encodeStateAsUpdate` 之間
// **不得有 `await`**：unload 是 `documents.delete` 後緊接 `document.destroy()`（@hocuspocus/server
// 4.5.0 `hocuspocus-server.cjs` 的 `unloadDocument` → `actualUnloadingLogic`，:1611-1613），
// 讓出一次 microtask 就可能拿到已 destroy 的文件。反向的競態不存在：`documents.set` 只發生在
// 載入完成之後（同檔 `createDocument`，:1459），所以 get 到的一定是載好的文件。
import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as Y from "yjs";
import { MAX_LINK_TARGETS, YDOC_FRAGMENT, blocksToNoteMarkdown, extractLinkTargets, wikilinksToLinks, type LastEditedDto, type NoteContentDto, type NoteSectionDto } from "@knotebook/shared";
import type { CollabServer } from "../../collab/server.js";
import type { Db } from "../../db/index.js";
import { noteStates, notes, users } from "../../db/schema.js";
import { visibleTitlesByIds } from "./candidates.js";
import { outlineOf } from "./fingerprint.js";
import { DOC_TOO_COMPLEX, type AskFn, type TitlePairs } from "./doc-jobs.js";
import { LiveWatch } from "./live-watch.js";
import type { EditingRuntime } from "./runtime.js";
import { EditorSession, forkFrom } from "./session.js";
import { shownLinkTextsOf, type ShownLinks, type ShownLinkTexts } from "./shown-link-texts.js";

export interface ReadDeps {
  db: Db;
  collab?: CollabServer;
  /** #387：給了就記下讀者在這次讀出裡看到的連結文字（`readNoteContent`；寫入端據以不凍結成自訂文字）。 */
  shownLinks?: ShownLinkTexts;
}

/**
 * 文件狀態的位元組（轉換工作的輸入，`doc-jobs.ts`）：活文件在記憶體 → `Y.encodeStateAsUpdate`（主執行緒唯一的整份成本，量測見
 * `docs/self-hosting.md`）；否則 `note_states` 的位元組原樣交出（主執行緒不解碼）；從未開過 → 空位元組（空文件）。
 * ⚠ 同 `loadNoteDoc`：`documents.get` 與編碼之間不得有 `await`（見檔頭）。
 */
export async function loadNoteState(deps: Pick<ReadDeps, "db" | "collab">, noteId: string, opts: { watch?: boolean } = {}): Promise<{ state: Uint8Array; loaded: boolean; watch?: LiveWatch }> {
  const live = deps.collab?.hocuspocus.documents.get(noteId);
  // `watch`（套用用）：同一個 tick 掛上，之後活文件的每筆交易都記得到（`live-watch.ts`）。呼叫端負責 `stop()`。
  if (live) return { state: Y.encodeStateAsUpdate(live), loaded: true, ...(opts.watch ? { watch: new LiveWatch(live) } : {}) };
  const [row] = await deps.db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, noteId)).limit(1);
  return { state: row ? row.ydoc : new Uint8Array(0), loaded: false };
}

/** 轉換工作問「連結目標的現行標題」時的答案（`linkTitlesFor` 的 DB 那半）：只回 `viewerId` 看得到的，鍵小寫。 */
export function titlesAsk(db: Db, viewerId: string): AskFn {
  return async q => {
    if (q.kind !== "titles") throw new Error(`titlesAsk: unexpected ask ${q.kind}`);
    const pairs: TitlePairs = (await visibleTitlesByIds(db, viewerId, q.ids)).map(t => [t.id.toLowerCase(), t.title]);
    return pairs;
  };
}

/** 讀出的轉換在 worker 裡逾時、用完記憶體或堆疊（筆記太大或太複雜）。路由映成 500 `too_complex`、MCP 映成工具錯誤 `too_complex`。 */
export class NoteReadTooComplexError extends Error {
  override name = "NoteReadTooComplexError";
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

/**
 * `notes.last_edited_*` 四欄 → 對外的 `LastEditedDto`（#106）。**純 SELECT，不開直連**
 * （`/content` 兩形與兩個 409 的 `current` 都吃這一支，讀路徑零副作用的守衛也涵蓋它）。
 * `users` 要 `alias`：這裡 JOIN 的是**編輯者**，不是 owner——同一張表在同一句裡另有用途時，
 * 不取別名會讓 drizzle 產生歧義的 FROM。編輯者帳號被刪（FK `set null`）時 handle 落空回空字串。
 */
export async function loadLastEdited(db: Db, noteId: string): Promise<LastEditedDto | null> {
  const editor = alias(users, "editor");
  const [r] = await db
    .select({ at: notes.lastEditedAt, label: notes.lastEditedAgentLabel, handle: editor.handle })
    .from(notes)
    .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
    .where(eq(notes.id, noteId))
    .limit(1);
  return r?.at ? { at: r.at.toISOString(), byHandle: r.handle ?? "", agentLabel: r.label } : null;
}

/**
 * #269：讀者看得到的 wikilink 目標的現行標題。**mount 之前**呼叫（不持 lease）：`extractLinkTargets` 只走 Yjs 結構，
 * 一次 `visibleTitlesByIds`（≤3 句、空集合不查）。看不到的目標（含已刪）不在 map 裡——讀出退到 `snapshotTitle`、不露現行標題。
 */
export async function linkTitlesFor(db: Db, viewerId: string, doc: Y.Doc): Promise<Map<string, string>> {
  const ids = extractLinkTargets(doc).slice(0, MAX_LINK_TARGETS);
  if (ids.length === 0) return new Map();
  // 鍵一律小寫、查找端同（`exportMarkdown`）：舊文件的 `targetNoteId` 可能存大寫，比對不分大小寫（同 web `sameNoteId`）。
  return new Map((await visibleTitlesByIds(db, viewerId, ids)).map(t => [t.id.toLowerCase(), t.title]));
}

/**
 * MCP 讀出與檔案匯出（本文與 MCP 讀出逐位元組相同）共用的**唯一**組字點：在已 mount 的
 * editor 上把 `blocks` 匯出成 markdown。#269：wikilink 在匯出用的 JSON 副本上改寫成 `[文字](/notes/<id>[#b-…])`
 * 的 link 節點（`wikilinksToLinks`：label 優先，否則 `titles` 裡的現行標題，否則 snapshotTitle）；`titles` 鍵一律小寫。
 * #222：有顏色的頂層節點輸出成寫入端認得的 HTML。沒有顏色，也沒有任何要跳脫的字元（含站內連結文字，#269）、要改寫成行內
 * `<br>` 的換行、樣式邊緣空白（#386）時，與 blocksToMarkdownLossy 位元組相同（shared note-markdown-read.ts）。純同步、零 DB（呼叫端持 lease）。
 */
export function toNoteMarkdown(editor: EditorSession["editor"], blocks: EditorSession["editor"]["document"], titles: ReadonlyMap<string, string>): string {
  return blocksToNoteMarkdown(editor, wikilinksToLinks(blocks, id => titles.get(id.toLowerCase())));
}

/** mount 只為匯出 markdown；`ids` 為 undefined＝整篇。呼叫端已保證至少有一個 block（見下）。
 * #269：持 lease 期間**零 DB**（組字見 `toNoteMarkdown`）。`onShown`（#387）：匯出的這些 block 裡的連結文字——lease 內只收集
 * （純計算），`close()` 之後才交給呼叫端。 */
async function exportMarkdown(runtime: EditingRuntime, doc: Y.Doc, ids: Set<string> | undefined, titles: ReadonlyMap<string, string>, onShown?: (shown: ShownLinks) => void): Promise<string> {
  const s = await EditorSession.open(runtime, doc);
  let shown: ShownLinks | undefined;
  let markdown: string;
  try {
    const blocks = ids ? s.editor.document.filter(b => ids.has(b.id)) : s.editor.document;
    if (onShown) shown = shownLinkTextsOf(blocks, titles);
    markdown = toNoteMarkdown(s.editor, blocks, titles);
  } finally {
    s.close();
  }
  if (shown) onShown!(shown);
  return markdown;
}

/**
 * 指紋／大綱一律算在**未 mount** 的結構上（mount 會正規化空文件），算完才 mount 匯出 markdown。
 * `section` 指定了但大綱裡沒有 → 回哨兵字串 `"section_not_found"`（呼叫端轉 404），不 throw：
 * 這是正常的「段落已被刪掉」，不是故障。
 */
export async function readNoteContentFromDoc(
  runtime: EditingRuntime,
  doc: Y.Doc,
  section?: string,
  titles: ReadonlyMap<string, string> = new Map(),
  onShown?: (shown: ShownLinks) => void
): Promise<Omit<NoteContentDto, "lastEdited"> | Omit<NoteSectionDto, "lastEdited"> | "section_not_found"> {
  const { outline, whole } = outlineOf(doc.getXmlFragment(YDOC_FRAGMENT)); // 先算（未 mount）
  const target = section === undefined ? undefined : outline.find(o => o.sectionId === section);
  if (section !== undefined && !target) return "section_not_found";
  // 空文件形：真空文件（無頂層 block，例如從未開過的筆記）的 markdown 恆為 ""。
  // 這一支**不 mount**——mount 會把真空文件正規化出一個空 paragraph，匯出就成了 "\n"；順帶讓
  // 最常見的冷讀路徑完全不碰 jsdom。零 block 的 `_top` 段（文件以 heading 開頭）同理。
  const blockIds = target ? target.blockIds : outline.flatMap(o => o.blockIds);
  const markdown = blockIds.length === 0 ? "" : await exportMarkdown(runtime, doc, target && new Set(blockIds), titles, onShown);
  if (target) {
    const { blockIds: _ignored, sectionId, ...entry } = target;
    return { section: { id: sectionId, ...entry, markdown } }; // 段落形的鍵是 id
  }
  // blockIds 是內部欄位，對外的 NoteOutlineEntry 不帶（note-content.test.ts 釘住）。
  return { markdown, fingerprint: whole, outline: outline.map(({ blockIds: _b, ...e }) => e) };
}

/**
 * `viewerId`（#269）＝讀者——現行標題只對他看得到的目標露出；`deps.shownLinks` 給了就記在他名下（#387）。
 * 轉換在 parse worker 裡做（很小的筆記在主執行緒；`EditingRuntime.runDoc`）：worker 全忙排太久 → `ParserBusyError`（503）；
 * 逾時或用完記憶體 → {@link NoteReadTooComplexError}。
 */
export async function readNoteContent(deps: ReadDeps, runtime: EditingRuntime, noteId: string, viewerId: string, section?: string) {
  const { state } = await loadNoteState(deps, noteId);
  const memo = deps.shownLinks;
  const r = await runtime.runDoc(viewerId, { kind: "read", state, ...(section !== undefined ? { section } : {}), wantShown: memo !== undefined }, { ask: titlesAsk(deps.db, viewerId) });
  if (r === DOC_TOO_COMPLEX) throw new NoteReadTooComplexError();
  if (memo && r.shown) memo.record(viewerId, r.shown);
  return r.result;
}

/** 整篇大綱（含每段的 block id 與指紋）與整篇指紋：MCP `read_note_outline` 與 `edit_note` 指紋不符時的大綱。轉換規則同 {@link readNoteContent}。 */
export async function readNoteOutline(deps: Pick<ReadDeps, "db" | "collab">, runtime: EditingRuntime, noteId: string, owner: string) {
  const { state } = await loadNoteState(deps, noteId);
  const r = await runtime.runDoc(owner, { kind: "outline", state });
  if (r === DOC_TOO_COMPLEX) throw new NoteReadTooComplexError();
  return r;
}
