/**
 * #398：markdown 解析在 worker 裡跑——HTTP 層的答案，與主執行緒（事件迴圈）有沒有被卡住。
 *
 * 主執行緒卡多久一律用**事件迴圈的停頓**量（每 10 ms 的計時器實際間隔的最大值，與 `monitorEventLoopDelay` 的最大值取大的），
 * 不用 `inject` 的耗時——同程序的 `inject` 在主執行緒卡住時也只是晚一點開始，量不到停頓（審查 I2）。
 *
 * - 太複雜的內容（審查 ffrv3：figcaption 裡 2 000 段的引言，同執行緒約 25 秒）→ 時限到就 400、什麼都沒寫、主執行緒不停。
 * - worker 全忙、排隊超過上限 → 503 `server_busy`＋`Retry-After`。
 * - 批次寫回：整檔 worker 時間總預算（審查 C2）、`<!--`／換行的主執行緒字串處理（審查 I1）。
 * - 會被接受的重內容（審查 C1）：`/edits`、MCP `edit_note`、批次寫回、新增檔，寫進去時主執行緒的停頓。
 */
import { afterAll, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { loadConfig } from "../src/config.js";
import { noteAiEdits, notes } from "../src/db/schema.js";
import { PARSER_BUSY_MESSAGE, PARSER_BUSY_RETRY_AFTER_S, READ_TOO_COMPLEX_MESSAGE, TOO_COMPLEX_MESSAGE } from "../src/http/parse-errors.js";
import { DOC_MERGE_ATTEMPTS } from "../src/notes/editing/apply.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { ParsePool } from "../src/notes/editing/parse-pool.js";
import type { ParseLimits } from "../src/notes/editing/parse-settings.js";
import { createEditingRuntime, type EditingRuntime } from "../src/notes/editing/runtime.js";
import { transferParseMessage } from "../src/routes/transfer.js";
import { buildCollabTestApp, signTestSession, testConfig, testEditingRuntime, type TestClient } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { bulkGet, bulkPut, callTool, downloadNote, editBody, issueBulkDirect, liveMarkdown, seedMd } from "./bulk-transfer-helpers.js";
import { idleStall, loopStall, stallLimit } from "./perf-helpers.js";

const PASSWORD = "correct-horse-battery";
const ps = (n: number) => Array.from({ length: n }, (_, k) => `<p>q${k}</p>`).join("");
const SLOW = "<figcaption><blockquote>" + ps(2000) + "</blockquote></figcaption>";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));


/**
 * 整個檔共用一個 runtime（開一個 parse worker 要載入編輯器，CI 的 2 vCPU 上每次數秒；原本每案各開一份，整檔在 CI 上跑到 12 分鐘、把
 * 30 分鐘的 job 時限吃光），每案開頭用 `ParsePool.configure` 換成自己要的設定（沒指定的回到下面的預設），再等 worker 全數就緒——上一案
 * 逾時換掉的 worker 要重開，不等的話這一案的計時會把重開算進去。各案只看 pool 計數器的差值。
 *
 * 預設兩個 worker：逾時的那個被換掉、重開的期間，同一個請求後續的轉換工作（例如 `/edits` 在回 400 之前的比對）由另一個接手，計時不含
 * 重開（CI 上重開要好幾秒，PR #400 的 CI 就是這樣把「/edits 太複雜」量成 10 秒而紅）。要「唯一的 worker 被佔住」的案子自己設 1。
 */
let shared: EditingRuntime | undefined;
async function runtimeWith(limits: Partial<Pick<ParseLimits, "workers" | "timeoutMs" | "queueWaitMs">> = {}): Promise<EditingRuntime> {
  shared ??= createEditingRuntime(loadConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/db", APP_SECRET: testConfig.appSecret, PUBLIC_URL: "http://localhost:3000", PARSE_WORKERS: "2", PARSE_TIMEOUT_MS: "60000" }));
  const pool = shared.parser as ParsePool;
  pool.configure({ workers: 2, timeoutMs: 60_000, queueWaitMs: 20_000, ...limits });
  await until("parse worker ready", () => pool.stats().ready >= pool.limits.workers);
  return shared;
}
/** 逾時類的案子用的單次時限（毫秒）：太複雜的內容同執行緒要幾十秒，時限只要遠小於它；越小整案越快。 */
const TIMEOUT_MS = 1_000;
async function until(what: string, f: () => boolean, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`等不到：${what}`);
    await sleep(10);
  }
}
afterAll(async () => {
  await shared?.close();
});

