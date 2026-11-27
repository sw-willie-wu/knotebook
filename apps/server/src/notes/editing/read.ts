// Reads must not open a direct connection (`disconnect()` is the persist point), except the in-process #387 `shownLinks` record (no DB, no doc change). No `await` between `documents.get` and `Y.encodeStateAsUpdate`: unload is `documents.delete` then `destroy()`, so yielding could return a destroyed doc.
import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as Y from "yjs";
import { MAX_LINK_TARGETS, YDOC_FRAGMENT, blocksToNoteMarkdown, extractLinkTargets, wikilinksToLinks, type KnowledgeFieldView, type LastEditedDto, type NoteContentDto, type NoteSectionDto } from "@knotebook/shared";
import type { CollabServer } from "../../collab/server.js";
import type { Db } from "../../db/index.js";
import { noteStates, notes, users } from "../../db/schema.js";
import { knowledgeFieldViewForNote } from "../../knowledge/fields/queries.js";
import { visibleTitlesByIds } from "./candidates.js";
import { outlineOf } from "./fingerprint.js";
import { knowledgeMemberHandles, resolveKnowledgeMemberTokens } from "../../knowledge/members.js";
import { DOC_TOO_COMPLEX, type AskFn, type MemberPairs, type TitlePairs } from "./doc-jobs.js";
import { LiveWatch } from "./live-watch.js";
import type { EditingRuntime } from "./runtime.js";
import { EditorSession, forkFrom } from "./session.js";
import { shownLinkTextsOf, type ShownLinks, type ShownLinkTexts } from "./shown-link-texts.js";

export interface ReadDeps {
  db: Db;
  collab?: CollabServer;
  shownLinks?: ShownLinkTexts;
}

/** With `opts.watch` the `LiveWatch` is attached in the same tick as the encode so no transaction is missed; the caller must `stop()` it. A never-opened note yields empty bytes (empty doc); an unloaded doc passes the `note_states` bytes through undecoded. Same no-`await` rule as the header. */
export async function loadNoteState(deps: Pick<ReadDeps, "db" | "collab">, noteId: string, opts: { watch?: boolean } = {}): Promise<{ state: Uint8Array; loaded: boolean; watch?: LiveWatch }> {
  const live = deps.collab?.hocuspocus.documents.get(noteId);
  if (live) return { state: Y.encodeStateAsUpdate(live), loaded: true, ...(opts.watch ? { watch: new LiveWatch(live) } : {}) };
  const [row] = await deps.db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, noteId)).limit(1);
  return { state: row ? row.ydoc : new Uint8Array(0), loaded: false };
}

/** Answers a doc job's link-title and member questions. `userId` is the reader, or the writer whose reach member tokens resolve in. */
export function docAsk(db: Db, userId: string): AskFn {
  return async q => {
    if (q.kind === "titles") {
      const pairs: TitlePairs = (await visibleTitlesByIds(db, userId, q.ids)).map(t => [t.id.toLowerCase(), t.title]);
      return pairs;
    }
    if (q.kind === "members") {
      const [idOf, handleOf] = await Promise.all([resolveKnowledgeMemberTokens(db, userId, q.tokens), knowledgeMemberHandles(db, q.ids)]);
      const pairs: MemberPairs = { idOf: [...idOf], handleOf: [...handleOf] };
      return pairs;
    }
    throw new Error(`docAsk: unexpected ask ${q.kind}`);
  };
}

export class NoteReadTooComplexError extends Error {
  override name = "NoteReadTooComplexError";
}

export async function loadNoteDoc(deps: ReadDeps, noteId: string): Promise<{ doc: Y.Doc; loaded: boolean }> {
  const live = deps.collab?.hocuspocus.documents.get(noteId);
  if (live) return { doc: forkFrom(live).fork, loaded: true };
  const [row] = await deps.db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, noteId)).limit(1);
  const doc = new Y.Doc();
  if (row) Y.applyUpdate(doc, row.ydoc);
  return { doc, loaded: false };
}

/** Pure SELECT, no direct connection. `users` needs an alias: this JOINs the editor, not the owner. A deleted editor account (FK `set null`) gives an empty handle. */
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

/** Call before mount (no lease held). Targets the reader can't see are absent from the map, so reads fall back to `snapshotTitle` and never reveal the current title. */
export async function linkTitlesFor(db: Db, viewerId: string, doc: Y.Doc): Promise<Map<string, string>> {
  const ids = extractLinkTargets(doc).slice(0, MAX_LINK_TARGETS);
  if (ids.length === 0) return new Map();
  // Lowercase keys: old docs may store an uppercase `targetNoteId`.
  return new Map((await visibleTitlesByIds(db, viewerId, ids)).map(t => [t.id.toLowerCase(), t.title]));
}

