// AI edits are made on a fork and only the fork's diff against its own state vector is merged back, so concurrent typing survives. `withDirectConnection` is the only direct connection, opened just to merge.
// `openDirectConnection` bypasses `onAuthenticate`: callers must check write permission first. `disconnect()` is the persist point, and `fn` must be all-or-nothing (ops yjs already applied aren't undone and get persisted).
// #181: the note may be trashed after authorization, so liveness is rechecked before opening (don't load a trashed doc into memory) and after (a move landing at open). Hocuspocus doesn't unload while a direct connection holds the doc, so the move's unload polling waits for this write; the remaining window is that polling's 5 s timeout (known-limitations).
import { BlockNoteEditor, type Block, type PartialBlock } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import type { DirectConnection, Document, Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { YDOC_FRAGMENT, createHeadlessNoteSchema } from "@knotebook/shared";
import type { CollabContext, CollabServer } from "../../collab/server.js";
import type { DbOrTx } from "../../db/tx.js";
import { noteIsLive } from "../service.js";
import { assertNoPendingKnowledgeIds, knowledgeIdsByBlock, renewDuplicateKnowledgeIds, type KnowledgeRenewal } from "./knowledge-write.js";
import type { EditingRuntime, SessionLease } from "./runtime.js";

const BLOCK_ELEMENTS = new Set(["blockContainer", "columnList", "column"]);

// Pre-order, iterative (nesting depth is client-controlled); only block structure is descended into, never inline content.
function walkBlockElements(doc: Y.Doc, visit: (el: Y.XmlElement) => void): void {
  const stack: Array<Y.XmlFragment | Y.XmlElement> = [doc.getXmlFragment(YDOC_FRAGMENT)];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const kids = node.toArray();
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i];
      if (!(kid instanceof Y.XmlElement)) continue;
      if (kid.nodeName === "blockGroup" || BLOCK_ELEMENTS.has(kid.nodeName)) stack.push(kid);
    }
    if (node instanceof Y.XmlElement && BLOCK_ELEMENTS.has(node.nodeName)) visit(node);
  }
}

/**
 * Must run with no editor mounted on `doc`: bound, every ProseMirror attribute step copies the whole top-level array, while a Yjs attribute write is O(1). A value already held by any block is skipped, which is what keeps ids unique.
 */
export function renameBlocksInDoc(doc: Y.Doc, renames: ReadonlyMap<string, string>): Map<string, string> {
  const applied = new Map<string, string>();
  if (renames.size === 0) return applied;
  const byId = new Map<string, Y.XmlElement>();
  walkBlockElements(doc, el => {
    const id = el.getAttribute("id");
    if (typeof id === "string" && !byId.has(id)) byId.set(id, el);
  });
  const held = new Set(byId.keys());
  doc.transact(() => {
    for (const [from, to] of renames) {
      const el = byId.get(from);
      if (el === undefined || held.has(to)) continue;
      el.setAttribute("id", to);
      held.delete(from);
      held.add(to);
      applied.set(from, to);
    }
  });
  return applied;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; repo convention
export type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
export type AnyBlock = Block<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
export type AnyPartialBlock = PartialBlock<any, any, any>;

/**
 * For each id, deletes the first top-level block (blockContainer or columnList) in document order that has it, in one transaction.
 * Must run with no editor mounted on `doc` and outside any other transaction. Throws, changing nothing, if an id is not at the top level or if no top-level block would remain.
 *
 * It runs after the editor is closed because an editor removal copies the whole top-level array per step. It walks the item list because `delete(index)` is O(index) on XML types.
 * GC is off because the transaction cleanup merges garbage-collected runs with one `Array.splice` per block. The first match per id mirrors `editor.removeBlocks`, which keeps a reinserted copy that carries a removed block's id.
 */
export function removeBlocksInDoc(doc: Y.Doc, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const group = doc.getXmlFragment(YDOC_FRAGMENT).get(0);
  const pending = new Set(ids);
  const items: Y.Item[] = [];
  let live = 0;
  if (group instanceof Y.XmlElement) {
    for (let item = group._start; item !== null; item = item.right) {
      if (item.deleted || !(item.content instanceof Y.ContentType)) continue;
      const el = item.content.type;
      if (!(el instanceof Y.XmlElement)) continue;
      live++;
      const id = el.getAttribute("id");
      if (typeof id === "string" && pending.delete(id)) items.push(item);
    }
  }
  if (pending.size > 0) throw new Error(`removeBlocksInDoc: not a top-level block: ${[...pending].slice(0, 3).join(", ")}`);
  if (items.length === live) throw new Error("removeBlocksInDoc: would leave no top-level block");
  const gc = doc.gc;
  doc.gc = false;
  try {
    doc.transact(tr => {
      for (const item of items) item.delete(tr);
    });
  } finally {
    doc.gc = gc;
  }
}

/** Same id, type, props, content and children, compared as plain data (a key holding `undefined` counts as absent). A block that omits a default prop does not match its full form, which only costs the skip. */
function sameBlock(a: AnyBlock, b: AnyPartialBlock): boolean {
  const stack: Array<[unknown, unknown]> = [[a, b]];
  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    if (x === y) continue;
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false;
    if (Array.isArray(x) !== Array.isArray(y)) return false;
    const xo = x as Record<string, unknown>;
    const yo = y as Record<string, unknown>;
    const xk = Object.keys(xo).filter(k => xo[k] !== undefined);
    const yk = Object.keys(yo).filter(k => yo[k] !== undefined);
    if (xk.length !== yk.length) return false;
    for (const k of xk) {
      if (yo[k] === undefined) return false;
      stack.push([xo[k], yo[k]]);
    }
  }
  return true;
}

