/**
 * bulk transfer plan PR-2 T14（spec §19.2、§21 D17）：檔案寫回的耗時、事件迴圈停頓、端到端 HTTP、持續負載。**不進 CI**
 * （檔名是 `.bench.ts`，不在任何 vitest 設定的 include 裡）。要真 DB 與 collab server，所以跑在 vitest 裡（`buildCollabTestApp`）：
 *   apps/server 下放一份只 include 本檔的 vitest 設定（不進版控），`TEST_DATABASE_URL=… BENCH_PART=matrix|http|sustained
 *   BENCH_ENV=A|B BENCH_OUT=<輸出檔> [RUNS=30] vitest run --config <那份設定>`。
 *
 * - matrix：擬真混合筆記（同 `transfer-export.bench.ts` 的 `mixed`）20／200／1 000／2 000 顆 × 1／5／20 區 × 冷／熱 × 有無衝突；
 *   每格 RUNS 次。一次＝下載（不計時）→（有衝突時先由「人」改掉第一區的那顆）→ 計時 `PUT /api/transfer/notes`（`app.inject`：
 *   含路由、讀檔、可見性查詢、log，不含網路）。`transferWrite`／`tokenRead`／`contentRead` 換成不限流的實例（量耗時，不是量桶；
 *   不改任何常數）。分段時間用既有的 `editingTestHooks`（`beforeCut`／`beforeMerge`／`beforeRecord`／`afterRecord`）打點，
 *   不改 src。
 * - http：規則格（1 000 顆、5 區、熱、有衝突）走真 HTTP（`node:http`）。
 * - sustained：同一使用者每 2 s 一發、連續 180 s 寫回 1 000 顆、5 區、熱、有衝突的筆記，`transferWrite` 用預設值（30／60 s）；
 *   同時兩個共編 client（A 每 50 ms 送一個更新、B 收），量 A→B 延遲；先量 30 s 不寫回的基線。RSS 每秒取樣。
 * 環境：A＝開發機（不限資源）；B＝2 vCPU／4 GiB 參考環境（app 與 db 兩個容器以 `--cpuset-cpus` 共用同一組 2 顆 CPU、記憶體
 * 3 GiB／1 GiB；只用容器層級參數）。
 * 輸出：人看的表＋每格一行 JSON，寫到 BENCH_OUT（UTF-8）。
 */
import { writeFileSync, appendFileSync } from "node:fs";
import { monitorEventLoopDelay, performance as perf } from "node:perf_hooks";
import { it } from "vitest";
import { FixedWindowLimiter, TRANSFER_WRITE_LIMIT } from "../../src/http/rate-limit.js";
import { buildCollabTestApp, testEditingRuntime, type CollabTestCtx, type TestClient } from "../helpers.js";
import { seedTokenForUser, waitFor } from "../editing-helpers.js";
import { bulkPut, downloadNote, editBody, humanEdit, issueBulkDirect, putRaw, seedBlocks } from "../bulk-transfer-helpers.js";

const PART = process.env.BENCH_PART ?? "matrix";
const ENV = process.env.BENCH_ENV ?? "A";
const RUNS = Number(process.env.RUNS ?? 30);
const OUT = process.env.BENCH_OUT ?? "transfer-write-bench.txt";
const SIZES = (process.env.SIZES ?? "20,200,1000,2000").split(",").map(Number);
const REGIONS = (process.env.REGIONS ?? "1,5,20").split(",").map(Number);

type Block = Record<string, unknown>;
const P_ = (t: string): Block => ({ type: "paragraph", content: t });
const B = (t: string): Block => ({ type: "bulletListItem", content: t });
const N = (t: string): Block => ({ type: "numberedListItem", content: t });
const H = (t: string): Block => ({ type: "heading", content: t, props: { level: 2 } });
const CODE = (t: string): Block => ({ type: "codeBlock", props: { language: "js" }, content: t });
const TBL = (rows: unknown[]): Block => ({ type: "table", content: { type: "tableContent", rows } });
/** 同 `transfer-export.bench.ts`（spike S5）的擬真混合。 */
function mixed(n: number): Block[] {
  return Array.from({ length: n }, (_, i) => {
    if (i % 10 === 0) return H(`Section ${i / 10}`);
    if (i % 37 === 5) return CODE(`const x${i} = ${i};\nconsole.log(x${i});`);
    if (i % 53 === 7) return TBL([{ cells: ["k", "v"] }, { cells: [`r${i}`, "value"] }]);
    switch (i % 4) {
      case 0:
        return P_(`Paragraph ${i} with some words to make it realistic, 中文也有一些字。`);
      case 1:
        return B(`bullet item ${i} text`);
      case 2:
        return N(`numbered item ${i}`);
      default:
        return P_(`Another paragraph ${i}: lorem ipsum dolor sit amet.`);
    }
  });
}

