import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { signSession } from "../src/auth/session.js";
import { noteAiEdits, notes, users } from "../src/db/schema.js";
import { buildCollabTestApp, buildTestApp, testConfig } from "./helpers.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";

const PASSWORD = "correct-horse-battery";

describe("POST /api/notes 帶 content", () => {
  it("201 一般 NoteDto 且內容在、初始空 paragraph 被換、留一列 replace_all 可撤回、帶 [[…]] → 目標 backlinks 含新筆記", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const target = await ctx.createNote(u.id, "目標");
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const res = await ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(token), payload: { title: "T", content: "# H\n\n看 [[目標]]" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ title: "T", role: "owner" });
    expect(res.json().fingerprint).toBeUndefined();
    const id = res.json().id;
    const c = (await getContent(ctx.app, id, token)).json();
    expect(c.markdown).toContain("看 [[目標]]");
    expect(c.outline).toHaveLength(2); // _top(0) + H：初始空 paragraph 沒留下
    const rows = await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.op).toBe("replace_all");
    // ⚠ `/backlinks` 是 **cookie-only**（`app.authenticate`，不在 #107 D2 的 Bearer 允許清單上）
    // ——用 Bearer 會拿到 401、`body.backlinks` 是 undefined。這裡改用 session cookie。
    const cookie = `${SESSION_COOKIE}=${await signSession(testConfig.appSecret, { userId: u.id, tv: 0 })}`;
    const back = await ctx.app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks`, headers: { cookie } });
    expect(back.json().backlinks.map((b: { id: string }) => b.id)).toContain(id);
  });

  it("#145：帶 content 的建立也從標題派生 slug（`createWithContent` 裡那個建列點）", async () => {
    // 三條建立路徑裡**唯一不在 `routes/notes.ts` 也不在 `mcp/tools/create-note.ts`** 的那一個
    // ——它在 service 裡（`notes/editing/write-service.ts`，解析之後才建列）。漏改它的話這一案
    // 是唯一會紅的。
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/notes",
      headers: bearer(token),
      payload: { title: "Content Path", content: "# H\n\n本文" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().slug).toBe("content-path");
    // 內容真的落盤（派生沒有把管線後半段擠掉——insert 仍排在解析之後、套用之前）。
    expect((await getContent(ctx.app, res.json().id as string, token)).json().markdown).toContain("本文");
  });

  it("壞 content（空／超長／NUL）與含 NUL 的 title → 400 無新列；無 collab 的 app 帶 content → 400 不建列", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const count = async () => (await ctx.db.select().from(notes).where(eq(notes.ownerId, u.id))).length;
    const NUL = String.fromCharCode(0);
    for (const [body, code] of [
      [{ title: "T", content: "   \n" }, "empty_content"],
      [{ title: "T", content: "a".repeat(262_145) }, "invalid_body"],
      [{ title: "T", content: "x" + NUL }, "invalid_body"],
      // Minor-1：含 NUL 的 title。少了 schema 那道 `.refine(noNul)`，這一格是 500 不是 400
      // （pg 對 text 欄位的 0x00 直接拒收，錯誤逃到全域 errorHandler）。
      [{ title: "T" + NUL }, "invalid_body"],
      [{ title: "T" + NUL, content: "x" }, "invalid_body"],
    ] as const) {
      const r = await ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(token), payload: body });
      expect(r.statusCode, code).toBe(400);
      expect(r.json().error.code).toBe(code);
    }
    expect(await count()).toBe(0);
    // ⚠ `buildTestApp()` 與 `buildCollabTestApp()` **各自呼叫 `freshDb()`，是兩個不同的資料庫**。
    // 使用者必須建在 `plain.db` 上，token 才插得進去（原本寫成「在 ctx 建帳、往 plain 插 token」
    // 會直接撞 `api_tokens.user_id` 的外鍵）。`buildTestApp` 沒有 `createUser`，比照 `notes.test.ts`
    // 的既有慣例直接 `db.insert(users)`（`handle` 有 DB default，不必給）。
    // 這一案守的是「缺少協作元件時帶 content → 400 且不建列」，別因為它紅就把它刪掉。
    const plain = await buildTestApp();
    const [u2] = await plain.db.insert(users).values({ email: "b@example.com", displayName: "B" }).returning();
    const { token: t2 } = await seedTokenForUser(plain.db, u2!.id);
    const r2 = await plain.app.inject({ method: "POST", url: "/api/notes", headers: bearer(t2), payload: { title: "T", content: "x" } });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error.code).toBe("invalid_body");
    expect((await plain.db.select().from(notes).where(eq(notes.ownerId, u2!.id))).length).toBe(0);
  });

  it("schema 改嚴格：未知欄位 → 400 invalid_body、不建列（對既有呼叫端的行為變更，已寫進 docs 與 CHANGELOG）", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const r = await ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(token), payload: { title: "T", contents: "打錯的欄位名" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("invalid_body");
    expect((await ctx.db.select().from(notes).where(eq(notes.ownerId, u.id))).length).toBe(0);
  });

  it("pipeline 失敗（beforeRecord throw）→ 500 且列已刪", async () => {
    const ctx = await buildCollabTestApp({ editingTestHooks: { beforeRecord: async () => { throw new Error("boom"); } } });
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const r = await ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(token), payload: { title: "T", content: "x" } });
    expect(r.statusCode).toBe(500);
    expect((await ctx.db.select().from(notes).where(eq(notes.ownerId, u.id))).length).toBe(0);
  });
});