async function setup(editing: EditingRuntime) {
  const ctx = await buildCollabTestApp({ editing });
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const client = await seedContent(ctx, session, note.id, "# A\n\n原文");
  const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code (knotebook)");
  const cookie = `${SESSION_COOKIE}=${await signTestSession({ userId: u.id, tv: 0 })}`;
  return { ctx, u, note, client, token, cookie };
}

describe("#398 解析在 worker 裡：HTTP", () => {
  it("/edits 送太複雜的內容 → 時限到 400 unsupported_block（太複雜）；主執行緒停頓 < 200 ms；筆記沒寫、沒紀錄", async () => {
    const rt = await runtimeWith({ timeoutMs: TIMEOUT_MS });
    const { ctx, note, token } = await setup(rt);
    const before = (await getContent(ctx.app, note.id, token)).json();
    const pool = rt.parser as ParsePool;
    const timedOut0 = pool.stats().timedOut;
    const baseline = await idleStall(); // 這台機器當下的雜訊（審查 r7 m6）
    const meter = loopStall();
    const t = performance.now();
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "replace_all", markdown: SLOW, if_match: before.fingerprint } });
    const ms = performance.now() - t;
    const stall = meter.stop();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "unsupported_block", message: TOO_COMPLEX_MESSAGE } });
    expect(pool.stats().timedOut - timedOut0, "是時限到才回的").toBe(1);
    expect(ms).toBeLessThan(TIMEOUT_MS + 5_000); // 時限＋這個請求其餘的工作；同執行緒要解完是幾十秒
    console.log(`[#398] /edits 太複雜 ${Math.round(ms)} ms；主執行緒最大停頓 ${stall} ms`);
    expect(stall).toBeLessThan(stallLimit(baseline, 200));
    expect((await getContent(ctx.app, note.id, token)).json().fingerprint).toBe(before.fingerprint);
    expect(await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id))).toHaveLength(0);
    // 正常寫入照常（worker 已換新）
    expect((await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "append", markdown: "追加" } })).statusCode).toBe(201);
    await ctx.destroy();
  }, 240_000);

  it("worker 全忙、排隊超過上限 → 503 server_busy＋Retry-After；排隊的那筆什麼都沒寫。佔住 worker 的 POST /api/notes 太複雜 → 400，一列都沒建", async () => {
    const rt = await runtimeWith({ workers: 1, timeoutMs: TIMEOUT_MS, queueWaitMs: 300 });
    const { ctx, u, note, token } = await setup(rt);
    // 另一個使用者佔住唯一的 worker（每人至多一個，所以要不同人才排得到「別人」後面）
    const v = await ctx.createUser({ email: "b@example.com", password: PASSWORD });
    const { token: tokenB } = await seedTokenForUser(ctx.db, v.id, "notes:read notes:write");
    const notesOfB = async () => (await ctx.db.select({ id: notes.id }).from(notes).where(eq(notes.ownerId, v.id))).length;
    const nB0 = await notesOfB();
    const before = (await getContent(ctx.app, note.id, token)).json();
    const slow = ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(tokenB), payload: { content: SLOW } });
    await until("慢的那筆進了 worker", () => (rt.parser as ParsePool).stats().busy === 1); // 審查 M3：輪詢，不睡固定時間
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "append", markdown: "排隊的" } });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe(String(PARSER_BUSY_RETRY_AFTER_S));
    expect(res.json()).toEqual({ error: { code: "server_busy", message: PARSER_BUSY_MESSAGE } });
    const slowRes = await slow;
    expect(slowRes.statusCode).toBe(400);
    expect(slowRes.json()).toEqual({ error: { code: "unsupported_block", message: TOO_COMPLEX_MESSAGE } });
    expect(await notesOfB()).toBe(nB0);
    expect((await getContent(ctx.app, note.id, token)).json().fingerprint).toBe(before.fingerprint);
    expect(await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id))).toHaveLength(0);
    expect(u.id).not.toBe(v.id);
    await ctx.destroy();
  }, 240_000);
});

async function transferScene(rt: EditingRuntime, md = "Para 0\n\nPara 1") {
  const ctx = await buildCollabTestApp({ editing: rt });
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
  await seedMd(ctx.db, note.id, md);
  return { ctx, u, pat, bulk, note };
}

