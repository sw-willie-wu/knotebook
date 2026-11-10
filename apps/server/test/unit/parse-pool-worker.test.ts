/**
 * #398：真的 parse worker（vitest 從原始碼跑：`spawnParseWorker` 走 tsx 啟動碼載入 `parse-worker.ts`）。
 * 結果與同執行緒解析一致、逾時被終止、記憶體用完不拖垮主程序、解析期間主執行緒不被卡住、`createEditingRuntime` 一律用 pool。
 * 正式 build（`dist/*.js`，不經 tsx）走 worker：`parse-pool-dist.test.ts`。
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadConfig } from "../../src/config.js";
import { parseMarkdownForNote } from "../../src/notes/editing/markdown.js";
import { TOO_COMPLEX, type ParseRequest } from "../../src/notes/editing/parse-core.js";
import { ParsePool } from "../../src/notes/editing/parse-pool.js";
import { createEditingRuntime, EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { idleStall, loopStall, stallLimit } from "../perf-helpers.js";

const BASE = "http://localhost/";
const ORIGIN = "http://localhost";
const rt = new EditingRuntime({ baseUrl: BASE });
rt.installGlobals();
const stripIds = (x: unknown) => JSON.stringify(x, (k, v) => (k === "id" ? undefined : v));
const req = (markdown: string, owner = "u"): ParseRequest => ({ owner, markdown, candidates: [], siteOrigin: ORIGIN });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function ready(pool: ParsePool, n = pool.limits.workers, ms = 120_000): Promise<void> {
  const until = Date.now() + ms;
  while (pool.stats().ready < n) {
    if (Date.now() > until) throw new Error("worker 沒有在時限內 ready");
    await sleep(20);
  }
}
const pools: ParsePool[] = [];
const mk = (o: Partial<{ workers: number; timeoutMs: number; workerMemoryMb: number }> = {}) => {
  const p = new ParsePool({ baseUrl: BASE, workers: 1, workerMemoryMb: 1024, timeoutMs: 30_000, queueWaitMs: 120_000, ...o });
  pools.push(p);
  return p;
};
afterAll(async () => {
  for (const p of pools) await p.close();
});

/** 實測會出事的形狀：premerge 跳過的子樹裡的引言（同執行緒約 25 秒）、深度×內容（同執行緒把 4 GB 吃光）、幾千層巢狀。 */
const ps = (n: number) => Array.from({ length: n }, (_, k) => `<p>q${k}</p>`).join("");
const SLOW_FIGCAPTION = "<figcaption><blockquote>" + ps(2000) + "</blockquote></figcaption>";
const OOM_QUOTE_BOLD = "> ".repeat(120) + "**x** ".repeat(15000);
const DEEP_QUOTE = "> ".repeat(8000) + "a";

describe("parse worker（真的執行緒）", () => {
  let pool: ParsePool;
  beforeAll(async () => {
    pool = mk({ workers: 1 });
    await ready(pool);
  }, 180_000);

  it("結果與在 mounted 編輯器上解析相同（golden 全部，去 id）", async () => {
    const goldens = JSON.parse(readFileSync(new URL("../../../../packages/shared/test-fixtures/note-markdown-goldens.json", import.meta.url), "utf8")) as { cases: Array<{ id: string; markdown: string }> };
    expect(goldens.cases.length).toBeGreaterThan(10);
    for (const c of goldens.cases) {
      const s = await EditorSession.open(rt, new Y.Doc());
      let expected: unknown;
      try {
        expected = parseMarkdownForNote(s.editor, c.markdown, [], ORIGIN);
      } finally {
        s.close();
      }
      expect(stripIds(await pool.parse(req(c.markdown))), c.id).toBe(stripIds(expected));
    }
  }, 120_000);

  it("錯誤碼與成因照舊從 worker 回來（unsupported_color、nested_paragraph、too_deep）", async () => {
    expect(await pool.parse(req('x <span style="color:#ff6600">o</span>'))).toEqual({ error: "unsupported_color" });
    expect(await pool.parse(req("<p>a<button><p>b</p></button></p>"))).toEqual({ error: "unsupported_block", detail: "nested_paragraph" });
    expect(await pool.parse(req("<blockquote><p>a</p>".repeat(128) + "</blockquote>".repeat(128)))).toEqual({ error: "unsupported_block", detail: "too_deep" });
  }, 60_000);
});

