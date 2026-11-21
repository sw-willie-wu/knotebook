/**
 * Workers run from source via vitest (the tsx bootstrap in `spawnParseWorker`); the round-trip corpus is every case of
 * `packages/shared/test-fixtures/note-markdown-goldens.json`.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { DOC_INLINE_MAX_BYTES, DOC_TOO_COMPLEX, decodeState, stateEquals, type DocOp, type DocOpOf } from "../../src/notes/editing/doc-jobs.js";
import { ParsePool } from "../../src/notes/editing/parse-pool.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";

const BASE = "http://localhost/";
const rt = new EditingRuntime({ baseUrl: BASE }); // same thread (the InlineMarkdownParser entry always runs runDoc here)
rt.installGlobals();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pools: ParsePool[] = [];
async function workerRuntime(o: Partial<{ timeoutMs: number; workerMemoryMb: number }> = {}): Promise<{ wrt: EditingRuntime; pool: ParsePool }> {
  const pool = new ParsePool({ baseUrl: BASE, workers: 1, workerMemoryMb: 1024, timeoutMs: 60_000, queueWaitMs: 120_000, ...o });
  pools.push(pool);
  const until = Date.now() + 120_000;
  while (pool.stats().ready < 1) {
    if (Date.now() > until) throw new Error("worker 沒有在時限內 ready");
    await sleep(20);
  }
  // Not installGlobals: this runtime's conversions always go to the worker (inlineMaxBytes 0); the main-thread globals are installed by `rt`.
  return { wrt: new EditingRuntime({ baseUrl: BASE, parser: pool, inlineMaxBytes: 0 }), pool };
}
afterAll(async () => {
  for (const p of pools) await p.close();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple
type AnyBlocks = any[];
type GoldenCase = { id: string; roundTrip: string; blocks: AnyBlocks; markdown: string };
const goldens = JSON.parse(readFileSync(new URL("../../../../packages/shared/test-fixtures/note-markdown-goldens.json", import.meta.url), "utf8")) as { cases: GoldenCase[] };

async function stateWith(blocks: AnyBlocks): Promise<Uint8Array> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, blocks);
  } finally {
    s.close();
  }
  return Y.encodeStateAsUpdate(doc);
}
const noTitles = async () => [] as Array<[string, string]>;
/** The diff carries the fork's clientID (random each time): compare base+diff content, not diff bytes. */
function applied(state: Uint8Array, diff: Uint8Array): Y.Doc {
  const doc = decodeState(state);
  Y.applyUpdate(doc, diff);
  return doc;
}
const KEY = new Uint8Array(32).fill(7);
const SALT = new Uint8Array(16).fill(3);