describe("#398 解析在 worker 裡：批次寫回（PUT /api/transfer/notes）", () => {
  it("加一行像 fence 的行＋256 KiB 的 `*a `（未閉合 fence 的整檔判斷，同執行緒約 64 秒）→ 時限到就 400 太複雜，主執行緒停頓 < 200 ms", async () => {
    // 這裡只看答案與停頓，時限再減半（整筆約 4 × 時限）：這個請求裡沒有別的正常工作會被這麼短的時限誤殺成另一種答案
    const rt = await runtimeWith({ timeoutMs: TIMEOUT_MS / 2 });
    const s = await transferScene(rt);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const text = editBody(d.text, b => b.replace("Para 1", "*a ".repeat(80_000) + "\n\n```\nx"));
    const baseline = await idleStall(); // 這台機器當下的雜訊（審查 r7 m6）
    const meter = loopStall();
    const t = performance.now();
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    const ms = performance.now() - t;
    const stall = meter.stop();
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toEqual({ code: "unsupported_block", message: transferParseMessage("unsupported_block", "too_complex") });
    console.log(`[#398] 批次寫回 fence 最壞形 ${Math.round(ms)} ms；主執行緒最大停頓 ${stall} ms`);
    expect(stall).toBeLessThan(stallLimit(baseline, 200));
    await s.ctx.destroy();
  }, 240_000);

  it("審查 C2：20 段黏在一個太複雜的區塊下（每段一次邊界解析）→ 整檔 400 太複雜（檔案版的訊息），總時間在 3 × 時限內，不是每段各等一次時限；筆記沒變、沒紀錄", async () => {
    const T = TIMEOUT_MS / 2; // 整筆約 4 × 時限；第一個逾時就整檔失敗，正常工作被誤殺也只是同一個答案、不會多一次逾時
    const rt = await runtimeWith({ timeoutMs: T });
    const paras = Array.from({ length: 20 }, (_, k) => `Para ${k}`);
    const s = await transferScene(rt, paras.join("\n\n"));
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const before = await liveMarkdown(s.ctx, s.note.id);
    const pool = rt.parser as ParsePool;
    const s0 = pool.stats();
    const t = performance.now();
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, () => SLOW + "\n" + paras.join("\n") + "\n"));
    const ms = performance.now() - t;
    const s1 = pool.stats();
    console.log(`[#398] C2 20 段 ${Math.round(ms)} ms；逾時 ${s1.timedOut - s0.timedOut} 次`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("unsupported_block");
    expect(r.json().error.message).toBe(transferParseMessage("unsupported_block", "too_complex"));
    expect(ms).toBeLessThan(3 * T + 4_000);
    expect(s1.timedOut - s0.timedOut).toBeLessThanOrEqual(1);
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(before);
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id))).toHaveLength(0);
    await s.ctx.destroy();
  }, 240_000);

  it("審查 I1：`<!--`×6.5 萬（260 KB）、換行×26 萬接一個字 → 主執行緒停頓 < 200 ms（原本 4 秒、20 秒）", async () => {
    const rt = await runtimeWith();
    const s = await transferScene(rt);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    for (const [name, body] of [["comments", "<!--".repeat(65_000)], ["newlines", "x" + "\n".repeat(250_000) + "y"]] as const) {
      const baseline = await idleStall(); // 這台機器當下的雜訊（審查 r7 m6）
      const meter = loopStall();
      const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, () => body));
      const stall = meter.stop();
      console.log(`[#398] I1 ${name} → ${r.statusCode}；主執行緒最大停頓 ${stall} ms`);
      expect(stall, name).toBeLessThan(stallLimit(baseline, 200));
    }
    await s.ctx.destroy();
  }, 240_000);
});

/**
 * 審查 C1：會被接受的重內容（256 KiB 上限內）寫進去時，主執行緒卡多久。解析與套用的轉換（編輯器的先插後刪、合併後的指紋與大綱）都在
 * worker 裡（`doc-jobs.ts`）；主執行緒剩下的是 Yjs 結構上的線性工作：活文件編碼成狀態、合併前比快照、把 diff 套進活文件、落盤時的編碼與
 * 走訪（版本指紋、搜尋索引）。實測（WSL）：轉換搬出之前 0.6–2.1 s；之後 0.2–0.45 s（最密的兩形；一般段落與清單約 0.1 s）。
 *
 * 主要的斷言是結構的：pool 收到的轉換工作數增加（＝轉換在 worker 裡跑，審查 r8 m3；轉換若回到主執行緒——例如 `DOC_INLINE_MAX_BYTES`
 * 調成無限大——這條就紅）。計時只留一次：`x<br>`（一段裡文字與換行交錯的上萬個子節點；修前的平方——逐一 `get(i)` 走子節點——就出在
 * 這種形）走 `/edits` 寫約 122 KB（上限的一半），寬鬆的上限 max(`HEAVY_STALL_CEILING_MS`, 3 × 閒置時的停頓)，擋平方回來（修前
 * `x<br>`×4.9 萬停 41.6 秒；平方的話一半大小約 10 秒，仍是上限的兩倍）。不寫滿 245 KB：這一筆在 worker 裡的轉換是線性的，本機就要
 * 9 秒、CI 上數十秒。MCP、批次寫回、新增檔走同一條 worker 管線，各用約 40 KB（仍遠大於 `DOC_INLINE_MAX_BYTES`）確認轉換送進了 worker。
 * 原本四形（`x<br>`、粗斜體交錯、兩千段段落、兩千項清單）× 三條路徑、每次還讀回整篇，CI 上光這三案就 9 分鐘。粗斜體交錯（一段 XmlText
 * 裡上萬個格式片段）停頓與 `x<br>` 同級（CI 上 2.5 s 對 2.2 s），改在 MCP 那案用小一號的走一次；段落與清單是很多個小 block，停頓小得多
 * （CI 上 1.0 s、0.25 s），拿掉。
 */
