/**
 * 讀出與套用的轉換（`doc-jobs.ts`）：worker 裡跑的答案與主執行緒（同執行緒）跑的逐位元組相同（round-trip 語料：
 * `packages/shared/test-fixtures/note-markdown-goldens.json` 每一案）；合併條件（快照比對）；worker 逾時、掛掉、問不到答案時的答案；
 * 在不在主執行緒跑的門檻。真的 worker 由 vitest 從原始碼開（`spawnParseWorker` 的 tsx 啟動碼）。
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
const rt = new EditingRuntime({ baseUrl: BASE }); // 同執行緒（解析入口是 InlineMarkdownParser → runDoc 一律在這裡跑）
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
  // 不 installGlobals：這個 runtime 的轉換一律送 worker（inlineMaxBytes 0），主執行緒的全域由 `rt` 掛。
  return { wrt: new EditingRuntime({ baseUrl: BASE, parser: pool, inlineMaxBytes: 0 }), pool };
}
afterAll(async () => {
  for (const p of pools) await p.close();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組
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
/** diff 帶 fork 的 clientID（每次隨機）：比「基底＋diff」的內容，不比 diff 位元組。 */
function applied(state: Uint8Array, diff: Uint8Array): Y.Doc {
  const doc = decodeState(state);
  Y.applyUpdate(doc, diff);
  return doc;
}
const KEY = new Uint8Array(32).fill(7);
const SALT = new Uint8Array(16).fill(3);

describe("worker 與同執行緒的答案相同（round-trip 語料每一案）", () => {
  let wrt: EditingRuntime;
  beforeAll(async () => {
    ({ wrt } = await workerRuntime());
  }, 180_000);

  it("read（整篇與 _top 段）、outline、exportFile、edit（append）、revert（撤回那次 append）", async () => {
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
      // `stats.yields` 依牆鐘讓出（距上次 ≥ 20 ms 就讓），兩邊次數可能不同；其餘逐一相同。
      const noYields = (x: typeof x1) => (x === DOC_TOO_COMPLEX ? x : { ...x, stats: { ...x.stats, yields: 0 } });
      expect(noYields(x2), c.id).toEqual(noYields(x1));
      const tail = [{ type: "paragraph", content: "尾巴" }];
      const [e1, e2] = await both({ kind: "edit", state, op: "append", blocks: tail });
      if (e1 === DOC_TOO_COMPLEX || e2 === DOC_TOO_COMPLEX || !e1.ok || !e2.ok) throw new Error(`${c.id}: edit failed`);
      // diff 與編輯後的大小帶 fork 的隨機 clientID 與新 block 的隨機 id（變長整數，差幾個位元組）：不逐位元組比
      const { diff: d1, size: { stateAfter: z1, ...m1s }, ...p1 } = e1.post;
      const { diff: d2, size: { stateAfter: z2, ...m2s }, ...p2 } = e2.post;
      expect(p2, c.id).toEqual(p1); // 合併後的值（指紋、大綱、版本指紋、連結目標、基底快照）逐一相同
      expect(m2s, c.id).toEqual(m1s); // 修改前大小、前後還在的內容量
      expect(Math.abs(z2 - z1), c.id).toBeLessThan(64);
      expect(e2.afterIds.length, c.id).toBe(e1.afterIds.length);
      const m1 = applied(state, d1);
      const m2 = applied(state, d2);
      const [after1, after2] = await both({ kind: "read", state: Y.encodeStateAsUpdate(m1), wantShown: false });
      expect(after1, c.id).toEqual((await rt.runDoc("u", { kind: "read", state: Y.encodeStateAsUpdate(m2), wantShown: false })));
      expect(after2, c.id).toEqual(after1);
      // 撤回剛才那次 append（兩邊各撤自己的）
      const s1Rev = Y.encodeStateAsUpdate(m1);
      const s2Rev = Y.encodeStateAsUpdate(m2);
      const row = (ids: string[], fp: string | null) => ({ op: "append", afterBlockIds: ids, afterFingerprint: fp, beforeBlocks: [], anchor: null });
      const v1 = await rt.runDoc("u", { kind: "revert", state: s1Rev, row: row(e1.afterIds, e1.post.afterFingerprint), othersShareAnchor: false });
      const v2 = await wrt.runDoc("u", { kind: "revert", state: s2Rev, row: row(e2.afterIds, e2.post.afterFingerprint), othersShareAnchor: false });
      if (v1 === DOC_TOO_COMPLEX || v2 === DOC_TOO_COMPLEX || !v1.ok || !v2.ok) throw new Error(`${c.id}: revert failed`);
      expect(v2.post.fingerprint, c.id).toBe(v1.post.fingerprint);
      expect(v2.post.fingerprint, c.id).toBe(o1 === DOC_TOO_COMPLEX ? null : o1.whole); // 撤回後回到原文
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  }, 600_000);

  it("exportFile 的連結標題經 ask 問主執行緒；worker 拿到的答案與同執行緒相同", async () => {
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

  it("ask 在主執行緒丟例外 → worker 裡的工作失敗 → runDoc reject（程式錯，呼叫端 500），worker 照常可用", async () => {
    const target = "00000000-0000-4000-8000-000000000002";
    const state = await stateWith([{ type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: target, snapshotTitle: "t", label: "" } }] }]);
    await expect(wrt.runDoc("u", { kind: "read", state, wantShown: false }, { ask: async () => { throw new Error("db down"); } })).rejects.toThrow(/parse worker/);
    expect(await wrt.runDoc("u", { kind: "outline", state: await stateWith([{ type: "paragraph", content: "ok" }]) })).toMatchObject({ outline: expect.any(Array) });
  }, 120_000);
});

