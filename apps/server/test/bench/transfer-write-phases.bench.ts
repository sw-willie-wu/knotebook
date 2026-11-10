/**
 * bulk transfer plan PR-2 T14：寫回單篇的**細分段同步耗時**——找出 ≥ 100 ms 的同步段。**不進 CI**、不改 src：
 * 用 `vi.mock` 把寫回路徑上會跨模組呼叫的函式包一層計時（同步函式＝那一段就是一次同步停頓；非同步函式記牆鐘），
 * `EditorSession.open`（mount）與 `diffSince` 直接在類別上換掉。用法同 `transfer-write.bench.ts`（`BENCH_OUT`、`RUNS`、
 * `SIZES`、`REGIONS`），輸出每個函式在每次寫回裡的最大值與 p95。
 */
import { appendFileSync } from "node:fs";
import { performance as perf } from "node:perf_hooks";
import { it, vi } from "vitest";

const rec = new Map<string, number[]>();
let cur = new Map<string, number>();
const note = (name: string, ms: number) => cur.set(name, Math.max(cur.get(name) ?? 0, ms));
/** 保留 `this`（也拿來包原型方法）。 */
function wrapSync<A extends unknown[], R>(name: string, fn: (...a: A) => R): (...a: A) => R {
  return function (this: unknown, ...a: A) {
    const t0 = perf.now();
    try {
      return fn.apply(this, a);
    } finally {
      note(name, perf.now() - t0);
    }
  };
}
function wrapAsync<A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
  return async (...a: A) => {
    const t0 = perf.now();
    try {
      return await fn(...a);
    } finally {
      note(name, perf.now() - t0);
    }
  };
}

vi.mock("../../src/notes/editing/fingerprint.js", async orig => {
  const m = await orig<typeof import("../../src/notes/editing/fingerprint.js")>();
  return {
    ...m,
    outlineOf: wrapSync("[sync] outlineOf", m.outlineOf),
    topLevelSnapshot: wrapSync("[sync] topLevelSnapshot", m.topLevelSnapshot),
    checkExpectations: wrapSync("[sync] checkExpectations", m.checkExpectations),
    fingerprintsOfGroups: wrapSync("[sync] fingerprintsOfGroups", m.fingerprintsOfGroups),
    fingerprintForIds: wrapSync("[sync] fingerprintForIds", m.fingerprintForIds),
  };
});
vi.mock("../../src/notes/version-fingerprint.js", async orig => {
  const m = await orig<typeof import("../../src/notes/version-fingerprint.js")>();
  return { ...m, versionFingerprint: wrapSync("[sync] versionFingerprint", m.versionFingerprint) };
});
vi.mock("../../src/notes/editing/markdown.js", async orig => {
  const m = await orig<typeof import("../../src/notes/editing/markdown.js")>();
  return { ...m, parseMarkdownForNote: wrapSync("[sync] parseMarkdownForNote", m.parseMarkdownForNote) };
});
vi.mock("../../src/transfer/decide.js", async orig => {
  const m = await orig<typeof import("../../src/transfer/decide.js")>();
  return { ...m, decide: wrapSync("[sync] decide", m.decide) };
});
vi.mock("../../src/transfer/regions.js", async orig => {
  const m = await orig<typeof import("../../src/transfer/regions.js")>();
  return { ...m, findRegions: wrapAsync("[wall] findRegions", m.findRegions) };
});
vi.mock("../../src/transfer/sync-plan.js", async orig => {
  const m = await orig<typeof import("../../src/transfer/sync-plan.js")>();
  return { ...m, planSync: wrapAsync("[wall] planSync", m.planSync) };
});
vi.mock("../../src/transfer/sync-apply.js", async orig => {
  const m = await orig<typeof import("../../src/transfer/sync-apply.js")>();
  return { ...m, applySync: wrapAsync("[wall] applySync", m.applySync) };
});
vi.mock("../../src/notes/editing/apply.js", async orig => {
  const m = await orig<typeof import("../../src/notes/editing/apply.js")>();
  return { ...m, forkAndCheck: wrapAsync("[wall] forkAndCheck", m.forkAndCheck), mergeDiff: wrapAsync("[wall] mergeDiff", m.mergeDiff) };
});

const { EditorSession } = await import("../../src/notes/editing/session.js");
const { BlockNoteEditor } = await import("@blocknote/core");
{
  const open = EditorSession.open.bind(EditorSession);
  EditorSession.open = async (runtime, fork) => {
    const t0 = perf.now();
    try {
      return await open(runtime, fork);
    } finally {
      note("[sync≈] EditorSession.open（create＋mount）", perf.now() - t0);
    }
  };
  const diffSince = EditorSession.prototype.diffSince;
  EditorSession.prototype.diffSince = wrapSync("[sync] diffSince", diffSince);
  const close = EditorSession.prototype.close;
  EditorSession.prototype.close = wrapSync("[sync] EditorSession.close（unmount）", close);
  const proto = BlockNoteEditor.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const k of ["insertBlocks", "replaceBlocks", "removeBlocks", "tryParseHTMLToBlocks", "mount", "unmount"]) proto[k] = wrapSync(`[sync] editor.${k}`, proto[k]!);
  const statics = BlockNoteEditor as unknown as Record<string, (...a: unknown[]) => unknown>;
  statics.create = wrapSync("[sync] BlockNoteEditor.create", statics.create!.bind(BlockNoteEditor));
  const docDesc = Object.getOwnPropertyDescriptor(BlockNoteEditor.prototype, "document")!;
  Object.defineProperty(BlockNoteEditor.prototype, "document", {
    ...docDesc,
    get(this: unknown) {
      const t0 = perf.now();
      try {
        return docDesc.get!.call(this);
      } finally {
        note("[sync] editor.document（getter）", perf.now() - t0);
      }
    },
  });
}