const HEAVY_STALL_CEILING_MS = 5_000;
const DENSEST_BIG = "x<br>".repeat(24_500);
const DENSEST_SMALL = "x<br>".repeat(8_000);
const BOLD_ITALIC_SMALL = "**b** _i_ ".repeat(4_000);

describe("審查 C1：會被接受的重內容寫進去，主執行緒停頓", () => {
  it("/edits replace_all：大的最密形（`x<br>`×2.45 萬，約 122 KB）→ 轉換送進 worker；主執行緒停頓在寬鬆上限內", async () => {
    const rt = await runtimeWith();
    const { ctx, note, token } = await setup(rt);
    const before = (await getContent(ctx.app, note.id, token)).json();
    const baseline = await idleStall(); // 這台機器當下的雜訊（審查 r7 m6）
    const jobs0 = (rt.parser as ParsePool).stats().docJobs;
    const meter = loopStall();
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "replace_all", markdown: DENSEST_BIG, if_match: before.fingerprint } });
    const stall = meter.stop();
    console.log(`[#398] C1 /edits x<br>×24500 → ${res.statusCode}；主執行緒最大停頓 ${stall} ms`);
    expect(res.statusCode).toBe(201);
    expect((rt.parser as ParsePool).stats().docJobs - jobs0, "轉換送進了 worker").toBeGreaterThan(0);
    expect(stall).toBeLessThan(stallLimit(baseline, HEAVY_STALL_CEILING_MS));
    await ctx.destroy();
  }, 300_000);

  it("MCP edit_note replace_all（粗斜體交錯，約 40 KB）→ 轉換送進 worker", async () => {
    const rt = await runtimeWith();
    const { ctx, note, token } = await setup(rt);
    const before = (await getContent(ctx.app, note.id, token)).json();
    const baseline = await idleStall();
    const jobs0 = (rt.parser as ParsePool).stats().docJobs;
    const meter = loopStall();
    const r = await callTool(ctx.app, token, "edit_note", { note_id: note.id, op: "replace_all", markdown: BOLD_ITALIC_SMALL, if_match: before.fingerprint });
    const stall = meter.stop();
    console.log(`[#398] C1 edit_note 粗斜體×4000 → ${r.isError ? "error" : "ok"}；主執行緒最大停頓 ${stall} ms`);
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
    expect((rt.parser as ParsePool).stats().docJobs - jobs0, "轉換送進了 worker").toBeGreaterThan(0);
    expect(stall).toBeLessThan(stallLimit(baseline, HEAVY_STALL_CEILING_MS));
    await ctx.destroy();
  }, 300_000);

  it("批次寫回（改一段）與新增檔（最密形，約 40 KB）→ 兩者的轉換都送進 worker", async () => {
    const rt = await runtimeWith();
    const s = await transferScene(rt);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const baseline = await idleStall();
    const jobs0 = (rt.parser as ParsePool).stats().docJobs;
    const meter = loopStall();
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, () => DENSEST_SMALL));
    const stall = meter.stop();
    console.log(`[#398] C1 寫回 x<br>×8000 → ${r.statusCode}；主執行緒最大停頓 ${stall} ms`);
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
    expect((rt.parser as ParsePool).stats().docJobs - jobs0, "寫回的轉換送進了 worker").toBeGreaterThan(0);
    expect(stall).toBeLessThan(stallLimit(baseline, HEAVY_STALL_CEILING_MS));
    const jobsNew0 = (rt.parser as ParsePool).stats().docJobs;
    const meterNew = loopStall();
    const c = await bulkPut(s.ctx.app, s.bulk.token, `---\nknotebook: 1\ntitle: "densest"\n---\n${DENSEST_SMALL}\n`);
    const stallNew = meterNew.stop();
    console.log(`[#398] C1 新增檔 x<br>×8000 → ${c.statusCode}；主執行緒最大停頓 ${stallNew} ms`);
    expect(c.statusCode, c.body.slice(0, 200)).toBe(201);
    expect((rt.parser as ParsePool).stats().docJobs - jobsNew0, "新增檔的轉換送進了 worker").toBeGreaterThan(0);
    expect(stallNew).toBeLessThan(stallLimit(baseline, HEAVY_STALL_CEILING_MS));
    await s.ctx.destroy();
  }, 300_000);
});