describe("修改前後的大小（筆記大小上限用）", () => {
  it("sizeAfter＝基底＋diff 套在新文件上的大小：整篇換成短的 → 變小（不是編輯過的 fork 的大小——fork 的復原紀錄留著被刪的內容）", async () => {
    const paras = Array.from({ length: 300 }, (_, k) => ({ type: "paragraph", content: `p ${k} lorem ipsum dolor sit amet consectetur` }));
    const state = await stateWith(paras);
    const r = await rt.runDoc("u", { kind: "edit", state, op: "replace_all", blocks: [{ type: "paragraph", content: "short" }] });
    if (r === DOC_TOO_COMPLEX || !r.ok) throw new Error("edit failed");
    expect(r.post.size.stateBefore).toBe(state.byteLength);
    expect(r.post.size.stateAfter).toBeLessThan(state.byteLength / 5);
    expect(r.post.size.stateAfter).toBe(Y.encodeStateAsUpdate(applied(state, r.post.diff)).byteLength);
    expect(r.post.size.liveAfter).toBeLessThan(r.post.size.liveBefore);
  });
});

describe("合併條件：快照（state vector＋刪除集）", () => {
  it("只有刪除的更新不改 state vector，但 stateEquals 判得出來；加字也判得出來；沒變＝相等", async () => {
    const doc = decodeState(await stateWith([{ type: "paragraph", content: "abc" }, { type: "paragraph", content: "def" }]));
    const snap = Y.encodeSnapshot(Y.snapshot(doc));
    expect(stateEquals(doc, snap)).toBe(true);
    const sv = Y.encodeStateVector(doc);
    const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
    // 刪掉最後一段：只動刪除集
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

describe("worker 逾時、掛掉 → \"too_complex\"；門檻；transfer", () => {
  const big = () => stateWith([{ type: "paragraph", content: Array.from({ length: 30_000 }, (_, k) => (k % 2 ? { type: "text", text: "x", styles: {} } : { type: "hardBreak" })) as never }]);

  it("讀出逾時（時限 300 ms）→ too_complex、worker 換掉；換上的照常", async () => {
    const { wrt, pool } = await workerRuntime({ timeoutMs: 100 });
    const state = await big();
    expect(await wrt.runDoc("u", { kind: "read", state, wantShown: false }, { timeoutMs: 300 })).toBe(DOC_TOO_COMPLEX);
    expect(pool.stats().timedOut).toBe(1);
    expect(await wrt.runDoc("u", { kind: "outline", state: await stateWith([{ type: "paragraph", content: "ok" }]) })).toMatchObject({ whole: expect.any(String) });
  }, 180_000);

  it("讀出用完 worker 記憶體（上限 64 MiB）→ too_complex、主程序活著", async () => {
    const { wrt, pool } = await workerRuntime({ workerMemoryMb: 64 });
    expect(await wrt.runDoc("u", { kind: "read", state: await big(), wantShown: false })).toBe(DOC_TOO_COMPLEX);
    expect(pool.stats().crashed).toBe(1);
  }, 180_000);

  it("門檻：狀態小於 DOC_INLINE_MAX_BYTES 在主執行緒跑（不進 worker）；大於等於的送 worker", async () => {
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

  it("≥ 64 KiB 且自己佔整個 ArrayBuffer 的狀態 transfer 給 worker（呼叫端那份被拿走）；pg 共用池切出來的小 Buffer 複製", async () => {
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

  it("≥ 64 KiB 但不是自己佔整個 ArrayBuffer（切片：byteOffset ≠ 0，或只佔前段）→ 複製、不 transfer：共用那塊的其他資料不被拿走，答案照樣對（審查 r4 M5／突變 G）", async () => {
    const { wrt } = await workerRuntime();
    const state = await big();
    const expected = await rt.runDoc("u", { kind: "outline", state: new Uint8Array(state) });
    // 狀態放在一塊更大的 ArrayBuffer 中間（前後各有別的資料）
    const shared = new Uint8Array(state.byteLength + 200);
    shared.fill(7);
    shared.set(state, 100);
    const middle = shared.subarray(100, 100 + state.byteLength);
    expect(middle.byteOffset).toBe(100);
    expect(await wrt.runDoc("u", { kind: "outline", state: middle })).toEqual(expected);
    expect(shared.byteLength, "共用的那塊沒有被 transfer 掉").toBe(state.byteLength + 200);
    expect(shared[0]).toBe(7);
    // 從開頭起、但只佔前段
    const head = new Uint8Array(state.byteLength + 100);
    head.set(state, 0);
    const front = head.subarray(0, state.byteLength);
    expect(await wrt.runDoc("u", { kind: "outline", state: front })).toEqual(expected);
    expect(head.byteLength).toBe(state.byteLength + 100);
  }, 180_000);
});

describe("合併守衛與內容量（審查 r4 I1、I3）", () => {
  const paras = Array.from({ length: 30 }, (_, k) => (k % 10 === 0 ? { type: "heading", content: `H${k}` } : { type: "paragraph", content: `p ${k} lorem ipsum dolor` }));
  it("守衛：不帶 if_match → none；整篇 if_match（append／replace_all）→ any；段落 if_match → 目標段的頂層容器 item", async () => {
    const state = await stateWith(paras);
    const o = await rt.runDoc("u", { kind: "outline", state });
    if (o === DOC_TOO_COMPLEX) throw new Error("outline");
    const sec = o.outline.find(x => x.heading === "H10")!;
    const tail = [{ type: "paragraph", content: "t" }];
    const none = await rt.runDoc("u", { kind: "edit", state, op: "append", blocks: tail });
    const any = await rt.runDoc("u", { kind: "edit", state, op: "append", ifMatch: o.whole, blocks: tail });
    const blocks = await rt.runDoc("u", { kind: "edit", state, op: "replace_section", sectionId: sec.sectionId, ifMatch: sec.fingerprint, blocks: tail });
    for (const r of [none, any, blocks]) if (r === DOC_TOO_COMPLEX || !r.ok) throw new Error("edit");
    expect((none as { post: { guard: unknown } }).post.guard).toEqual({ kind: "none" });
    expect((any as { post: { guard: unknown } }).post.guard).toEqual({ kind: "any" });
    const g = (blocks as { post: { guard: { kind: string; items: string[] } } }).post.guard;
    expect(g.kind).toBe("blocks");
    expect(g.items).toHaveLength(sec.blockIds.length);
  });

  it("還在的內容量：把一段改短 → 變少；append → 變多", async () => {
    const state = await stateWith(paras);
    const o = await rt.runDoc("u", { kind: "outline", state });
    if (o === DOC_TOO_COMPLEX) throw new Error("outline");
    const sec = o.outline.find(x => x.heading === "H10")!;
    const shorter = await rt.runDoc("u", { kind: "edit", state, op: "replace_section", sectionId: sec.sectionId, ifMatch: sec.fingerprint, blocks: [{ type: "heading", content: "H10" }, { type: "paragraph", content: "short" }] });
    const app = await rt.runDoc("u", { kind: "edit", state, op: "append", blocks: [{ type: "paragraph", content: "more" }] });
    if (shorter === DOC_TOO_COMPLEX || !shorter.ok || app === DOC_TOO_COMPLEX || !app.ok) throw new Error("edit");
    expect(shorter.post.size.liveAfter).toBeLessThan(shorter.post.size.liveBefore);
    expect(app.post.size.liveAfter).toBeGreaterThan(app.post.size.liveBefore);
  });
});