describe("worker answers match the same-thread answers (every round-trip corpus case)", () => {
  let wrt: EditingRuntime;
  beforeAll(async () => {
    ({ wrt } = await workerRuntime());
  }, 180_000);

  it("read (whole note and _top section), outline, exportFile, edit (append), revert (undo that append)", async () => {
    let checked = 0;
    for (const c of goldens.cases) {
      if (c.roundTrip === "reject:unsupported_columns") continue;
      const state = await stateWith(c.blocks);
      const both = async <K extends DocOp["kind"]>(op: DocOpOf<K>) => {
        const a = await rt.runDoc<K>("u", op, { ask: noTitles });
        const b = await wrt.runDoc<K>("u", { ...op, state: new Uint8Array(op.state) }, { ask: noTitles });
        return [a, b] as const;
      };
      const [r1, r2] = await both({ kind: "read", state, wantShown: true });
      expect(r2, c.id).toEqual(r1);
      const [s1, s2] = await both({ kind: "read", state, section: "_top", wantShown: false });
      expect(s2, c.id).toEqual(s1);
      const [o1, o2] = await both({ kind: "outline", state });
      expect(o2, c.id).toEqual(o1);
      const [x1, x2] = await both({ kind: "exportFile", state, key: KEY, salt: SALT });
      // `stats.yields` yields based on the wall clock (every >= 20 ms), so counts can differ between the two; everything else is identical.
      const noYields = (x: typeof x1) => (x === DOC_TOO_COMPLEX ? x : { ...x, stats: { ...x.stats, yields: 0 } });
      expect(noYields(x2), c.id).toEqual(noYields(x1));
      const tail = [{ type: "paragraph", content: "尾巴" }];
      const [e1, e2] = await both({ kind: "edit", noteId: "00000000-0000-4000-8000-000000000000", state, op: "append", blocks: tail });
      if (e1 === DOC_TOO_COMPLEX || e2 === DOC_TOO_COMPLEX || !e1.ok || !e2.ok) throw new Error(`${c.id}: edit failed`);
      // The diff and the post-edit size carry the fork's random clientID and the new block's random id (varints, so a few bytes apart): not compared byte for byte.
      const { diff: d1, size: { stateAfter: z1, ...m1s }, ...p1 } = e1.post;
      const { diff: d2, size: { stateAfter: z2, ...m2s }, ...p2 } = e2.post;
      expect(p2, c.id).toEqual(p1); // the merged values (fingerprint, outline, version fingerprint, link targets, base snapshot) are identical
      expect(m2s, c.id).toEqual(m1s); // size before the change, and the amount of content remaining before/after, are identical
      expect(Math.abs(z2 - z1), c.id).toBeLessThan(64);
      expect(e2.afterIds.length, c.id).toBe(e1.afterIds.length);
      const m1 = applied(state, d1);
      const m2 = applied(state, d2);
      const [after1, after2] = await both({ kind: "read", state: Y.encodeStateAsUpdate(m1), wantShown: false });
      expect(after1, c.id).toEqual((await rt.runDoc("u", { kind: "read", state: Y.encodeStateAsUpdate(m2), wantShown: false })));
      expect(after2, c.id).toEqual(after1);
      const s1Rev = Y.encodeStateAsUpdate(m1);
      const s2Rev = Y.encodeStateAsUpdate(m2);
      const row = (ids: string[], fp: string | null) => ({ op: "append", afterBlockIds: ids, afterFingerprint: fp, beforeBlocks: [], anchor: null });
      const v1 = await rt.runDoc("u", { kind: "revert", state: s1Rev, row: row(e1.afterIds, e1.post.afterFingerprint), othersShareAnchor: false });
      const v2 = await wrt.runDoc("u", { kind: "revert", state: s2Rev, row: row(e2.afterIds, e2.post.afterFingerprint), othersShareAnchor: false });
      if (v1 === DOC_TOO_COMPLEX || v2 === DOC_TOO_COMPLEX || !v1.ok || !v2.ok) throw new Error(`${c.id}: revert failed`);
      expect(v2.post.fingerprint, c.id).toBe(v1.post.fingerprint);
      expect(v2.post.fingerprint, c.id).toBe(o1 === DOC_TOO_COMPLEX ? null : o1.whole);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  }, 600_000);

  it("exportFile link titles are asked of the main thread via ask; the worker gets the same answer as the same-thread run", async () => {
    const target = "00000000-0000-4000-8000-000000000001";
    const state = await stateWith([{ type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: target, snapshotTitle: "舊標題", label: "" } }] }]);
    const asked: string[][] = [];
    const ask = async (q: { kind: string; ids?: string[] }) => {
      asked.push(q.ids ?? []);
      return [[target, "現在的標題"]];
    };
    const a = await rt.runDoc("u", { kind: "read", state, wantShown: true }, { ask: ask as never });
    const b = await wrt.runDoc("u", { kind: "read", state: new Uint8Array(state), wantShown: true }, { ask: ask as never });
    expect(b).toEqual(a);
    expect(JSON.stringify(a)).toContain("現在的標題");
    expect(asked).toEqual([[target], [target]]);
  }, 120_000);

  it("ask throws on the main thread -> the job in the worker fails -> runDoc rejects (a programming error, the caller gives 500), and the worker remains usable", async () => {
    const target = "00000000-0000-4000-8000-000000000002";
    const state = await stateWith([{ type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: target, snapshotTitle: "t", label: "" } }] }]);
    await expect(wrt.runDoc("u", { kind: "read", state, wantShown: false }, { ask: async () => { throw new Error("db down"); } })).rejects.toThrow(/parse worker/);
    expect(await wrt.runDoc("u", { kind: "outline", state: await stateWith([{ type: "paragraph", content: "ok" }]) })).toMatchObject({ outline: expect.any(Array) });
  }, 120_000);
});

describe("sizes before and after a change (for the note size limit)", () => {
  it("sizeAfter = size of base + diff applied to a new document: replacing the whole note with a shorter one makes it smaller (not the size of the edited fork, whose undo history keeps deleted content)", async () => {
    const paras = Array.from({ length: 300 }, (_, k) => ({ type: "paragraph", content: `p ${k} lorem ipsum dolor sit amet consectetur` }));
    const state = await stateWith(paras);
    const r = await rt.runDoc("u", { kind: "edit", noteId: "00000000-0000-4000-8000-000000000000", state, op: "replace_all", blocks: [{ type: "paragraph", content: "short" }] });
    if (r === DOC_TOO_COMPLEX || !r.ok) throw new Error("edit failed");
    expect(r.post.size.stateBefore).toBe(state.byteLength);
    expect(r.post.size.stateAfter).toBeLessThan(state.byteLength / 5);
    expect(r.post.size.stateAfter).toBe(Y.encodeStateAsUpdate(applied(state, r.post.diff)).byteLength);
    expect(r.post.size.liveAfter).toBeLessThan(r.post.size.liveBefore);
  });
});