/**
 * Collects the old blocks of a rewrite while the editor is open and removes them only after it is closed (`withForkEditor`).
 * `replace` and `remove` do not check ids one by one (a per-id lookup is O(blocks) each); `removeBlocksInDoc` checks them after close and throws on a missing id.
 */
export class ForkEdits {
  private readonly queued = new Set<string>();
  private readonly renameMap = new Map<string, string>();

  constructor(private readonly editor: AnyEditor) {}

  /**
   * Inserts `blocks` after the last of `ids` through the editor and queues `ids` for removal; `ids`: non-empty, distinct, top-level, present, not yet queued. With no blocks it behaves as `remove(ids)` and returns [].
   * `old`: the current blocks of `ids`, in order. A leading run whose block has the same id and is {@link sameBlock} equal to the new one stays untouched (no copy is inserted, the old block is not queued) and comes back as the first entries of the result. The editor-level removal kept exactly that run: y-prosemirror keeps old nodes that equal the new ones from the front and the inserted copies from the back, and deleting an equal old block instead would drop text a browser types into it while the write is in flight and rebuild it in every open tab.
   * After the old last block rather than before the first: replacing in one editor call makes y-prosemirror diff new paragraphs against old ones (Yjs splices the whole structure array per split: 49,000 `<br>` → 24,500 formatted takes 12 s vs 0.85 s), and before the first block the insertion origin is shared with a paragraph a browser types at the end of the previous section, so the client id could move that paragraph into the target section.
   */
  replace(ids: readonly string[], blocks: AnyPartialBlock[], old?: readonly AnyBlock[]): AnyBlock[] {
    let kept = 0;
    if (old) while (kept < ids.length && kept < blocks.length && kept < old.length && old[kept]!.id === ids[kept] && sameBlock(old[kept]!, blocks[kept]!)) kept++;
    const restIds = ids.slice(kept);
    const restBlocks = blocks.slice(kept);
    const keptBlocks = old ? old.slice(0, kept) : [];
    if (restBlocks.length === 0) {
      if (restIds.length > 0) this.remove(restIds);
      return keptBlocks;
    }
    const inserted = this.editor.insertBlocks(restBlocks, ids[ids.length - 1]!, "after") as AnyBlock[];
    for (const id of restIds) this.queued.add(id);
    return [...keptBlocks, ...inserted];
  }

  /** Queues `ids` for removal. When that would leave no top-level block, first inserts one empty paragraph after the last of them and returns it; otherwise null. */
  remove(ids: readonly string[]): AnyBlock | null {
    for (const id of ids) this.queued.add(id);
    // O(1): bulk write-back calls this once per region, so it must not read `editor.document`.
    if (this.editor.prosemirrorState.doc.firstChild!.childCount - this.queued.size > 0) return null;
    return this.editor.insertBlocks([{ type: "paragraph" }], ids[ids.length - 1]!, "after")[0] as AnyBlock;
  }

