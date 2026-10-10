// 版本歷史整合測試的共用縫（spec 2026-10-09 §11.2）。文件一律以「BlockNote 形」手造（blockGroup > blockContainer(id) > paragraph > XmlText），
// 不 mount 編輯器——版本服務只讀 Yjs 結構，造法與內容指紋無關。例外：`seedOldNote` 模擬「瀏覽器寫過的舊筆記」，走 EditorSession。
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { noteVersions, notes } from "../src/db/schema.js";
import type { VersionDocsHost, VersionTimers } from "../src/collab/versions.js";
import type { NoteVersionRow } from "../src/notes/tx/versions.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { seedDoc } from "./copy-helpers.js";
import { testEditingRuntime } from "./helpers.js";

export function paraDoc(texts: string[]): Y.Doc {
  const doc = new Y.Doc();
  const g = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [g]);
  const pending: Array<[Y.XmlText, string]> = [];
  g.insert(0, texts.map(text => {
    const c = new Y.XmlElement("blockContainer");
    c.setAttribute("id", randomUUID());
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    p.insert(0, [t]);
    c.insert(0, [p]);
    pending.push([t, text]);
    return c;
  }));
  for (const [t, s] of pending) if (s) t.insert(0, s);
  return doc;
}

/** 5000 層巢狀（每層 blockContainer > [paragraph, blockGroup]）：`canonicalizeNode` 的遞迴在這個深度 RangeError（r3 實跑）。 */
export function deepDoc(depth: number): Y.Doc {
  const doc = new Y.Doc();
  const g = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [g]);
  let parent: Y.XmlElement = g;
  for (let i = 0; i < depth; i += 1) {
    const c = new Y.XmlElement("blockContainer");
    c.setAttribute("id", `d${i}`);
    const inner = new Y.XmlElement("blockGroup");
    c.insert(0, [new Y.XmlElement("paragraph"), inner]);
    parent.insert(0, [c]);
    parent = inner;
  }
  return doc;
}

/** 對第 i 顆頂層段落的 XmlText 做一次編輯（一個 transaction）。 */
export function editPara(doc: Y.Doc, i: number, fn: (t: Y.XmlText) => void): void {
  const p = topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT))[i]!.get(0) as Y.XmlElement;
  doc.transact(() => fn(p.get(0) as Y.XmlText));
}

export async function versionsOf(db: Db, noteId: string): Promise<NoteVersionRow[]> {
  return db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId)).orderBy(asc(noteVersions.seq));
}

export async function waitForVersionCount(db: Db, noteId: string, n: number, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  let last = -1;
  while (Date.now() < deadline) {
    last = (await versionsOf(db, noteId)).length;
    if (last === n) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`等待逾時（${ms}ms）：note_versions 列數 ${last}，期望 ${n}`);
}

export async function noteBase(db: Db, noteId: string): Promise<{ counter: number; baseSeq: number | null; baseFingerprint: string | null }> {
  const [r] = await db
    .select({ counter: notes.versionCounter, baseSeq: notes.versionBaseSeq, baseFingerprint: notes.versionBaseFingerprint })
    .from(notes)
    .where(eq(notes.id, noteId));
  return r!;
}

/** 「舊筆記」：功能上線前就存在、`note_states` 有內容、沒有任何版本（以 server 端 EditorSession 寫 markdown 再直接插 `note_states`）。 */
export async function seedOldNote(db: Db, noteId: string, markdown: string): Promise<void> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(testEditingRuntime, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, s.editor.tryParseMarkdownToBlocks(markdown));
  } finally {
    s.close();
  }
  await seedDoc(db, noteId, doc);
}

export function fakeHost(): VersionDocsHost & { docs: Map<string, Y.Doc> } {
  const docs = new Map<string, Y.Doc>();
  return { docs, documents: { get: name => docs.get(name), has: name => docs.has(name) } };
}

/** 手動觸發的計時器：`set` 只登記，`fire()` 一次跑完目前登記的全部回呼（測試不睡）。 */
export function manualTimers(): { timers: VersionTimers; fire(): void; size(): number } {
  const pending = new Map<number, () => void>();
  let n = 0;
  return {
    timers: {
      set: fn => {
        n += 1;
        pending.set(n, fn);
        return n;
      },
      clear: h => {
        pending.delete(h as number);
      },
    },
    fire: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const f of fns) f();
    },
    size: () => pending.size,
  };
}