describe("merge condition: snapshot (state vector + delete set)", () => {
  it("a deletion-only update leaves the state vector unchanged but stateEquals detects it; adding text is detected too; unchanged = equal", async () => {
    const doc = decodeState(await stateWith([{ type: "paragraph", content: "abc" }, { type: "paragraph", content: "def" }]));
    const snap = Y.encodeSnapshot(Y.snapshot(doc));
    expect(stateEquals(doc, snap)).toBe(true);
    const sv = Y.encodeStateVector(doc);
    const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
    doc.transact(() => {
      const group = fragment.get(0) as Y.XmlElement; // blockGroup
      group.delete(group.length - 1, 1);
    });
    expect(Buffer.from(Y.encodeStateVector(doc)).equals(Buffer.from(sv))).toBe(true);
    expect(stateEquals(doc, snap)).toBe(false);
    const fork = decodeState(Y.encodeStateAsUpdate(doc));
    expect(stateEquals(fork, Y.encodeSnapshot(Y.snapshot(doc))), "編碼再解開的那份＝原文件").toBe(true);
    const snap2 = Y.encodeSnapshot(Y.snapshot(doc));
    doc.transact(() => (fragment.get(0) as Y.XmlElement).insert(0, [new Y.XmlElement("blockContainer")]));
    expect(stateEquals(doc, snap2), "加東西也判得出來").toBe(false);
  });
});

describe("worker timeout or crash -> too_complex; threshold; transfer", () => {
  const big = () => stateWith([{ type: "paragraph", content: Array.from({ length: 30_000 }, (_, k) => (k % 2 ? { type: "text", text: "x", styles: {} } : { type: "hardBreak" })) as never }]);

  it("read timeout (limit 300 ms) -> too_complex, the worker is replaced; the replacement works as usual", async () => {
    const { wrt, pool } = await workerRuntime({ timeoutMs: 100 });
    const state = await big();
    expect(await wrt.runDoc("u", { kind: "read", state, wantShown: false }, { timeoutMs: 300 })).toBe(DOC_TOO_COMPLEX);
    expect(pool.stats().timedOut).toBe(1);
    expect(await wrt.runDoc("u", { kind: "outline", state: await stateWith([{ type: "paragraph", content: "ok" }]) })).toMatchObject({ whole: expect.any(String) });
  }, 180_000);

  it("read exhausts worker memory (limit 64 MiB) -> too_complex, the main process survives", async () => {
    const { wrt, pool } = await workerRuntime({ workerMemoryMb: 64 });
    expect(await wrt.runDoc("u", { kind: "read", state: await big(), wantShown: false })).toBe(DOC_TOO_COMPLEX);
    expect(pool.stats().crashed).toBe(1);
  }, 180_000);

  it("threshold: state smaller than DOC_INLINE_MAX_BYTES runs on the main thread (not in a worker); equal or larger goes to the worker", async () => {
    const pool = new ParsePool({ baseUrl: BASE, workers: 1, workerMemoryMb: 512, timeoutMs: 60_000, queueWaitMs: 60_000 });
    pools.push(pool);
    const sent: string[] = [];
    const orig = pool.runDoc.bind(pool);
    pool.runDoc = (owner, op, ask, t) => {
      sent.push(op.kind);
      return orig(owner, op, ask, t);
    };
    const prt = new EditingRuntime({ baseUrl: BASE, parser: pool });
    const small = await stateWith([{ type: "paragraph", content: "小" }]);
    expect(small.byteLength).toBeLessThan(DOC_INLINE_MAX_BYTES);
    await prt.runDoc("u", { kind: "outline", state: small });
    expect(sent).toEqual([]);
    await prt.runDoc("u", { kind: "outline", state: small }, { extraWeight: DOC_INLINE_MAX_BYTES });
    expect(sent).toEqual(["outline"]);
  }, 180_000);

  it("state >= 64 KiB that owns its whole ArrayBuffer is transferred to the worker (the caller's copy is taken); a small Buffer sliced from the pg shared pool is copied", async () => {
    const { wrt } = await workerRuntime();
    const state = await big();
    expect(state.byteLength).toBeGreaterThan(64 * 1024);
    await wrt.runDoc("u", { kind: "outline", state });
    expect(state.byteLength, "transfer 之後原來那份變空").toBe(0);
    const pooled = Buffer.from(await stateWith([{ type: "paragraph", content: "池" }]));
    const len = pooled.byteLength;
    await wrt.runDoc("u", { kind: "outline", state: pooled });
    expect(pooled.byteLength).toBe(len);
  }, 180_000);

  it("state >= 64 KiB that does not own its whole ArrayBuffer (a slice: byteOffset != 0, or only the front part) is copied, not transferred: other data in the shared buffer is not taken away, and the answer is still correct", async () => {
    const { wrt } = await workerRuntime();
    const state = await big();
    const expected = await rt.runDoc("u", { kind: "outline", state: new Uint8Array(state) });
    // The state sits in the middle of a larger ArrayBuffer (other data before and after).
    const shared = new Uint8Array(state.byteLength + 200);
    shared.fill(7);
    shared.set(state, 100);
    const middle = shared.subarray(100, 100 + state.byteLength);
    expect(middle.byteOffset).toBe(100);
    expect(await wrt.runDoc("u", { kind: "outline", state: middle })).toEqual(expected);
    expect(shared.byteLength, "共用的那塊沒有被 transfer 掉").toBe(state.byteLength + 200);
    expect(shared[0]).toBe(7);
    // Starts at the beginning but covers only the front part.
    const head = new Uint8Array(state.byteLength + 100);
    head.set(state, 0);
    const front = head.subarray(0, state.byteLength);
    expect(await wrt.runDoc("u", { kind: "outline", state: front })).toEqual(expected);
    expect(head.byteLength).toBe(state.byteLength + 100);
  }, 180_000);
});