  /** Merged into one map applied after removal (new id -> old id). */
  rename(renames: ReadonlyMap<string, string>): void {
    for (const [from, to] of renames) this.renameMap.set(from, to);
  }

  isQueued(id: string): boolean {
    return this.queued.has(id);
  }

  get removals(): readonly string[] {
    return [...this.queued];
  }

  get renames(): ReadonlyMap<string, string> {
    return this.renameMap;
  }
}

export interface ForkWrite<T> {
  value: T;
  diff: Uint8Array;
  renamed: Map<string, string>;
  renewed: KnowledgeRenewal[];
  /** Top-level block id -> knowledge id as it was before `fn` ran. */
  knowledgeBefore: ReadonlyMap<string, string>;
}

/** Open -> fn -> close (finally) -> removeBlocksInDoc -> renameBlocksInDoc -> renewDuplicateKnowledgeIds -> Y.encodeStateAsUpdate(fork, sv). If fn throws: close, nothing removed or renamed, rethrow. A pending knowledge id left at the top level throws before the diff is taken. */
export async function withForkEditor<T>(
  runtime: EditingRuntime,
  fork: Y.Doc,
  sv: Uint8Array,
  fn: (editor: AnyEditor, edits: ForkEdits) => T | Promise<T>
): Promise<ForkWrite<T>> {
  const knowledgeBefore = knowledgeIdsByBlock(fork.getXmlFragment(YDOC_FRAGMENT));
  const s = await EditorSession.open(runtime, fork);
  let edits: ForkEdits;
  let value: T;
  try {
    edits = new ForkEdits(s.editor);
    value = await fn(s.editor, edits);
  } finally {
    s.close();
  }
  removeBlocksInDoc(fork, edits.removals);
  const renamed = renameBlocksInDoc(fork, edits.renames);
  // After the rename: a rewritten heading gets its old block id back, which decides what counts as already there.
  const renewed = renewDuplicateKnowledgeIds(fork, knowledgeBefore);
  assertNoPendingKnowledgeIds(fork.getXmlFragment(YDOC_FRAGMENT), knowledgeBefore);
  return { value, diff: Y.encodeStateAsUpdate(fork, sv), renamed, renewed, knowledgeBefore };
}

/** One pass over the top level (a nested id is absent). With duplicate ids the first in document order wins, like `getBlock` and `removeBlocksInDoc`. */
export function topLevelBlocksById(editor: AnyEditor): Map<string, AnyBlock> {
  const m = new Map<string, AnyBlock>();
  for (const b of editor.document as AnyBlock[]) if (!m.has(b.id)) m.set(b.id, b);
  return m;
}

/** In the order of `ids`; missing ids skipped. */
export function pickBlocks(byId: ReadonlyMap<string, AnyBlock>, ids: readonly string[]): AnyBlock[] {
  const out: AnyBlock[] = [];
  for (const id of ids) {
    const b = byId.get(id);
    if (b !== undefined) out.push(b);
  }
  return out;
}

export function forkFrom(source: Y.Doc | Uint8Array): { fork: Y.Doc; sv: Uint8Array } {
  const fork = new Y.Doc();
  Y.applyUpdate(fork, source instanceof Y.Doc ? Y.encodeStateAsUpdate(source) : source);
  return { fork, sv: Y.encodeStateVector(fork) };
}

// Callers must `close()` in a finally: it's the only path releasing the runtime lease, and a leak would block the rebuild gate forever. Never `open()` while holding a lease (`acquire()` isn't reentrant).
export class EditorSession {
  private constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; repo convention
    readonly editor: BlockNoteEditor<any, any, any>,
    private readonly fork: Y.Doc,
    private readonly lease: SessionLease
  ) {}

  static async open(runtime: EditingRuntime, fork: Y.Doc): Promise<EditorSession> {
    const lease = await runtime.acquire();
    try {
      const editor = BlockNoteEditor.create(
        withCollaboration({
          schema: createHeadlessNoteSchema(runtime.baseUrl),
          collaboration: { fragment: fork.getXmlFragment(YDOC_FRAGMENT), user: { name: "ai", color: "#7c3aed" } },
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above: the createHeadlessNoteSchema triple is not propagated here
      ) as BlockNoteEditor<any, any, any>;
      editor.mount(document.createElement("div"));
      runtime.noteMount();
      return new EditorSession(editor, fork, lease);
    } catch (err) {
      lease.release();
      throw err;
    }
  }

  diffSince(sv: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.fork, sv);
  }

  close(): void {
    try {
      this.editor.unmount();
    } finally {
      this.lease.release();
    }
  }
}