const pct = (a: number[], p: number) => {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "-");
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const stat = (a: number[]) => ({ p50: pct(a, 50), p95: pct(a, 95), max: a.length ? Math.max(...a) : NaN });
const fmt = (a: number[]) => `p50 ${f0(pct(a, 50))} / p95 ${f0(pct(a, 95))} / max ${f0(a.length ? Math.max(...a) : NaN)}`;

function out(s: string) {
  appendFileSync(OUT, `${s}\n`, "utf8");
  process.stdout.write(`${s}\n`);
}

/** 打點：hooks 推 `{name, t}`；每次寫回前清空。 */
const marks: Array<{ name: string; t: number }> = [];
const mark = (name: string) => async () => void marks.push({ name, t: perf.now() });
const unbounded = () => new FixedWindowLimiter({ limit: () => Number.MAX_SAFE_INTEGER, windowMs: 60_000 });

/** 1 ms timer 的最大間隔（同 PR-1 bench）＋停頓結束的時刻（歸到哪一段）＋ELD p99＋ELU。 */
async function measured<T>(fn: () => Promise<T>) {
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  let maxGap = 0;
  let maxGapEnd = 0;
  let last = perf.now();
  let running = true;
  const tick = () => {
    const n = perf.now();
    if (n - last > maxGap) {
      maxGap = n - last;
      maxGapEnd = n;
    }
    last = n;
    if (running) setTimeout(tick, 1);
  };
  setTimeout(tick, 1);
  const elu0 = perf.eventLoopUtilization();
  const t0 = perf.now();
  const r = await fn();
  const t1 = perf.now();
  const elu = perf.eventLoopUtilization(elu0).utilization;
  running = false;
  await new Promise(r2 => setTimeout(r2, 3));
  h.disable();
  return { r, t0, t1, ms: t1 - t0, maxGap, maxGapEnd, p99: h.percentile(99) / 1e6, elu };
}

/** 停頓結束時刻落在哪一段（請求開始 → beforeCut → beforeMerge → beforeRecord → afterRecord → 回應）。 */
function phaseOf(t: number, t0: number, t1: number): string {
  const pts = [{ name: "start", t: t0 }, ...marks, { name: "end", t: t1 }];
  for (let i = 0; i < pts.length - 1; i++) if (t >= pts[i]!.t && t <= pts[i + 1]!.t) return `${pts[i]!.name}→${pts[i + 1]!.name}`;
  return "outside";
}
const PHASE_LABEL: Record<string, string> = {
  "start→beforeCut": "查基底＋規劃（含 scratch mount）",
  "beforeCut→beforeMerge": "存版＋mount fork＋套用",
  "start→beforeMerge": "查基底＋規劃＋mount fork＋套用",
  "beforeMerge→beforeRecord": "合併（mergeDiff）",
  "beforeRecord→afterRecord": "紀錄交易",
  "afterRecord→end": "連結＋presence＋回應",
  "start→end": "整段（沒有打點：零區或錯誤）",
};

interface Scene {
  ctx: CollabTestCtx;
  token: string;
  userId: string;
  email: string;
}
async function makeScene(opts: Parameters<typeof buildCollabTestApp>[0]): Promise<Scene> {
  const ctx = await buildCollabTestApp({
    ...opts,
    editingTestHooks: { beforeCut: mark("beforeCut"), beforeMerge: mark("beforeMerge"), beforeRecord: mark("beforeRecord"), afterRecord: mark("afterRecord") },
  });
  const email = `bench-${Math.random().toString(36).slice(2)}@example.com`;
  const u = await ctx.createUser({ email, password: "correct-horse-battery" });
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  return { ctx, token: bulk.token, userId: u.id, email };
}
async function makeNote(s: Scene, n: number): Promise<string> {
  const note = await s.ctx.createNote(s.userId, `Bench ${n}`);
  await seedBlocks(s.ctx.db, note.id, mixed(n));
  return note.id;
}
const settled = (ctx: CollabTestCtx) => waitFor("卸載", 30_000, () => ctx.collab.hocuspocus.documents.size === 0);