/**
 * 讀出與套用的轉換在 worker 裡（`doc-jobs.ts`）：worker 對「當時的文件狀態」算 diff。合併時活文件若已被別人改過（`live-watch.ts`，審查 r4 I1）：
 * 只改到別段 → 照樣合併（Yjs CRDT 合併，兩邊的字都在、各一次）；改到這次寫入在意的 block → 從頭重來（worker 重比 if_match → 409），
 * 改了又改回（指紋相同）而一直被超前 → 至多 `DOC_MERGE_ATTEMPTS` 次，再不行 503。瀏覽器的修改用真的協作用戶端打。
 */
describe("轉換在 worker 裡：套用期間瀏覽器的修改落進活文件", () => {
  async function raceScene(editing: EditingRuntime, hooks: { beforeMerge?: () => Promise<void>; afterOpenDirect?: () => Promise<void> }) {
    const ctx = await buildCollabTestApp({ editing, editingTestHooks: hooks });
    const u = await ctx.createUser({ email: "r@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("r@example.com", PASSWORD);
    const client = await seedContent(ctx, session, note.id, "# A\n\n第一段原文\n\n# B\n\n第二段原文");
    const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code (knotebook)");
    return { ctx, note, client, token, session };
  }
  type Ctx = Awaited<ReturnType<typeof buildCollabTestApp>>;
  /** 用真的協作用戶端改文件（＝瀏覽器打字），等 server 的活文件出現 `expectText`（或不再有 `goneText`）。 */
  async function browserEdit(ctx: Ctx, client: { doc: Y.Doc }, noteId: string, f: (ed: EditorSession["editor"]) => void, until: (text: string) => boolean) {
    const s = await EditorSession.open(testEditingRuntime, client.doc);
    try {
      f(s.editor);
    } finally {
      s.close();
    }
    await waitFor("server 收到瀏覽器的修改", 5_000, () => until(docText(ctx.collab.hocuspocus.documents.get(noteId)!)));
  }
  const appendText = (ctx: Ctx, client: { doc: Y.Doc }, noteId: string, text: string) =>
    browserEdit(ctx, client, noteId, ed => ed.insertBlocks([{ type: "paragraph", content: text }], ed.document.at(-1)!.id, "after"), t => t.includes(text));
  const count = (s: string, sub: string) => s.split(sub).length - 1;
  const sectionOf = async (s: { ctx: Ctx; note: { id: string }; token: string }, heading: string) =>
    ((await getContent(s.ctx.app, s.note.id, s.token)).json().outline as Array<{ sectionId: string; heading: string; fingerprint: string }>).find(o => o.heading === heading)!;

  it("合併前瀏覽器在別段打了字 → 不重來、直接合併（201）；AI 寫的與瀏覽器打的各出現一次", async () => {
    const rt = await runtimeWith();
    let calls = 0;
    let typed: (() => Promise<void>) | null = null;
    const s = await raceScene(rt, {
      beforeMerge: async () => {
        calls++;
        if (calls === 1) await typed!();
      },
    });
    typed = () => appendText(s.ctx, s.client, s.note.id, "瀏覽器在這時打的字");
    const a = await sectionOf(s, "A");
    // 瀏覽器打在文件尾端（B 段）；AI 換 A 段（if_match＝A 段的指紋）
    const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 換掉第一段", if_match: a.fingerprint } });
    expect(res.statusCode, res.body).toBe(201);
    expect(calls, "別段的修改不算衝突：只跑一次").toBe(1);
    const after = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    expect(count(after.markdown, "瀏覽器在這時打的字")).toBe(1);
    expect(count(after.markdown, "AI 換掉第一段")).toBe(1);
    expect(count(after.markdown, "第一段原文")).toBe(0);
    expect(count(after.markdown, "第二段原文")).toBe(1);
    expect(after.markdown, "合併後的內容與順序").toBe("# A\n\nAI 換掉第一段\n\n# B\n\n第二段原文\n\n瀏覽器在這時打的字\n");
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id))).toHaveLength(1);
    await s.ctx.destroy();
  }, 120_000);

  it("像打字一樣：AI 換 B 段的期間，瀏覽器在 A 段一個字一個字打（每字一筆更新）→ 合併；打的字全在、順序正確、B 段是 AI 的內容（審查 r5 m6）", async () => {
    const rt = await runtimeWith();
    let typed: (() => Promise<void>) | null = null;
    const s = await raceScene(rt, { beforeMerge: async () => await typed!() });
    typed = async () => {
      for (const ch of "打字中") {
        await browserEdit(s.ctx, s.client, s.note.id, ed => {
          const p = ed.document.find(x => x.type === "paragraph")!;
          const text = (p.content as Array<{ text: string }>).map(c => c.text).join("");
          ed.updateBlock(p.id, { content: text + ch });
        }, t => t.includes(ch));
      }
    };
    const b = await sectionOf(s, "B");
    const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "replace_section", section_id: b.sectionId, markdown: "# B\n\nAI 換掉第二段", if_match: b.fingerprint } });
    expect(res.statusCode, res.body).toBe(201);
    const after = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    expect(after.markdown).toBe("# A\n\n第一段原文打字中\n\n# B\n\nAI 換掉第二段\n");
    await s.ctx.destroy();
  }, 120_000);

  it("撤回刪段：worker 做事期間瀏覽器把那段救回來（同 id，像 Ctrl+Z）→ 不合併、不重複；重來時判定不能撤回 → 409 stale（審查 r5 m5）", async () => {
    const rt = await runtimeWith();
    const s = await raceScene(rt, {});
    const b = await sectionOf(s, "B");
    const before = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    const del = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "delete_section", section_id: b.sectionId, if_match: b.fingerprint } });
    expect(del.statusCode, del.body).toBe(201);
    void before;
    // 被刪的那兩顆的 id（從紀錄的 before_blocks 拿）
    const [row] = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.id, del.json().editId));
    const removed = row!.beforeBlocks as Array<{ id: string; type: string; props: unknown; content: unknown; children: unknown }>;
    const orig = rt.runDoc.bind(rt);
    let hit = 0;
    (rt as { runDoc: unknown }).runDoc = async (owner: string, op: { kind: string }, opts?: object) => {
      const r = await orig(owner, op as never, opts);
      if (op.kind === "revert" && hit++ === 0) {
        // 瀏覽器把刪掉的兩顆照原 id 插回文件尾端（Ctrl+Z 的結果）
        await browserEdit(s.ctx, s.client, s.note.id, ed => ed.insertBlocks(removed as never, ed.document.at(-1)!.id, "after"), t => t.includes("第二段原文"));
      }
      return r;
    };
    const r = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${del.json().editId}/revert`, headers: bearer(s.token) });
    (rt as { runDoc: unknown }).runDoc = orig;
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("stale");
    const after = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    expect(count(after.markdown, "第二段原文"), "救回來的那段只有一份").toBe(1);
    expect(count(after.markdown, "# B")).toBe(1);
    await s.ctx.destroy();
  }, 120_000);

  it("不帶 if_match 的 append：合併前瀏覽器在尾端加了段落 → 照樣合併；兩段各一次", async () => {
    const rt = await runtimeWith();
    let calls = 0;
    let typed: (() => Promise<void>) | null = null;
    const s = await raceScene(rt, {
      beforeMerge: async () => {
        calls++;
        await typed!();
      },
    });
    typed = () => appendText(s.ctx, s.client, s.note.id, `瀏覽器第${calls}次`);
    const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "append", markdown: "AI 追加" } });
    expect(res.statusCode, res.body).toBe(201);
    expect(calls).toBe(1);
    const after = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    expect(count(after.markdown, "AI 追加")).toBe(1);
    expect(count(after.markdown, "瀏覽器第1次")).toBe(1);
    await s.ctx.destroy();
  }, 120_000);

  it("瀏覽器改了 if_match 指的那一段 → 重來時指紋不符 → 409，什麼都沒寫（同舊語意）", async () => {
    const rt = await runtimeWith();
    let calls = 0;
    let edit: (() => Promise<void>) | null = null;
    const s = await raceScene(rt, {
      beforeMerge: async () => {
        calls++;
        if (calls === 1) await edit!();
      },
    });
    const b = await sectionOf(s, "B");
    edit = () => browserEdit(s.ctx, s.client, s.note.id, ed => ed.updateBlock(ed.document.at(-1)!.id, { content: "第二段被瀏覽器改了" }), t => t.includes("第二段被瀏覽器改了"));
    const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "replace_section", section_id: b.sectionId, markdown: "# B\n\nAI 換掉第二段", if_match: b.fingerprint } });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("fingerprint_mismatch");
    expect(calls).toBe(1);
    const after = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    expect(after.markdown).toContain("第二段被瀏覽器改了");
    expect(after.markdown).not.toContain("AI 換掉第二段");
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id))).toHaveLength(0);
    await s.ctx.destroy();
  }, 120_000);

  it("目標段每次合併前都被改了又改回（指紋不變、但碰到了）→ 試滿 DOC_MERGE_ATTEMPTS（3）次 → 503 server_busy＋Retry-After；沒有紀錄", async () => {
    expect(DOC_MERGE_ATTEMPTS).toBe(3);
    const rt = await runtimeWith();
    let calls = 0;
    let wiggle: (() => Promise<void>) | null = null;
    const s = await raceScene(rt, {
      beforeMerge: async () => {
        calls++;
        await wiggle!();
      },
    });
    const a = await sectionOf(s, "A");
    wiggle = async () => {
      const firstPara = (ed: EditorSession["editor"]) => ed.document.find(x => x.type === "paragraph")!.id;
      await browserEdit(s.ctx, s.client, s.note.id, ed => ed.updateBlock(firstPara(ed), { content: "第一段原文!" }), t => t.includes("第一段原文!"));
      await browserEdit(s.ctx, s.client, s.note.id, ed => ed.updateBlock(firstPara(ed), { content: "第一段原文" }), t => !t.includes("第一段原文!"));
    };
    const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 想換", if_match: a.fingerprint } });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error.code).toBe("server_busy");
    expect(res.headers["retry-after"]).toBe(String(PARSER_BUSY_RETRY_AFTER_S));
    expect(calls).toBe(3);
    const after = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    expect(after.markdown).not.toContain("AI 想換");
    expect(after.markdown).toContain("第一段原文");
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id))).toHaveLength(0);
    await s.ctx.destroy();
  }, 120_000);

  it("transact 內的那道判斷（審查 r4 M5／突變 H）：開直連之後、transact 之前，瀏覽器改了目標段 → 不合併；重來時指紋不符 → 409", async () => {
    const rt = await runtimeWith();
    let opened = 0;
    let edit: (() => Promise<void>) | null = null;
    const s = await raceScene(rt, {
      afterOpenDirect: async () => {
        opened++;
        if (opened === 1) await edit!();
      },
    });
    const a = await sectionOf(s, "A");
    edit = () => browserEdit(s.ctx, s.client, s.note.id, ed => ed.updateBlock(ed.document.find(x => x.type === "paragraph")!.id, { content: "開直連後瀏覽器改的" }), t => t.includes("開直連後瀏覽器改的"));
    const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 換掉第一段", if_match: a.fingerprint } });
    expect(res.statusCode, res.body).toBe(409);
    const after = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    expect(after.markdown).toContain("開直連後瀏覽器改的");
    expect(after.markdown).not.toContain("AI 換掉第一段");
    await s.ctx.destroy();
  }, 120_000);

  it("取狀態時筆記不在記憶體（冷）：開直連之後瀏覽器連上來改了目標段 → transact 內比快照不等 → 不合併；重來時指紋不符 → 409", async () => {
    const rt = await runtimeWith();
    const hooks: { afterOpenDirect?: () => Promise<void> } = {};
    const ctx = await buildCollabTestApp({ editing: rt, editingTestHooks: hooks });
    const u = await ctx.createUser({ email: "c@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    await seedMd(ctx.db, note.id, "# A\n\n冷的第一段\n\n# B\n\n冷的第二段");
    const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code (knotebook)");
    const session = await ctx.loginAs("c@example.com", PASSWORD);
    const a = ((await getContent(ctx.app, note.id, token)).json().outline as Array<{ sectionId: string; heading: string; fingerprint: string }>).find(o => o.heading === "A")!;
    expect(ctx.collab.hocuspocus.documents.has(note.id), "讀出不會把筆記載進記憶體").toBe(false);
    let opened = 0;
    let client: TestClient | null = null;
    hooks.afterOpenDirect = async () => {
      opened++;
      if (opened > 1) return;
      client = await session.connect(note.id);
      await browserEdit(ctx, client, note.id, ed => ed.updateBlock(ed.document.find(x => x.type === "paragraph")!.id, { content: "冷的時候瀏覽器改的" }), t => t.includes("冷的時候瀏覽器改的"));
    };
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 換掉冷的第一段", if_match: a.fingerprint } });
    expect(res.statusCode, res.body).toBe(409);
    expect(opened).toBe(1);
    const after = (await getContent(ctx.app, note.id, token)).json();
    expect(after.markdown).toContain("冷的時候瀏覽器改的");
    expect(after.markdown).not.toContain("AI 換掉冷的第一段");
    (client as TestClient | null)?.disconnect();
    await ctx.destroy();
  }, 120_000);

  it("撤回：worker 做完、合併之前瀏覽器在別處打字 → 不重來、直接合併；撤回掉的段落不見、瀏覽器的字還在", async () => {
    const rt = await runtimeWith();
    const s = await raceScene(rt, {});
    const w = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "append", markdown: "要被撤回的段落" } });
    expect(w.statusCode, w.body).toBe(201);
    // 撤回沒有 beforeMerge 注入點：包一層 runDoc，在撤回的 worker 工作回來之後、合併之前打字。
    const orig = rt.runDoc.bind(rt);
    let hit = 0;
    (rt as { runDoc: unknown }).runDoc = async (owner: string, op: { kind: string }, opts?: object) => {
      const r = await orig(owner, op as never, opts);
      if (op.kind === "revert" && hit++ === 0) await browserEdit(s.ctx, s.client, s.note.id, ed => ed.updateBlock(ed.document.find(x => x.type === "paragraph")!.id, { content: "撤回期間瀏覽器打的字" }), t => t.includes("撤回期間瀏覽器打的字"));
      return r;
    };
    const r = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${w.json().editId}/revert`, headers: bearer(s.token) });
    (rt as { runDoc: unknown }).runDoc = orig;
    expect(r.statusCode, r.body).toBe(201);
    expect(hit, "改的是別的 block：撤回的轉換只跑一次").toBe(1);
    const after = (await getContent(s.ctx.app, s.note.id, s.token)).json();
    expect(after.markdown).not.toContain("要被撤回的段落");
    expect(count(after.markdown, "撤回期間瀏覽器打的字")).toBe(1);
    await s.ctx.destroy();
  }, 120_000);
});

