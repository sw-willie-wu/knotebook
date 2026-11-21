// Hard rules (beforeNoteDeleted in hooks-impl.ts relies on the first):
// - A store for a note that no longer exists is dropped silently, never resurrecting the row.
// - This process is the only writer of note_states, so an optimistic-lock conflict is overwritten
//   after one re-read instead of retried.
import { and, desc, eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { noteStateBackups, noteStates, notes } from "../db/schema.js";
import { isForeignKeyViolation } from "../db/pg-errors.js";
import { extractKnowledgeForIndex, type KnowledgeIndexExtract } from "../knowledge/extract.js";
import { bumpKnowledgeIndexVersion, knowledgeErrorFields, writeKnowledgeIndex, type KnowledgeIndexOutcome } from "../knowledge/index-write.js";
import { bumpSearchIndexVersion, extractForIndex, writeSearchIndex, type SearchIndexOutcome } from "../notes/search-index.js";
import type { SearchExtract } from "../notes/search-text.js";
import { crossesFifteenMinuteBoundary, selectPrunable } from "./backup-policy.js";

// Defined here, not in server.ts, because server.ts imports this file.
// Monotonic (state-vector entries only grow, merges take the max, GC keeps the vector), so it can
// tell whether the wikilink index covers an edit (links_clock clamp, CollabServer.linkSyncState).
export function docClock(doc: Y.Doc): number {
  let total = 0;
  for (const seq of Y.decodeStateVector(Y.encodeStateVector(doc)).values()) {
    total += seq;
  }
  return total;
}

export interface StoreLogger {
  warn(obj: object, msg: string): void;
}

export interface UnsafeUrlFinding {
  block: string;
  scheme: string;
}

// #44: detect and log only; render (#12) and export (#43) already keep these URLs from any sink.
// Only the `url` attribute (text fields may contain colons), and only values that parse with a
// non-http(s) scheme, matching isSafeMediaUrl (so about:/blob: are reported too). No typeof guard:
// hostile clients can store non-strings, which `new URL` stringifies. The scheme is safe to log (the
// parser limits it to [a-z0-9+.-]); the attacker-controlled URL is not.
// Iterative, not recursive: depth is attacker-controlled, and a RangeError out of onStoreDocument makes
// Hocuspocus pin the doc in memory. Doesn't descend into Y.XmlHook or Y.XmlText embeds.

/** Block names are client-chosen; cap them so log line size isn't theirs to choose. */
const LOGGED_BLOCK_NAME_MAX = 64;

export function collectUnsafeUrlFindings(doc: Y.Doc): UnsafeUrlFinding[] {
  const findings: UnsafeUrlFinding[] = [];
  const stack: unknown[] = [doc.getXmlFragment(YDOC_FRAGMENT)];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node instanceof Y.XmlElement) {
      const url: unknown = node.getAttribute("url");
      if (url != null && url !== "") {
        let parsed: URL | null;
        try {
          parsed = new URL(url as string); // new URL stringifies non-strings too
        } catch {
          parsed = null; // relative URL: resolves against the page as http(s)
        }
        if (parsed && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          findings.push({ block: node.nodeName.slice(0, LOGGED_BLOCK_NAME_MAX), scheme: parsed.protocol.slice(0, 32) });
        }
      }
      for (const child of node.toArray()) stack.push(child);
    } else if (node instanceof Y.XmlFragment) {
      for (const child of node.toArray()) stack.push(child);
    }
  }
  return findings;
}

const noopLogger: StoreLogger = { warn: () => {} };

export interface NoteStoreDeps {
  db: Db;
  log?: StoreLogger;
  /** Test clock: a real 15-minute bucket boundary can't be waited for in tests. */
  now?: () => Date;
  indexer?: (noteId: string, version: number, extract: SearchExtract) => Promise<SearchIndexOutcome>;
  bumper?: (noteId: string, version: number, contentHash: string) => Promise<number>;
  extract?: (doc: Y.Doc) => SearchExtract;
  knowledgeIndexer?: (noteId: string, version: number, extract: KnowledgeIndexExtract) => Promise<KnowledgeIndexOutcome>;
  knowledgeBumper?: (noteId: string, version: number, contentHash: string) => Promise<number>;
  /** `bytes` is the encoded document being persisted, so a note without knowledge skips the document walk. */
  extractKnowledge?: (doc: Y.Doc, bytes: Uint8Array) => KnowledgeIndexExtract;
  afterPersistForTest?: (noteId: string, doc: Y.Doc) => Promise<void>;
}