/** k 區的 agent 檔：改 k 顆 `Paragraph i …` 段（彼此至少隔 3 顆，各成一區）；回實際區數與第一區那顆的文字。 */
function agentEdit(text: string, k: number, run: number): { body: string; regions: number; first: string | null } {
  let regions = 0;
  let first: string | null = null;
  const body = editBody(text, b => {
    const lines = b.split("\n");
    const cand = lines.map((l, i) => (/^Paragraph \d+ /.test(l) ? i : -1)).filter(i => i >= 0);
    const pick = new Set<number>();
    const want = Math.min(k, cand.length);
    for (let j = 0; j < want; j++) pick.add(cand[Math.floor((j * cand.length) / want)]!);
    regions = pick.size;
    for (const i of [...pick].sort((x, y) => x - y)) {
      first ??= lines[i]!;
      lines[i] = `${lines[i]} r${run}`;
    }
    return lines.join("\n");
  });
  return { body, regions, first };
}
/** 「人」改掉第一區那顆（觸發衝突與存版）。 */
async function humanTouch(ctx: CollabTestCtx, noteId: string, firstLine: string, run: number) {
  const key = firstLine.split(" with ")[0]!;
  await humanEdit(ctx, noteId, ed => {
    const b = ed.document.find(x => JSON.stringify(x.content).includes(`${key} with`));
    // 保留「Paragraph i with」的形，下一輪的 agentEdit／humanTouch 還找得到這顆
    if (b) ed.updateBlock(b.id, { content: `${key} with human edit ${run}` });
  });
}

async function matrix() {
  const s = await makeScene({ limiters: { transferWrite: unbounded(), tokenRead: unbounded(), contentRead: unbounded() } });
  out(`# T14 matrix  env=${ENV}  node=${process.version}  RUNS=${RUNS}  ${ENV === "B" ? "（2 vCPU／4 GiB 參考環境：容器層級限制）" : ""}`);
  out("| 顆 | 區（實際） | 冷熱 | 衝突 | 耗時 p50/p95/max ms | 最長停頓 p50/p95/max ms | ELD p99 max ms | ELU 平均 | 停頓最大的那段 | 結果 |");
  out("|---|---|---|---|---|---|---|---|---|---|");
  for (const n of SIZES) {
    for (const k of REGIONS) {
      for (const temp of ["hot", "cold"] as const) {
        for (const conflict of [false, true]) {
          const noteId = await makeNote(s, n);
          let client: TestClient | null = null;
          if (temp === "hot") {
            const session = await s.ctx.loginAs(s.email, "correct-horse-battery");
            client = await session.connect(noteId);
          }
          const tot: number[] = [];
          const gaps: number[] = [];
          const p99s: number[] = [];
          const elus: number[] = [];
          const results = new Map<string, number>();
          let worst = { gap: 0, phase: "" };
          let regions = 0;
          for (let run = 0; run < RUNS; run++) {
            const d = await downloadNote(s.ctx.app, s.token, noteId);
            const a = agentEdit(d.text, k, run);
            regions = a.regions;
            if (conflict && a.first) await humanTouch(s.ctx, noteId, a.first, run);
            if (temp === "cold") await settled(s.ctx);
            marks.length = 0;
            const m = await measured(() => bulkPut(s.ctx.app, s.token, a.body));
            const res = m.r.statusCode === 200 ? (m.r.json() as { result: string }).result : String(m.r.statusCode);
            results.set(res, (results.get(res) ?? 0) + 1);
            tot.push(m.ms);
            gaps.push(m.maxGap);
            p99s.push(m.p99);
            elus.push(m.elu);
            if (m.maxGap > worst.gap) worst = { gap: m.maxGap, phase: phaseOf(m.maxGapEnd, m.t0, m.t1) };
          }
          client?.disconnect();
          const elu = elus.reduce((x, y) => x + y, 0) / elus.length;
          out(
            `| ${n} | ${k}（${regions}） | ${temp === "hot" ? "熱" : "冷"} | ${conflict ? "有" : "無"} | ${fmt(tot)} | ${fmt(gaps)} | ${f0(Math.max(...p99s))} | ${f1(elu * 100)}% | ${PHASE_LABEL[worst.phase] ?? worst.phase}（${f0(worst.gap)}） | ${[...results].map(([r, c]) => `${r}×${c}`).join(" ")} |`,
          );
          appendFileSync(`${OUT}.jsonl`, `${JSON.stringify({ env: ENV, n, k, regions, temp, conflict, tot: stat(tot), gap: stat(gaps), p99max: Math.max(...p99s), elu, worst, results: Object.fromEntries(results) })}\n`, "utf8");
        }
      }
    }
  }
  out(`jsdom 重建次數＝${testEditingRuntime.rebuilds}、mounts＝${testEditingRuntime.mounts}、RSS ${f0(process.memoryUsage().rss / 1048576)} MiB`);
  await s.ctx.destroy();
}