describe("時限、記憶體上限、主執行緒不被卡住", () => {
  it("逾時：figcaption 裡 2 000 段的引言（同執行緒約 25 秒）→ 時限 1.5 秒到就 too_complex、worker 被換掉；換上的照常解析", async () => {
    const pool = mk({ workers: 1, timeoutMs: 1_500 });
    await ready(pool);
    const t = performance.now();
    expect(await pool.parse(req(SLOW_FIGCAPTION))).toEqual(TOO_COMPLEX);
    const ms = performance.now() - t;
    expect(ms).toBeGreaterThanOrEqual(1_400);
    expect(ms).toBeLessThan(5_000);
    expect(pool.stats().timedOut).toBe(1);
    await ready(pool);
    expect(await pool.parse(req("# ok"))).toMatchObject({ unbound: 0 });
  }, 180_000);

  it("解析期間主執行緒照常跑：最大停頓 < max(200 ms, 3 × 閒置時的停頓)（同執行緒時整段停住，秒級）", async () => {
    const pool = mk({ workers: 1, timeoutMs: 3_000 });
    await ready(pool);
    const baseline = await idleStall();
    const meter = loopStall();
    let stall = 0;
    try {
      expect(await pool.parse(req(SLOW_FIGCAPTION))).toEqual(TOO_COMPLEX);
    } finally {
      stall = meter.stop();
    }
    console.log(`[perf] parse-pool 主執行緒停頓 ${stall} ms（閒置基準 ${baseline} ms）`);
    expect(stall).toBeLessThan(stallLimit(baseline, 200));
  }, 180_000);

  it("記憶體用完：120 層引言裡 1.5 萬個粗體（90 KB，同執行緒把程序吃到 4 GB 崩潰）→ worker 上限 256 MiB 撞到就 too_complex；主程序活著、補開的照常解析", async () => {
    const pool = mk({ workers: 1, workerMemoryMb: 256, timeoutMs: 60_000 });
    await ready(pool);
    expect(await pool.parse(req(OOM_QUOTE_BOLD))).toEqual(TOO_COMPLEX);
    expect(pool.stats()).toMatchObject({ crashed: 1, timedOut: 0 });
    await ready(pool);
    expect(await pool.parse(req("# ok"))).toMatchObject({ unbound: 0 });
  }, 180_000);

  it("批次寫回的未閉合 fence 判斷也在 worker 裡：一般檔回那一行；`*a ` 重複 256 KiB＋一行 ```（同執行緒約 64 秒）→ 時限到 \"too_complex\"", async () => {
    const pool = mk({ workers: 1, timeoutMs: 2_000 });
    await ready(pool);
    expect(await pool.openFenceLine("u", ["A", "", "```", "", "B"])).toBe(2);
    expect(await pool.openFenceLine("u", ["A", "", "```js", "x", "```"])).toBeNull();
    const heavy = ["*a ".repeat(87_000), "", "```", "x"];
    const t = performance.now();
    expect(await pool.openFenceLine("u", heavy)).toBe("too_complex");
    expect(performance.now() - t).toBeLessThan(6_000);
  }, 180_000);

  it("8 000 層 `>`（16 KB）→ 時限內回 400（too_complex，或 DOM 上算到的 too_deep），不是例外", async () => {
    const pool = mk({ workers: 1, timeoutMs: 2_000 });
    await ready(pool);
    const r = await pool.parse(req(DEEP_QUOTE));
    expect([TOO_COMPLEX, { error: "unsupported_block", detail: "too_deep" }]).toContainEqual(r);
  }, 180_000);
});

describe("createEditingRuntime", () => {
  it("生產與整合測試的 runtime 一律用 worker pool（設定取自 config.parse），close 收掉", async () => {
    const config = loadConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/db", APP_SECRET: "a".repeat(64), PUBLIC_URL: "http://localhost:3000", PARSE_WORKERS: "1", PARSE_TIMEOUT_MS: "7000" });
    const runtime = createEditingRuntime(config);
    try {
      expect(runtime.parser).toBeInstanceOf(ParsePool);
      expect((runtime.parser as ParsePool).limits).toMatchObject({ workers: 1, timeoutMs: 7_000 });
      expect(await runtime.parser.parse(req("hello"))).toMatchObject({ unbound: 0 });
    } finally {
      await runtime.close();
    }
    await expect(runtime.parser.parse(req("x"))).rejects.toThrow("closed");
  }, 180_000);
  it("直接 new 的 runtime（單元測試）＝同執行緒解析", () => {
    expect(new EditingRuntime({ baseUrl: BASE }).parser).not.toBeInstanceOf(ParsePool);
  });
});