describe("merge guard and content amount", () => {
  const paras = Array.from({ length: 30 }, (_, k) => (k % 10 === 0 ? { type: "heading", content: `H${k}` } : { type: "paragraph", content: `p ${k} lorem ipsum dolor` }));
  it("guard: without if_match -> none; whole-note if_match (append/replace_all) -> any; paragraph if_match -> the target paragraph's top-level container item", async () => {
    const state = await stateWith(paras);
    const o = await rt.runDoc("u", { kind: "outline", state });
    if (o === DOC_TOO_COMPLEX) throw new Error("outline");
    const sec = o.outline.find(x => x.heading === "H10")!;
    const tail = [{ type: "paragraph", content: "t" }];
    const none = await rt.runDoc("u", { kind: "edit", noteId: "00000000-0000-4000-8000-000000000000", state, op: "append", blocks: tail });
    const any = await rt.runDoc("u", { kind: "edit", noteId: "00000000-0000-4000-8000-000000000000", state, op: "append", ifMatch: o.whole, blocks: tail });
    const blocks = await rt.runDoc("u", { kind: "edit", noteId: "00000000-0000-4000-8000-000000000000", state, op: "replace_section", sectionId: sec.sectionId, ifMatch: sec.fingerprint, blocks: tail });
    for (const r of [none, any, blocks]) if (r === DOC_TOO_COMPLEX || !r.ok) throw new Error("edit");
    expect((none as { post: { guard: unknown } }).post.guard).toEqual({ kind: "none" });
    expect((any as { post: { guard: unknown } }).post.guard).toEqual({ kind: "any" });
    const g = (blocks as { post: { guard: { kind: string; items: string[] } } }).post.guard;
    expect(g.kind).toBe("blocks");
    expect(g.items).toHaveLength(sec.blockIds.length);
  });

  it("remaining content amount: shortening a paragraph -> less; append -> more", async () => {
    const state = await stateWith(paras);
    const o = await rt.runDoc("u", { kind: "outline", state });
    if (o === DOC_TOO_COMPLEX) throw new Error("outline");
    const sec = o.outline.find(x => x.heading === "H10")!;
    const shorter = await rt.runDoc("u", { kind: "edit", noteId: "00000000-0000-4000-8000-000000000000", state, op: "replace_section", sectionId: sec.sectionId, ifMatch: sec.fingerprint, blocks: [{ type: "heading", content: "H10" }, { type: "paragraph", content: "short" }] });
    const app = await rt.runDoc("u", { kind: "edit", noteId: "00000000-0000-4000-8000-000000000000", state, op: "append", blocks: [{ type: "paragraph", content: "more" }] });
    if (shorter === DOC_TOO_COMPLEX || !shorter.ok || app === DOC_TOO_COMPLEX || !app.ok) throw new Error("edit");
    expect(shorter.post.size.liveAfter).toBeLessThan(shorter.post.size.liveBefore);
    expect(app.post.size.liveAfter).toBeGreaterThan(app.post.size.liveBefore);
  });
});