async function httpPart() {
  const s = await makeScene({ limiters: { transferWrite: unbounded(), tokenRead: unbounded(), contentRead: unbounded() } });
  const noteId = await makeNote(s, 1000);
  const session = await s.ctx.loginAs(s.email, "correct-horse-battery");
  const client = await session.connect(noteId);
  const tot: number[] = [];
  const statuses = new Map<number, number>();
  for (let run = 0; run < RUNS; run++) {
    const d = await downloadNote(s.ctx.app, s.token, noteId);
    const a = agentEdit(d.text, 5, run);
    if (a.first) await humanTouch(s.ctx, noteId, a.first, run);
    const t0 = perf.now();
    const r = await putRaw(s.ctx.baseUrl, s.token, a.body);
    tot.push(perf.now() - t0);
    statuses.set(r?.status ?? 0, (statuses.get(r?.status ?? 0) ?? 0) + 1);
  }
  client.disconnect();
  out(`# T14 http  env=${ENV}  RUNS=${RUNS}${ENV === "B" ? "  （2 vCPU／4 GiB 參考環境：容器層級限制）" : ""}`);
  out(`規則格（1 000 顆、5 區、熱、有衝突）真 HTTP PUT：${fmt(tot)} ms；狀態 ${[...statuses].map(([k, v]) => `${k}×${v}`).join(" ")}`);
  appendFileSync(`${OUT}.jsonl`, `${JSON.stringify({ env: ENV, part: "http", tot: stat(tot), statuses: Object.fromEntries(statuses) })}\n`, "utf8");
  await s.ctx.destroy();
}