export interface DirectCtx extends CollabContext {
  /** `version-apply`: writes no note_ai_edits and cuts no version. */
  source: "ai-edit" | "version-apply";
  tokenId: string | null;
  agentLabel: string | null;
  applied: boolean;
}

/** No userId: collab's `stampLastEdited` and editor accumulation gate on a string `userId`, so conversions stamp nothing and count no activity; versions treat it as the "other" branch. */
export interface LinkConvertCtx {
  source: "link-convert";
  applied: boolean;
}

export type DirectConnectionCtx = DirectCtx | LinkConvertCtx;

export class NoteGoneError extends Error {
  override name = "NoteGoneError";
}

export interface DirectTarget {
  hocuspocus: Hocuspocus<CollabContext>;
  isDeleting(noteId: string): boolean;
  noteIsLive(noteId: string): Promise<boolean>;
}

export function directTarget(collab: Pick<CollabServer, "hocuspocus" | "isDeleting">, db: DbOrTx): DirectTarget {
  return {
    hocuspocus: collab.hocuspocus,
    isDeleting: noteId => collab.isDeleting(noteId),
    noteIsLive: noteId => noteIsLive(db, noteId),
  };
}

async function goneNow(target: DirectTarget, noteId: string): Promise<boolean> {
  return target.isDeleting(noteId) || !(await target.noteIsLive(noteId));
}

async function disconnectQuietly(direct: DirectConnection): Promise<void> {
  try {
    await direct.disconnect();
  } catch (err) {
    console.error("withDirectConnection: disconnect after recheck failed", err);
  }
}

/** Liveness is rechecked before and after opening (`isDeleting`, `noteIsLive`; failure → `NoteGoneError`, and after opening it disconnects without transacting). `fn`'s error wins: a disconnect failure is only logged, or the caller would misclassify (e.g. "AI content invalid" as "persist failed"). `beforeDisconnect` failures are likewise only logged (content applied, base not updated: acceptable); `beforeDisconnect` runs only after a successful transact, not when `fn` failed. */
export async function withDirectConnection<T>(
  target: DirectTarget,
  noteId: string,
  ctx: DirectConnectionCtx,
  fn: (doc: Document) => T,
  opts?: { beforeDisconnect?: (result: T) => Promise<void>; afterOpen?: () => Promise<void> }
): Promise<T> {
  if (await goneNow(target, noteId)) throw new NoteGoneError();
  const direct = await target.hocuspocus.openDirectConnection(noteId, ctx as unknown as CollabContext);
  let gone: boolean;
  try {
    gone = await goneNow(target, noteId);
  } catch (err) {
    await disconnectQuietly(direct);
    throw err;
  }
  if (gone) {
    // Hocuspocus 4.5 `disconnect()` can't skip persisting; storing an unchanged doc is harmless.
    await disconnectQuietly(direct);
    throw new NoteGoneError();
  }
  if (opts?.afterOpen) {
    try {
      await opts.afterOpen();
    } catch (err) {
      await disconnectQuietly(direct);
      throw err;
    }
  }
  let result!: T;
  let fnFailed = false;
  let fnError: unknown;
  try {
    await direct.transact(doc => {
      result = fn(doc);
    });
  } catch (err) {
    fnFailed = true;
    fnError = err;
  }
  if (!fnFailed && opts?.beforeDisconnect) {
    try {
      await opts.beforeDisconnect(result);
    } catch (bdErr) {
      console.error("withDirectConnection: beforeDisconnect failed", bdErr);
    }
  }
  try {
    await direct.disconnect();
  } catch (disconnectErr) {
    if (!fnFailed) throw disconnectErr;
    console.error("withDirectConnection: disconnect after fn error failed", disconnectErr);
  }
  if (fnFailed) throw fnError;
  return result;
}
