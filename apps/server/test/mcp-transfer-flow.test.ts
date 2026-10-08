/**
 * #200 spec §9.3 M2a（確定性並發）、M4（log 不含明文）、§9.2 T1 後半（工具給的 curl 形真的能用＋寫回 edit_note 讀得回來）、
 * M2 的「not_found 與 read_note_outline 逐位元組相同」（後者要 collab app）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { IssueTransferTokenSeam } from "../src/auth/tx/issue-transfer-token.js";
import { transferTokens } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { TOO_MANY_PENDING_MESSAGE } from "../src/mcp/tools/create-transfer-token.js";
import { buildCollabTestApp, buildTestApp, freshLimiters, testConfig } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { waitForBlockedOrSettled } from "./group-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { MULTIPART, PNG_BYTES, fileBody, issueDirect, ownerWithPat } from "./transfer-helpers.js";

type Payload = { token: string; url: string; curl: string; method: string; noteId: string };
const callTool = (app: Parameters<typeof mcpPost>[0], token: string, name: string, args: Record<string, unknown>) =>
  mcpPost(app, rpc("tools/call", { name, arguments: args }), { token }).then(r => r.json().result as { isError?: true; structuredContent: Record<string, unknown>; content: Array<{ text: string }> });

describe("M2a：同一母憑證並發簽發——① 的 FOR NO KEY UPDATE 序列化計數（spec §4.2、§9.3）", () => {
  it("已有 4 支未消費：第一發停在 afterCount（讀到 4），第二發卡在 ①（blocked）；放行後恰 5 支、第二發 too_many_requests", async () => {
    const seam: IssueTransferTokenSeam = {};
    const { app, db } = await buildTestApp({ mcpTestHooks: { issueTransferToken: seam } });
    const pool = db.$client;
    const o = await ownerWithPat(db);
    // 暖身：先打一發，讓 authenticateAny 的 touchLastUsed（對 api_tokens 的 UPDATE，60 秒節流）在交錯開始前就做完——
    // 否則它會撞在第一發的列鎖上，被 waitForBlockedOrSettled 當成「第二發 blocked」的假證據。
    expect((await mcpPost(app, rpc("tools/list"), { token: o.pat })).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) await issueDirect(db, o.patId, o.noteId, "upload");

    let calls = 0;
    let second: Promise<Awaited<ReturnType<typeof callTool>>> | undefined;
    let state: "blocked" | "settled" | undefined;
    seam.afterCount = async () => {
      if (calls++ !== 0) return; // 只有第一發在這裡停
      second = callTool(app, o.pat, "create_transfer_token", { note_id: o.noteId, purpose: "upload" });
      state = await waitForBlockedOrSettled(pool, second);
    };
    const first = await callTool(app, o.pat, "create_transfer_token", { note_id: o.noteId, purpose: "upload" });
    const secondResult = await second!;
    expect(state).toBe("blocked");
    expect(first.isError).toBeUndefined();
    expect(secondResult.structuredContent.code).toBe("too_many_requests");
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(transferTokens)
      .where(sql`${transferTokens.parentTokenId} = ${o.patId} and ${transferTokens.purpose} = 'upload' and ${transferTokens.consumedAt} is null`);
    expect(n).toBe(5);
  });

  it("煙霧：Promise.all 同時簽 10 支 upload × 20 輪（每輪新母憑證）→ 每輪恰 5 支成功、5 支被拒且都是未消費上限；另一支母憑證不受影響", async () => {
    // 同一位使用者 20 輪 × 10 發＝200 次 upload 簽發，全都扣 tokenWrite（key token:<userId>，60／10 分）——不放大就從第 6 輪起
    // 全是速率拒絕，假冒成上限拒絕。注入大桶只為隔離「未消費上限」這一件事；下面再逐發斷言拒絕的是 TOO_MANY_PENDING_MESSAGE。
    const tokenWrite = new FixedWindowLimiter({ limit: 10_000, windowMs: 600_000 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ tokenWrite }) });
    const o = await ownerWithPat(db);
    for (let round = 0; round < 20; round++) {
      const { token } = await seedTokenForUser(db, o.userId);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => callTool(app, token, "create_transfer_token", { note_id: o.noteId, purpose: "upload" })),
      );
      expect(results.filter(r => r.isError === undefined), `round ${round}`).toHaveLength(5);
      const refused = results.filter(r => r.isError === true);
      expect(refused, `round ${round}`).toHaveLength(5);
      for (const r of refused) expect(r.structuredContent, `round ${round}`).toEqual({ code: "too_many_requests", message: TOO_MANY_PENDING_MESSAGE });
    }
    expect((await callTool(app, o.pat, "create_transfer_token", { note_id: o.noteId, purpose: "upload" })).isError).toBeUndefined();
  }, 120_000);
});

describe("M4：transfer token 明文從頭到尾不進 log（spec §6.4 末段）", () => {
  it("簽發 → 上傳 201 → 重用 401 → 下載 → 錯用途 403 → 一次 runTool 例外：整份 log 不含明文、不含 knbt_", async () => {
    const chunks: string[] = [];
    let explode = false;
    // level 用 debug（比生產的 info 多開一級，涵蓋本專案所有 log 呼叫）。⚠ 不是 trace：@fastify/multipart 在 trace 級
    // 會印 `{ busboyOptions: { headers } }`（含 Authorization 原文，cookie 上傳時同理含 session cookie）——第三方程式庫
    // 的既有行為、生產的 logger（`buildApp` 預設 `true`＝info，無 LOG_LEVEL 設定）印不出來；實測紀錄見 Task 7 回報。
    const { app, db } = await buildTestApp(
      { mcpTestHooks: { beforeTool: name => { if (explode && name === "create_transfer_token") throw new Error("boom"); } } },
      { logger: { level: "debug", stream: { write: (s: string) => void chunks.push(s) } } },
    );
    const o = await ownerWithPat(db);
    const up = (await callTool(app, o.pat, "create_transfer_token", { note_id: o.noteId, purpose: "upload" })).structuredContent as Payload;
    const post = () =>
      app.inject({ method: "POST", url: new URL(up.url).pathname, headers: { "content-type": MULTIPART, authorization: `Bearer ${up.token}` }, payload: fileBody(PNG_BYTES) });
    const created = await post();
    expect(created.statusCode).toBe(201);
    expect((await post()).statusCode).toBe(401);
    const down = (await callTool(app, o.pat, "create_transfer_token", { note_id: o.noteId, purpose: "download" })).structuredContent as Payload;
    const uploadId = (created.json() as { id: string }).id;
    expect((await app.inject({ method: "GET", url: `/api/uploads/${uploadId}`, headers: { authorization: `Bearer ${down.token}` } })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: new URL(up.url).pathname, headers: { "content-type": MULTIPART, authorization: `Bearer ${down.token}` }, payload: fileBody(PNG_BYTES) })).statusCode,
    ).toBe(403);
    explode = true;
    expect((await callTool(app, o.pat, "create_transfer_token", { note_id: o.noteId, purpose: "download" })).structuredContent.code).toBe("internal");
    const all = chunks.join("");
    expect(all.length).toBeGreaterThan(0);
    // 例外那一發在 handler 之前（beforeTool）就丟，這時**還沒有任何新的 transfer token 存在**——這條證明的是「錯誤那一行
    // 確實進了這份 log（攔截器沒漏接錯誤路徑）」，不是「錯誤行裡的明文被遮掉」；明文不出現由下面三條 not.toContain 守。
    expect(all).toContain("MCP 工具丟出未預期的例外");
    expect(all).not.toContain(up.token);
    expect(all).not.toContain(down.token);
    expect(all).not.toContain("knbt_");
  });
});

describe("T1 端到端（collab app）：工具給的 curl 形真的能用，回應的 url 寫進 edit_note 後讀得回來", () => {
  it("create_transfer_token(upload) → 照 curl 的 method／header／網址重現 multipart POST → 201 → edit_note append → read_note_section 含 /api/uploads/<id>", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `t1-${randomUUID()}@example.com`, password: "correct-horse-battery" });
    const note = await ctx.createNote(owner.id, "Images");
    const { token: pat } = await seedTokenForUser(ctx.db, owner.id);
    const p = (await callTool(ctx.app, pat, "create_transfer_token", { note_id: note.id, purpose: "upload" })).structuredContent as Payload;
    // 從 curl 字串反解：method、Authorization header、網址——不是從 payload 的其他欄位抄，證明 curl 本身可用。
    const m = /^curl -sS -X (POST) -H "Authorization: Bearer (knbt_[A-Za-z0-9_-]{43})" -F "file=@<path-to-image>" "([^"]+)"$/.exec(p.curl);
    expect(m).not.toBeNull();
    const [, method, bearerToken, url] = m!;
    // curl 裡的網址就是 payload 的 `url`，且 origin 取自 PUBLIC_URL（collab app 用 `testConfig`）——下面 inject 只取 pathname，
    // 不釘這兩條的話 curl 指向別的主機也照樣綠。
    expect(url).toBe(p.url);
    expect(new URL(url!).origin).toBe(testConfig.publicUrl.origin);
    const res = await ctx.app.inject({
      method: method as "POST",
      url: new URL(url!).pathname,
      headers: { "content-type": MULTIPART, authorization: `Bearer ${bearerToken}` },
      payload: fileBody(PNG_BYTES),
    });
    expect(res.statusCode).toBe(201);
    const { url: rel } = res.json() as { id: string; url: string };
    expect(rel).toMatch(/^\/api\/uploads\/[0-9a-f-]{36}$/);
    const edit = await callTool(ctx.app, pat, "edit_note", { note_id: note.id, op: "append", markdown: `![shot](${rel})` });
    expect(edit.isError).toBeUndefined();
    const read = await callTool(ctx.app, pat, "read_note_section", { note_id: note.id, section_id: "_top" });
    expect(read.isError).toBeUndefined();
    // 輸出形是 `{ section: { id, level, chars, markdown, … }, truncated, … }`（`read-note-section.ts` 的 `toolResult`）。
    expect((read.structuredContent.section as { markdown: string }).markdown).toContain(`![shot](${rel})`);
  });

  it("M2：create_transfer_token 的 not_found 與 read_note_outline 的 not_found 逐位元組相同", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `nf-${randomUUID()}@example.com`, password: "correct-horse-battery" });
    const { token } = await seedTokenForUser(ctx.db, owner.id);
    const missing = randomUUID();
    const a = await callTool(ctx.app, token, "create_transfer_token", { note_id: missing, purpose: "download" });
    const b = await callTool(ctx.app, token, "read_note_outline", { note_id: missing });
    expect(a.content[0]!.text).toBe(b.content[0]!.text);
  });
});