/** Single place that builds markdown for MCP reads and file export, so they are byte-identical. Wikilinks export as links using label, else the current title from `titles` (keys lowercase), else snapshotTitle. Pure and DB-free (the caller holds the lease). */
export function toNoteMarkdown(
  editor: EditorSession["editor"],
  blocks: EditorSession["editor"]["document"],
  titles: ReadonlyMap<string, string>,
  fields: KnowledgeFieldView,
  handleOf: ReadonlyMap<string, string> = new Map(),
): string {
  return blocksToNoteMarkdown(editor, wikilinksToLinks(blocks, id => titles.get(id.toLowerCase())), { knowledge: { fields, handleOf } });
}

async function exportMarkdown(
  runtime: EditingRuntime,
  doc: Y.Doc,
  ids: Set<string> | undefined,
  titles: ReadonlyMap<string, string>,
  fields: KnowledgeFieldView,
  handleOf: ReadonlyMap<string, string>,
  onShown?: (shown: ShownLinks) => void,
): Promise<string> {
  const s = await EditorSession.open(runtime, doc);
  let shown: ShownLinks | undefined;
  let markdown: string;
  try {
    const blocks = ids ? s.editor.document.filter(b => ids.has(b.id)) : s.editor.document;
    if (onShown) shown = shownLinkTextsOf(blocks, titles);
    markdown = toNoteMarkdown(s.editor, blocks, titles, fields, handleOf);
  } finally {
    s.close();
  }
  if (shown) onShown!(shown);
  return markdown;
}

/** Fingerprints and outline are computed before mount (mount normalizes an empty doc). A missing section returns `"section_not_found"` rather than throwing: it's the normal "section was deleted" case. */
export async function readNoteContentFromDoc(
  runtime: EditingRuntime,
  doc: Y.Doc,
  section: string | undefined,
  titles: ReadonlyMap<string, string>,
  onShown: ((shown: ShownLinks) => void) | undefined,
  fields: KnowledgeFieldView,
  handleOf: ReadonlyMap<string, string> = new Map(),
): Promise<Omit<NoteContentDto, "lastEdited"> | Omit<NoteSectionDto, "lastEdited"> | "section_not_found"> {
  const { outline, whole } = outlineOf(doc.getXmlFragment(YDOC_FRAGMENT));
  const target = section === undefined ? undefined : outline.find(o => o.sectionId === section);
  if (section !== undefined && !target) return "section_not_found";
  // A truly empty doc exports "" without mounting (mount would add an empty paragraph → "\n") and keeps the common cold read off jsdom. The same holds for a zero-block `_top` section.
  const blockIds = target ? target.blockIds : outline.flatMap(o => o.blockIds);
  const markdown = blockIds.length === 0 ? "" : await exportMarkdown(runtime, doc, target && new Set(blockIds), titles, fields, handleOf, onShown);
  if (target) {
    const { blockIds: _ignored, sectionId, ...entry } = target;
    return { section: { id: sectionId, ...entry, markdown } };
  }
  return { markdown, fingerprint: whole, outline: outline.map(({ blockIds: _b, ...e }) => e) };
}

export async function readNoteContent(deps: ReadDeps, runtime: EditingRuntime, noteId: string, viewerId: string, section?: string) {
  const fields = await knowledgeFieldViewForNote(deps.db, noteId);
  const { state } = await loadNoteState(deps, noteId);
  const memo = deps.shownLinks;
  const r = await runtime.runDoc(viewerId, { kind: "read", state, ...(section !== undefined ? { section } : {}), wantShown: memo !== undefined, fields }, { ask: docAsk(deps.db, viewerId) });
  if (r === DOC_TOO_COMPLEX) throw new NoteReadTooComplexError();
  if (memo && r.shown) memo.record(viewerId, r.shown);
  return r.result;
}

export async function readNoteOutline(deps: Pick<ReadDeps, "db" | "collab">, runtime: EditingRuntime, noteId: string, owner: string, locate?: string[]) {
  const { state } = await loadNoteState(deps, noteId);
  const r = await runtime.runDoc(owner, { kind: "outline", state, ...(locate === undefined ? {} : { locate }) });
  if (r === DOC_TOO_COMPLEX) throw new NoteReadTooComplexError();
  return r;
}
