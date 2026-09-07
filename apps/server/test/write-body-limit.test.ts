/**
 * #108 PR2 Task 1：兩個寫入端點的 `bodyLimit` 邊界（規格 D30／plan P9）。
 *
 * 這一族存在的理由是**既有的兩條 413 測試對「上限被放大」零鑑別力**：`note-edits.test.ts`
 * 與 `mcp-endpoint.test.ts` 都送寫死的 300 000 bytes，把上限改成 280 000 兩案照樣綠
 * （2026-09-08 實跑：38 案全綠）。本檔四發**全部從 `WRITE_BODY_LIMIT` 算出來**，所以常數
 * 一動、邊界跟著動；兩個端點各一組，是「合併成一份常數之後兩邊不會再分岔」的守衛。
 *
 * ⚠ **兩件最容易反過來寫的事，都是實跑量過的**：
 * (1) **恰好等於上限不算超過**——fastify 的判準是「>」不是「>=」。
 * (2) **UTF-8 的 bytes 恆 ≥ UTF-16 code unit 數**，而 body 還要扣掉 JSON 外殼，所以「恰好
 *     `WRITE_BODY_LIMIT` bytes 的 body」裡的 `markdown` **必然沒有**超過 `MD` 的
 *     262 144 code unit——第 2 發想拿 400 不能靠 `.max`（實跑得到 **201，而且內容真的寫進
 *     筆記**），要靠 `editBodySchema` 每個分支的 `.strict()`。用 `.strict()` 還有一個好處：
 *     它**不落盤**，不會污染同檔後面的斷言。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { noteAiEdits } from "../src/db/schema.js";
import { WRITE_BODY_LIMIT } from "../src/http/body-limits.js";
import { buildCollabTestApp } from "./helpers.js";
import { bearer, docText, seedContent, seedTokenForUser } from "./editing-helpers.js";
import { rpc, mcpPost } from "./mcp-helpers.js";

const PASSWORD = "correct-horse-battery";
const SEED = "# A\n\n第一段的內容";

/**
 * 把 `filler` 撐到序列化後**恰好** `target` bytes（payload 全 ASCII，1 char ＝ 1 byte）。
 * 測資造錯（送出的其實沒到邊界）會讓整案空轉，所以把大小釘死而不是相信算術。
 */
function padTo(build: (filler: string) => unknown, target: number): string {
  const empty = Buffer.byteLength(JSON.stringify(build("")));
  const payload = JSON.stringify(build("a".repeat(target - empty)));
  expect(Buffer.byteLength(payload)).toBe(target);
  return payload;
}

async function setup() {
  const ctx = await buildCollabTestApp();
  const u = await ctx.createUser({ email: "limit@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("limit@example.com", PASSWORD);
  await seedContent(ctx, session, note.id, SEED);
  const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code (knotebook)");
  const postEdits = (payload: string) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/edits`,
      headers: { ...bearer(token), "content-type": "application/json" },
      payload,
    });
  const rows = () => ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id));
  const live = () => docText(ctx.collab.hocuspocus.documents.get(note.id)!);
  return { ctx, note, token, postEdits, rows, live };
}

/** MCP 側兩發共用的信封：`tools/list` ＋ 一把撐大小的 `pad` 參數。 */
const mcpEnvelope = (pad: string) => rpc("tools/list", { pad });

describe("#108 寫入端點的 bodyLimit 邊界（WRITE_BODY_LIMIT）", () => {
  it("第 1 發 POST /:id/edits：上限 +1 bytes → 413 content_too_large", async () => {
    const s = await setup();
    const res = await s.postEdits(padTo(md => ({ op: "append", markdown: md }), WRITE_BODY_LIMIT + 1));
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("content_too_large");
  });

  it("第 2 發 POST /:id/edits：恰好上限 ＋ 一把未宣告的鍵 → 400 invalid_body（不是 413），且零落盤", async () => {
    const s = await setup();
    const before = s.live();
    // **恰好**上限＝沒有超過，所以走得進 handler；擋下它的是 `.strict()` 不是 `.max`
    // （見檔頭第 (2) 點：這個大小的 `markdown` 必然沒超過 `MD` 的 code unit 上限）。
    const res = await s.postEdits(padTo(md => ({ op: "append", zzz: "x", markdown: md }), WRITE_BODY_LIMIT));
    expect(res.statusCode).not.toBe(413);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
    // 拒絕案：live doc 一個字都沒變、修改紀錄零列（`.strict()` 這條路不落盤）。
    expect(s.live()).toBe(before);
    expect(await s.rows()).toHaveLength(0);
  });

  it("第 3 發 POST /api/mcp：上限 +1 bytes → 413 content_too_large", async () => {
    const s = await setup();
    const res = await mcpPost(s.ctx.app, undefined, { token: s.token, raw: padTo(mcpEnvelope, WRITE_BODY_LIMIT + 1) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("content_too_large");
  });

  it("第 4 發 POST /api/mcp：恰好上限 → 不是 413（帶一坨 padding 照樣 200）", async () => {
    const s = await setup();
    const res = await mcpPost(s.ctx.app, undefined, { token: s.token, raw: padTo(mcpEnvelope, WRITE_BODY_LIMIT) });
    expect(res.statusCode).not.toBe(413);
    expect(res.statusCode).toBe(200);
    expect(res.json().error).toBeUndefined();
  });
});