/** 讀出的轉換在 worker 裡逾時 → 乾淨的錯誤（REST 500 `too_complex`、MCP 工具錯誤 `too_complex`、單篇下載 500），之後照常讀得到。 */
describe("讀出的轉換逾時", () => {
  it("大筆記的讀出超過時限 → /content 500 too_complex、read_note_section too_complex、下載 500；主執行緒不停；放寬時限後照常", async () => {
    const rt = await runtimeWith();
    const s = await transferScene(rt);
    const big = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "Big" });
    // 讀出約 0.8 秒（WSL），遠超過下面的 150 ms 時限（3 × 50 ms）。不再加大：seedMd 在測試的執行緒裡同步建這篇，3 萬個時約 4 秒、慢的
    // CI 上加倍——每段同步工作都要控制在幾秒內，否則會佔住 vitest worker（onTaskUpdate 60 秒逾時）；讀出本身也照規模付三次。
    await seedMd(s.ctx.db, big.id, "x<br>".repeat(8_000));
    s.note = big;
    const pool = rt.parser as ParsePool;
    const timedOut0 = pool.stats().timedOut;
    pool.configure({ timeoutMs: 50 }); // 讀出時限＝3 × 50 ms
    const baseline = await idleStall(); // 這台機器當下的雜訊（審查 r7 m6）
    const meter = loopStall();
    const c = await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}/content`, headers: bearer(s.pat.token) });
    expect(c.statusCode, c.body).toBe(500);
    expect(c.json().error).toEqual({ code: "too_complex", message: READ_TOO_COMPLEX_MESSAGE });
    const t = await callTool(s.ctx.app, s.pat.token, "read_note_section", { note_id: s.note.id, section_id: "_top" });
    expect(t.isError).toBe(true);
    expect(t.structuredContent.code).toBe("too_complex");
    const d = await bulkGet(s.ctx.app, `/api/transfer/notes/${s.note.id}`, s.bulk.token);
    expect(d.statusCode, d.body).toBe(500);
    expect(meter.stop(), "逾時那幾次主執行緒也沒被卡住").toBeLessThan(stallLimit(baseline, 500));
    expect(pool.stats().timedOut - timedOut0).toBeGreaterThanOrEqual(3);
    pool.configure({ timeoutMs: 60_000 });
    const ok = await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}/content`, headers: bearer(s.pat.token) });
    expect(ok.statusCode).toBe(200);
    await s.ctx.destroy();
  }, 300_000);
});