async function sustained() {
  const s = await makeScene({ limiters: { transferWrite: new FixedWindowLimiter(TRANSFER_WRITE_LIMIT), tokenRead: unbounded(), contentRead: unbounded() } });
  const noteId = await makeNote(s, 1000);
  const sa = await s.ctx.loginAs(s.email, "correct-horse-battery");
  const A = await sa.connect(noteId);
  const B2 = await sa.connect(noteId);
  const bench = (c: TestClient) => c.doc.getMap<number>("bench");
  const lat: number[] = [];
  let phase: "base" | "load" = "base";
  const base: number[] = [];
  bench(B2).observe(e => {
    if (e.transaction.local) return;
    const v = bench(B2).get("t");
    if (typeof v === "number") (phase === "base" ? base : lat).push(perf.now() - v);
  });
  const sendTimer = setInterval(() => A.doc.transact(() => bench(A).set("t", perf.now())), 50);
  const rss: Array<{ t: number; mb: number }> = [];
  const t0 = perf.now();
  const rssTimer = setInterval(() => rss.push({ t: (perf.now() - t0) / 1000, mb: process.memoryUsage().rss / 1048576 }), 1000);
  await new Promise(r => setTimeout(r, 30_000));
  phase = "load";
  const sends: Array<{ at: number; status: number; result: string; ms: number }> = [];
  const loadStart = perf.now();
  for (let i = 0; i < 90; i++) {
    const due = loadStart + i * 2000;
    const wait = due - perf.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const d = await downloadNote(s.ctx.app, s.token, noteId);
    const a = agentEdit(d.text, 5, i);
    if (a.first) await humanTouch(s.ctx, noteId, a.first, i);
    const ts = perf.now();
    const r = await bulkPut(s.ctx.app, s.token, a.body);
    sends.push({ at: (ts - loadStart) / 1000, status: r.statusCode, result: r.statusCode === 200 ? (r.json() as { result: string }).result : String(r.statusCode), ms: perf.now() - ts });
  }
  clearInterval(sendTimer);
  clearInterval(rssTimer);
  await new Promise(r => setTimeout(r, 500));
  A.disconnect();
  B2.disconnect();
  const st = (a: number[]) => `p50 ${f1(pct(a, 50))} / p95 ${f1(pct(a, 95))} / max ${f1(a.length ? Math.max(...a) : NaN)} ms（n=${a.length}）`;
  out(`# T14 sustained  env=${ENV}  （transferWrite＝預設值 ${TRANSFER_WRITE_LIMIT.limit}／${TRANSFER_WRITE_LIMIT.windowMs / 1000} s）${ENV === "B" ? "  （2 vCPU／4 GiB 參考環境：容器層級限制）" : ""}`);
  out(`共編 A→B 延遲 基線（30 s 無寫回）：${st(base)}`);
  out(`共編 A→B 延遲 寫回中（180 s、每 2 s 一發）：${st(lat)}；p95 增量 ${f1(pct(lat, 95) - pct(base, 95))} ms`);
  const by = new Map<string, number>();
  for (const x of sends) by.set(x.result, (by.get(x.result) ?? 0) + 1);
  out(`寫回結果：${[...by].map(([k, v]) => `${k}×${v}`).join(" ")}；寫回耗時（200 的）${fmt(sends.filter(x => x.status === 200).map(x => x.ms))} ms`);
  // 429 判讀：每個 60 s 固定視窗（以第一次 consume 起算，近似以 loadStart 起算）內，第幾發開始 429
  const t429 = sends.filter(x => x.status === 429).map(x => x.at);
  out(`429 發生時刻（s，自寫回開始）：${t429.map(t => t.toFixed(0)).join(", ") || "無"}`);
  const windows = new Map<number, { ok: number; firstRejectAt: number | null }>();
  for (const x of sends) {
    const w = Math.floor(x.at / 60);
    const cur = windows.get(w) ?? { ok: 0, firstRejectAt: null };
    if (x.status === 429) cur.firstRejectAt ??= cur.ok + 1;
    else cur.ok++;
    windows.set(w, cur);
  }
  out(`每個 60 s 視窗（近似）：${[...windows].map(([w, v]) => `#${w} 通過 ${v.ok}${v.firstRejectAt ? `、第 ${v.firstRejectAt} 發起 429` : ""}`).join("；")}`);
  const s5xx = sends.filter(x => x.status >= 500);
  out(`5xx：${s5xx.length ? s5xx.map(x => `${x.status}@${x.at.toFixed(0)}s`).join(", ") : "無"}`);
  const head = rss.filter(r => r.t >= 30 && r.t < 90);
  const tail = rss.filter(r => r.t >= 150 && r.t <= 210);
  const slope = (a: typeof rss) => (a.length < 2 ? NaN : (a[a.length - 1]!.mb - a[0]!.mb) / (a[a.length - 1]!.t - a[0]!.t));
  out(`RSS：起 ${f0(rss[0]?.mb ?? NaN)} MiB、訖 ${f0(rss[rss.length - 1]?.mb ?? NaN)} MiB、峰 ${f0(Math.max(...rss.map(r => r.mb)))} MiB；斜率 頭 1 分 ${f1(slope(head) * 60)} MiB/分、末 1 分 ${f1(slope(tail) * 60)} MiB/分`);
  appendFileSync(`${OUT}.jsonl`, `${JSON.stringify({ env: ENV, part: "sustained", base: stat(base), load: stat(lat), sends, rss })}\n`, "utf8");
  await s.ctx.destroy();
}

it(`T14 bench ${PART}`, async () => {
  writeFileSync(`${OUT}.started`, new Date().toISOString(), "utf8");
  if (PART === "matrix") await matrix();
  else if (PART === "http") await httpPart();
  else await sustained();
}, 6 * 3_600_000);