export type NoteStoreSearchHooks = Pick<NoteStoreDeps, "indexer" | "bumper" | "extract" | "knowledgeIndexer" | "knowledgeBumper" | "extractKnowledge" | "afterPersistForTest" | "now">;

export interface NoteStore {
  onLoadDocument(noteId: string, doc: Y.Doc): Promise<Uint8Array | undefined>;
  onStoreDocument(noteId: string, doc: Y.Doc): Promise<void>;
  /** Must drop the per-note caches, or every note ever opened stays in memory; each is rebuilt on the next load or store. */
  afterUnloadDocument(noteId: string): void;
}

function svEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function createNoteStore(deps: NoteStoreDeps): NoteStore {
  const db = deps.db;
  const log = deps.log ?? noopLogger;
  const now = deps.now ?? ((): Date => new Date());
  const indexer = deps.indexer ?? ((noteId: string, version: number, extract: SearchExtract) => writeSearchIndex(db, noteId, version, extract, { log }));
  const bumper = deps.bumper ?? ((noteId: string, version: number, contentHash: string) => bumpSearchIndexVersion(db, noteId, version, contentHash));
  const extractFn = deps.extract ?? extractForIndex;
  const knowledgeIndexer =
    deps.knowledgeIndexer ?? ((noteId: string, version: number, extract: KnowledgeIndexExtract) => writeKnowledgeIndex(db, noteId, version, extract, { log }));
  const knowledgeBumper =
    deps.knowledgeBumper ?? ((noteId: string, version: number, contentHash: string) => bumpKnowledgeIndexVersion(db, noteId, version, contentHash));
  const extractKnowledgeFn = deps.extractKnowledge ?? extractKnowledgeForIndex;
  // #93: content hash last written to the search index; a match only bumps source_version.
  const indexedHash = new Map<string, string>();
  // Same for the knowledge index.
  const knowledgeIndexedHash = new Map<string, string>();

  // sv at the last backup or load; a missing entry never matches, so unknown counts as changed.
  const svCache = new Map<string, Uint8Array>();
  const lastBackupAtCache = new Map<string, Date | null>();
  // #44: warn once per note per load cycle; onStoreDocument runs on every debounce, so an unthrottled
  // warning floods the log. Cleared on unload, so it warns again after a reload.
  const warnedUnsafeUrl = new Set<string>();

  function forgetNote(noteId: string): void {
    svCache.delete(noteId);
    lastBackupAtCache.delete(noteId);
    warnedUnsafeUrl.delete(noteId);
    indexedHash.delete(noteId);
    knowledgeIndexedHash.delete(noteId);
  }

  async function onLoadDocument(noteId: string, doc: Y.Doc): Promise<Uint8Array | undefined> {
    const [row] = await db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, noteId)).limit(1);

    // Apply now so the sv cache reflects the persisted state: Hocuspocus applies the returned update
    // only after we return, and applying it twice is idempotent.
    if (row) {
      Y.applyUpdate(doc, row.ydoc);
    }
    svCache.set(noteId, Y.encodeStateVector(doc));

    const [backupRow] = await db
      .select({ createdAt: noteStateBackups.createdAt })
      .from(noteStateBackups)
      .where(eq(noteStateBackups.noteId, noteId))
      .orderBy(desc(noteStateBackups.createdAt))
      .limit(1);
    lastBackupAtCache.set(noteId, backupRow?.createdAt ?? null);

    // Clamp links_clock to the loaded doc's clock: note_links commits at once but the doc persists on a
    // debounced store, so after a crash links_clock can exceed the doc's clock and the `>=` check would
    // never reindex. LEAST only lowers it, so a lagging index isn't pushed ahead. docs/backup-restore.md resets it to 0 as the paired step.
    await db
      .update(notes)
      .set({ linksClock: sql`LEAST(${notes.linksClock}, ${docClock(doc)})` })
      .where(eq(notes.id, noteId));

    return row?.ydoc;
  }

  /** Returns the written version, or null if the note is gone. `at` is the store's single "now", shared with the backup timestamp and bucket check. */
  async function persistNoteState(noteId: string, ydocBuf: Buffer, at: Date): Promise<number | null> {
    const [existing] = await db.select({ version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, noteId)).limit(1);

    if (!existing) {
      // The note may be gone (or deleted since the select): an FK violation means drop the write.
      try {
        await db.insert(noteStates).values({ noteId, ydoc: ydocBuf, version: 1, updatedAt: at });
        return 1;
      } catch (err) {
        if (isForeignKeyViolation(err)) return null;
        throw err;
      }
    }

    const updated = await db
      .update(noteStates)
      .set({ ydoc: ydocBuf, version: existing.version + 1, updatedAt: at })
      .where(and(eq(noteStates.noteId, noteId), eq(noteStates.version, existing.version)))
      .returning({ noteId: noteStates.noteId });
    if (updated.length > 0) return existing.version + 1;

    // 0 rows: a version conflict or the note was deleted (cascade); only a re-read tells which.
    const [reread] = await db.select({ version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, noteId)).limit(1);
    if (!reread) return null;

    log.warn({ noteId, readVersion: existing.version, currentVersion: reread.version }, "note_states 樂觀鎖衝突，重讀後覆寫");
    await db
      .update(noteStates)
      .set({ ydoc: ydocBuf, version: reread.version + 1, updatedAt: at })
      .where(eq(noteStates.noteId, noteId));
    return reread.version + 1;
  }

  async function maybeBackup(noteId: string, doc: Y.Doc, at: Date): Promise<void> {
    const lastBackupAt = lastBackupAtCache.get(noteId) ?? null;
    if (!crossesFifteenMinuteBoundary(lastBackupAt, at)) return;

    const sv = Y.encodeStateVector(doc);
    const cachedSv = svCache.get(noteId);
    if (cachedSv && svEqual(cachedSv, sv)) return;

    const ydocBuf = Buffer.from(Y.encodeStateAsUpdate(doc));
    // The note can still be deleted before this insert. An uncaught FK error makes Hocuspocus keep the
    // doc in memory with no later store to retry, stuck for good, so drop it as persistNoteState does.
    try {
      await db.insert(noteStateBackups).values({ noteId, ydoc: ydocBuf, createdAt: at });
    } catch (err) {
      if (isForeignKeyViolation(err)) return;
      throw err;
    }
    svCache.set(noteId, sv);
    lastBackupAtCache.set(noteId, at);

    // selectPrunable returns the original Date objects, so rows are matched by identity.
    const rows = await db.select({ id: noteStateBackups.id, createdAt: noteStateBackups.createdAt }).from(noteStateBackups).where(eq(noteStateBackups.noteId, noteId));
    const timestamps = rows.map(r => r.createdAt);
    const prunable = new Set(selectPrunable(timestamps, at));
    const prunableIds = rows.filter(r => prunable.has(r.createdAt)).map(r => r.id);
    for (const id of prunableIds) {
      await db.delete(noteStateBackups).where(eq(noteStateBackups.id, id));
    }
  }

  async function onStoreDocument(noteId: string, doc: Y.Doc): Promise<void> {
    const at = now();
    const ydocBuf = Buffer.from(Y.encodeStateAsUpdate(doc));
    // #93: extract in the same tick as the encode, before any await, so the index describes exactly
    // ydocBuf. Invariant: every index row describes a persisted note_states version.
    let extract: SearchExtract | null = null;
    try {
      extract = extractFn(doc);
    } catch (err) {
      try {
        log.warn({ err, noteId }, "全文索引抽取失敗（不影響落盤/備份；跳過本次索引）");
      } catch {
        /* logger threw */
      }
    }

    // Same tick as the encode, for the same reason. A failure only skips the knowledge index for this store.
    let knowledgeExtract: KnowledgeIndexExtract | null = null;
    try {
      knowledgeExtract = extractKnowledgeFn(doc, ydocBuf);
    } catch (err) {
      try {
        log.warn({ ...knowledgeErrorFields(err), noteId }, "knowledge index extraction failed (persist unaffected; skipping this update)");
      } catch {
        /* logger threw */
      }
    }

    const version = await persistNoteState(noteId, ydocBuf, at);
    if (version === null) {
      forgetNote(noteId);
      return;
    }
    await deps.afterPersistForTest?.(noteId, doc);

    await maybeBackup(noteId, doc, at);

    // Diagnostic only: after maybeBackup and fully caught, since a throw out of onStoreDocument pins the doc.
    if (!warnedUnsafeUrl.has(noteId)) {
      try {
        const findings = collectUnsafeUrlFindings(doc);
        if (findings.length > 0) {
          warnedUnsafeUrl.add(noteId);
          // Cap the distinct lists too: block names are client-chosen, so log line size must not be.
          const schemes = [...new Set(findings.map(f => f.scheme))];
          const blocks = [...new Set(findings.map(f => f.block))];
          log.warn(
            {
              noteId,
              findings: findings.length,
              schemes: schemes.slice(0, 10),
              schemesTotal: schemes.length,
              blocks: blocks.slice(0, 10),
              blocksTotal: blocks.length,
            },
            "筆記內容含非 http(s) scheme 的媒體 URL（僅記錄；渲染與匯出端各有守衛，此處不改寫文件）"
          );
        }
      } catch (err) {
        // Mark as warned even on failure, and guard the log too: a throwing logger would pin the doc as well.
        warnedUnsafeUrl.add(noteId);
        try {
          log.warn({ err, noteId }, "危險 URL 掃描失敗（忽略，不影響落盤/備份）");
        } catch {
          /* logger threw: nowhere to log */
        }
      }
    }

    // #93: last and fully caught, like the scan: index failures must not affect persistence or escape onStoreDocument.
    if (extract !== null) {
      try {
        let needFull = indexedHash.get(noteId) !== extract.contentHash;
        if (!needFull) {
          const bumped = await bumper(noteId, version, extract.contentHash);
          // 0 rows: the index changed out of band, so the cache is stale; reindex fully in this same store.
          if (bumped === 0) {
            indexedHash.delete(noteId);
            needFull = true;
          }
        }
        if (needFull) {
          const outcome = await indexer(noteId, version, extract);
          if (outcome === "written" || outcome === "unchanged") indexedHash.set(noteId, extract.contentHash);
        }
      } catch (err) {
        try {
          log.warn({ err, noteId }, "全文索引更新失敗（不影響落盤/備份；下次內容變更落盤或重啟回填時重試）");
        } catch {
          /* logger threw: nowhere to log */
        }
      }
    }

    if (knowledgeExtract !== null) await indexKnowledge(noteId, version, knowledgeExtract);
  }

  // Own try, after the search index: nothing in here may fail the store or hold up the next debounce longer than a few statements.
  async function indexKnowledge(noteId: string, version: number, extract: KnowledgeIndexExtract): Promise<void> {
    try {
      let needFull = knowledgeIndexedHash.get(noteId) !== extract.contentHash;
      if (!needFull) {
        const bumped = await knowledgeBumper(noteId, version, extract.contentHash);
        if (bumped === 0) {
          knowledgeIndexedHash.delete(noteId);
          needFull = true;
        }
      }
      if (needFull) {
        const outcome = await knowledgeIndexer(noteId, version, extract);
        if (outcome === "written" || outcome === "unchanged") knowledgeIndexedHash.set(noteId, extract.contentHash);
      }
    } catch (err) {
      try {
        log.warn({ ...knowledgeErrorFields(err), noteId }, "knowledge index update failed (persist unaffected; retried on the next change or the next start)");
      } catch {
        /* logger threw: nowhere to log */
      }
    }
  }

  return { onLoadDocument, onStoreDocument, afterUnloadDocument: forgetNote };
}
