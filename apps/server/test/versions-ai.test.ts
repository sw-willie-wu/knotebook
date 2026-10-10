// 版本歷史 × AI／MCP 寫入（spec 2026-10-09 §5.4、§11.2 三切點 (c)、D9 的 create_note、§7-3 落款閘門）。
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { notes, users } from "../src/db/schema.js";
import { withDirectConnection, type DirectCtx } from "../src/notes/editing/session.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { buildCollabTestApp } from "./helpers.js";
import { seedOldNote, versionsOf } from "./version-helpers.js";

const PASSWORD = "correct-horse-battery";
const LABEL_TOKEN = "Claude Code (knotebook)";

async function setup() {
  const ctx = await buildCollabTestApp();
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", LABEL_TOKEN);
  const content = async () => (await getContent(ctx.app, note.id, token)).json();
  const edit = (body: Record<string, unknown>) => ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: body });
  const unloaded = () => waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
  return { ctx, u, note, session, token, content, edit, unloaded };
}

describe("三切點 (c)：AI 寫入前後", () => {
  it("寫前有人工未存修改（WS 連著、沒等 idle）→ 增 2 版：先人後 AI", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "人打的未存內容");
    const res = await s.edit({ op: "append", markdown: "AI 加的一段" });
    expect(res.statusCode).toBe(201);
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows.map(r => [r.seq, r.kind])).toEqual([[1, "auto"], [2, "auto"]]);
    expect(rows[0]!.editors).toEqual([{ user_id: s.u.id, agent_label: null }]);
    expect(rows[1]!.editors).toContainEqual({ user_id: s.u.id, agent_label: expect.any(String) });
    expect(rows[1]!.editors.some(e => e.agent_label !== null)).toBe(true);
    const v1 = new Y.Doc();
    Y.applyUpdate(v1, rows[0]!.ydoc);
    expect(v1.getXmlFragment(YDOC_FRAGMENT).toString()).not.toContain("AI 加的一段"); // 寫前那一刀不含 AI 內容
    client.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(2); // unload 不多切
  });

  it("寫前乾淨（已切過版）→ 增 1 版（editors 含 agentLabel）", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "先存起來的內容");
    const live = s.ctx.collab.hocuspocus.documents.get(s.note.id)!;
    await s.ctx.collab.versions.cutIfDirty(s.note.id, live, { kind: "manual" });
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(1);
    expect((await s.edit({ op: "append", markdown: "AI 第二段" })).statusCode).toBe(201);
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows).toHaveLength(2); // 增 1
    expect(rows[1]!.editors.some(e => e.agent_label !== null)).toBe(true);
    client.disconnect();
  });

  it("沒有基底、直接寫 note_states 的舊筆記被 AI 直連寫入（沒人開著）→ 總數 1，editors 只有 AI", async () => {
    const s = await setup();
    await seedOldNote(s.ctx.db, s.note.id, "功能上線前就有的筆記");
    expect((await s.edit({ op: "append", markdown: "AI 補一段" })).statusCode).toBe(201);
    await s.unloaded();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.editors).toHaveLength(1);
    expect(rows[0]!.editors[0]!.agent_label).not.toBeNull();
  });

  it("被拒的寫入（if_match 不符）不切版", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "人打的未存內容");
    const res = await s.edit({ op: "replace_all", markdown: "x", if_match: "0000000000000000" });
    expect(res.statusCode).toBe(409);
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
    client.disconnect();
  });

  it("自動儲存關閉（個人空間）→ AI 寫入前後都不切", async () => {
    const s = await setup();
    await s.ctx.db.update(users).set({ autoVersions: false }).where(eq(users.id, s.u.id));
    const client = await seedContent(s.ctx, s.session, s.note.id, "人打的未存內容");
    expect((await s.edit({ op: "append", markdown: "AI" })).statusCode).toBe(201);
    client.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });
});

describe("D9：create_note 帶 content", () => {
  it("POST /api/notes 帶 content（token）→ 總數 1、editors 是 AI", async () => {
    const s = await setup();
    const res = await s.ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(s.token), payload: { title: "新", content: "AI 建的筆記內容" } });
    expect(res.statusCode).toBe(201);
    await s.unloaded();
    const rows = await versionsOf(s.ctx.db, res.json().id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.editors[0]!.agent_label).not.toBeNull();
  });
});

describe("§7-3 落款閘門：直連一律看 applied", () => {
  it("version-apply：applied=false 不落款；applied=true 落款寫人、token 與 agent label 為 null", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "落款測試內容");
    const lastAt = async () => (await s.ctx.db.select({ at: notes.lastEditedAt }).from(notes).where(eq(notes.id, s.note.id)))[0]!.at;
    // 先等種子那批人的 debounced store 落款（2 s）——否則它可能在下面兩次讀之間才落地，把「沒落款」測成「有落款」。
    await expect.poll(async () => (await lastAt()) !== null, { timeout: 10_000 }).toBe(true);
    const before = await lastAt();
    const ctx: DirectCtx = { source: "version-apply", userId: s.u.id, tokenId: null, agentLabel: null, applied: false };
    await withDirectConnection(s.ctx.collab.hocuspocus, s.note.id, ctx, () => undefined);
    expect(await lastAt()).toEqual(before);
    const ok: DirectCtx = { ...ctx, applied: true };
    await withDirectConnection(s.ctx.collab.hocuspocus, s.note.id, ok, () => undefined);
    const [row] = await s.ctx.db
      .select({ by: notes.lastEditedBy, tokenId: notes.lastEditedTokenId, label: notes.lastEditedAgentLabel })
      .from(notes)
      .where(eq(notes.id, s.note.id));
    expect(row).toEqual({ by: s.u.id, tokenId: null, label: null });
    client.disconnect();
  });

  it("beforeDisconnect 在 transact 成功之後、disconnect 之前跑，收到 fn 的回傳；fn 丟錯時不跑", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "鉤子順序內容");
    const order: string[] = [];
    const ctx: DirectCtx = { source: "version-apply", userId: s.u.id, tokenId: null, agentLabel: null, applied: false };
    // 鉤內的斷言會被 withDirectConnection 吞掉（只 log），所以只記錄、出來再斷言。
    await withDirectConnection(s.ctx.collab.hocuspocus, s.note.id, ctx, () => 42, {
      beforeDisconnect: async r => {
        order.push(`bd:${r}:loaded=${s.ctx.collab.hocuspocus.documents.has(s.note.id)}`);
      },
    });
    expect(order).toEqual(["bd:42:loaded=true"]);
    await expect(withDirectConnection(s.ctx.collab.hocuspocus, s.note.id, ctx, () => { throw new Error("boom"); }, {
      beforeDisconnect: async () => { order.push("不該跑"); },
    })).rejects.toThrow("boom");
    expect(order).toEqual(["bd:42:loaded=true"]);
    client.disconnect();
  });
});

describe("拆分後的守衛", () => {
  it("applyEdit 的 afterBlockIds／fingerprint 行為不變（寫入後讀到的 fingerprint 等於回覆）", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "# A\n\n第一段");
    const c = await s.content();
    const res = await s.edit({ op: "replace_all", markdown: "# B\n\n新內容", if_match: c.fingerprint });
    expect(res.statusCode).toBe(201);
    await waitFor("provider 收到", 3_000, () => docText(client.doc).includes("新內容"));
    expect((await s.content()).fingerprint).toBe(res.json().fingerprint);
    expect(topLevelContainers(client.doc.getXmlFragment(YDOC_FRAGMENT)).length).toBeGreaterThan(0);
    client.disconnect();
  });
});
