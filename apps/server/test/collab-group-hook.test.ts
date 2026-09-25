/**
 * #103 §7：`onGroupAccessChanged` 只重驗 (noteIds × userIds) 的交集連線；重驗結果由 `resolveRole` 決定。
 * 本檔直接呼叫 hook（路由的呼叫點在 Task 8／9 的 spy 測試與 Task 12 的端到端踢線測試驗）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { COLLAB_CLOSE_REVOKED } from "@knotebook/shared";
import type { CollabHooks } from "../src/collab/hooks.js";
import { createCollabHooks, REVERIFY_DEADLINE_MS } from "../src/collab/hooks-impl.js";
import { noteShares } from "../src/db/schema.js";
import { buildCollabTestApp } from "./helpers.js";

const PASSWORD = "correct-horse-battery";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(`等待逾時（${timeoutMs}ms）：${label}`);
}

describe("#103 CollabHooks.onGroupAccessChanged", () => {
  it("只重驗 noteIds × userIds 的交集：筆記不對或人不對都不動；點名到的人才被重驗並關閉", async () => {
    let hooks!: CollabHooks;
    const ctx = await buildCollabTestApp({ collabHooks: (server, log) => (hooks = createCollabHooks(server, log)) });
    const owner = await ctx.createUser({ email: "owner-gh1@example.com", password: PASSWORD });
    const a = await ctx.createUser({ email: "a-gh1@example.com", password: PASSWORD });
    const b = await ctx.createUser({ email: "b-gh1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const other = await ctx.createNote(owner.id);
    await ctx.share(note.id, a.id, "editor");
    await ctx.share(note.id, b.id, "editor");
    const aClient = await (await ctx.loginAs("a-gh1@example.com", PASSWORD)).connect(note.id);
    const bClient = await (await ctx.loginAs("b-gh1@example.com", PASSWORD)).connect(note.id);

    // 直接刪 DB 列（不經路由、不觸發任何 hook）：兩人此刻都已沒有角色，只有被點名的人會被重驗。
    await ctx.db.delete(noteShares).where(eq(noteShares.noteId, note.id));
    hooks.onGroupAccessChanged([other.id], [a.id]); // 筆記不對
    hooks.onGroupAccessChanged([note.id], [owner.id]); // 人不對（owner 沒有連線）
    await sleep(REVERIFY_DEADLINE_MS + 1_000);
    expect(aClient.closes).toEqual([]);
    expect(bClient.closes).toEqual([]);

    hooks.onGroupAccessChanged([note.id, note.id], [a.id]);
    await waitFor("a 被 close(knotebook:revoked)", 10_000, () => aClient.closes.some(c => c.reason === COLLAB_CLOSE_REVOKED));
    await sleep(REVERIFY_DEADLINE_MS + 1_000);
    expect(bClient.closes).toEqual([]);
  });

  it("空名單、不存在的 id 不 throw", async () => {
    let hooks!: CollabHooks;
    await buildCollabTestApp({ collabHooks: (server, log) => (hooks = createCollabHooks(server, log)) });
    expect(() => hooks.onGroupAccessChanged([], [])).not.toThrow();
    expect(() => hooks.onGroupAccessChanged([randomUUID()], [randomUUID()])).not.toThrow();
  });
});