const { FixedWindowLimiter } = await import("../../src/http/rate-limit.js");
const { buildCollabTestApp } = await import("../helpers.js");
const { seedTokenForUser } = await import("../editing-helpers.js");
const { bulkPut, downloadNote, editBody, humanEdit, issueBulkDirect, seedBlocks } = await import("../bulk-transfer-helpers.js");

const RUNS = Number(process.env.RUNS ?? 10);
const OUT = process.env.BENCH_OUT ?? "transfer-write-phases.txt";
const SIZES = (process.env.SIZES ?? "2000").split(",").map(Number);
const REGIONS = (process.env.REGIONS ?? "1,5,20").split(",").map(Number);
const out = (s: string) => {
  appendFileSync(OUT, `${s}\n`, "utf8");
  process.stdout.write(`${s}\n`);
};
type Block = Record<string, unknown>;
function mixed(n: number): Block[] {
  return Array.from({ length: n }, (_, i) => {
    if (i % 10 === 0) return { type: "heading", content: `Section ${i / 10}`, props: { level: 2 } };
    if (i % 37 === 5) return { type: "codeBlock", props: { language: "js" }, content: `const x${i} = ${i};\nconsole.log(x${i});` };
    if (i % 53 === 7) return { type: "table", content: { type: "tableContent", rows: [{ cells: ["k", "v"] }, { cells: [`r${i}`, "value"] }] } };
    switch (i % 4) {
      case 0:
        return { type: "paragraph", content: `Paragraph ${i} with some words to make it realistic, 中文也有一些字。` };
      case 1:
        return { type: "bulletListItem", content: `bullet item ${i} text` };
      case 2:
        return { type: "numberedListItem", content: `numbered item ${i}` };
      default:
        return { type: "paragraph", content: `Another paragraph ${i}: lorem ipsum dolor sit amet.` };
    }
  });
}
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.max(0, Math.ceil((p / 100) * a.length) - 1)]!;

it("T14 phases", async () => {
  const unbounded = () => new FixedWindowLimiter({ limit: () => Number.MAX_SAFE_INTEGER, windowMs: 60_000 });
  const ctx = await buildCollabTestApp({ limiters: { transferWrite: unbounded(), tokenRead: unbounded(), contentRead: unbounded() } });
  const email = "phases@example.com";
  const u = await ctx.createUser({ email, password: "correct-horse-battery" });
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  out(`# T14 phases env=${process.env.BENCH_ENV ?? "A"} node=${process.version} RUNS=${RUNS}`);
  for (const n of SIZES) {
    for (const k of REGIONS) {
      for (const conflict of [false, true]) {
        const n0 = await ctx.createNote(u.id, `P ${n}`);
        await seedBlocks(ctx.db, n0.id, mixed(n));
        const session = await ctx.loginAs(email, "correct-horse-battery");
        const client = await session.connect(n0.id);
        rec.clear();
        for (let run = 0; run < RUNS; run++) {
          const d = await downloadNote(ctx.app, bulk.token, n0.id);
          let first: string | null = null;
          const body = editBody(d.text, b => {
            const lines = b.split("\n");
            const cand = lines.map((l, i) => (/^Paragraph \d+ /.test(l) ? i : -1)).filter(i => i >= 0);
            const want = Math.min(k, cand.length);
            for (let j = 0; j < want; j++) {
              const i = cand[Math.floor((j * cand.length) / want)]!;
              first ??= lines[i]!;
              lines[i] = `${lines[i]} r${run}`;
            }
            return lines.join("\n");
          });
          if (conflict && first) {
            const key = (first as string).split(" with ")[0]!;
            await humanEdit(ctx, n0.id, ed => {
              const b = ed.document.find(x => JSON.stringify(x.content).includes(`${key} with`));
              if (b) ed.updateBlock(b.id, { content: `${key} with human edit ${run}` });
            });
          }
          cur = new Map();
          const r = await bulkPut(ctx.app, bulk.token, body);
          if (r.statusCode !== 200) throw new Error(`PUT ${r.statusCode} ${r.body}`);
          for (const [name, ms] of cur) rec.set(name, [...(rec.get(name) ?? []), ms]);
        }
        client.disconnect();
        out(`## ${n} 顆、${k} 區、熱、${conflict ? "有" : "無"}衝突（每次寫回內各函式的單次最大值；跨 ${RUNS} 次取 p95／max，ms）`);
        for (const [name, a] of [...rec].sort((x, y) => Math.max(...y[1]) - Math.max(...x[1]))) out(`- ${name}：p95 ${pct(a, 95).toFixed(0)} / max ${Math.max(...a).toFixed(0)}`);
      }
    }
  }
  await ctx.destroy();
}, 3_600_000);
