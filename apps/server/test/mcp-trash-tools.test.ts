/**
 * #181 PR-2d：MCP 垃圾桶工具（spec 2026-10-21 §6.8.1、§9-11、A2-13）。T4 寫 `list_trash`（LT 段）；T5 寫 `delete_note`／
 * `restore_note`（DN、RN、DS、PX、SC 段）。併入資料夾後補 FD 段（資料夾 spec §5.8：移入留在資料夾並寫路徑快照、還原回原資料夾，
 * 資料夾已刪則重建路徑；資料夾 PR-3d 起 restore_note 的 note 帶 folder、list_trash 每項帶 folderPath，delete_note 仍不帶）。
 * 比對對象一律是同一人 cookie 的 REST（`GET /api/trash`、`DELETE /api/notes/:id`、`POST /api/trash/restore`，同一組服務函式）。
 * 造垃圾桶狀態打 `DELETE /api/notes/:id` 或 `markTrashed`；大量資料與病態字串直改 DB。斷言共編閘門（`isDeleting`）的案接真的 hooks。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE, type TokenScope, type TrashListDto } from "@knotebook/shared";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import type { Db } from "../src/db/index.js";
import { groupMembers, groupRoles } from "../src/db/schema.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { folderPathCost } from "../src/mcp/folder-fields.js";
import { BAD_CURSOR_MESSAGE } from "../src/mcp/keyset-cursor.js";
import { MCP_PAGE_MAX, escapedLength } from "../src/mcp/limits.js";
import { DELETE_BUSY_MESSAGE, DELETE_FORBIDDEN_MESSAGE, DELETE_NOT_FOUND_MESSAGE } from "../src/mcp/tools/delete-note.js";
import { RESTORE_BUSY_MESSAGE, RESTORE_NOT_FOUND_MESSAGE } from "../src/mcp/tools/restore-note.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { folderRow, noteFolderCols, seedFolderChain, setNoteFolder } from "./folder-helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedShare, seedUser, waitForLockWaiters, type SeededUser } from "./group-helpers.js";
import { buildCollabTestApp } from "./helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { inject, markTrashed, sixRoleScene, trashCols } from "./trash-helpers.js";

const R: TokenScope = "notes:read";
const RW: TokenScope = "notes:read notes:write";
const RWM: TokenScope = "notes:read notes:write notes:move";
const RWD: TokenScope = "notes:read notes:write notes:delete";
const RWMD: TokenScope = "notes:read notes:write notes:move notes:delete";

type Auth = { token: string } | { cookie: string };
type Result = {
  isError?: true;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown> & { code?: string; message?: string };
};
type TrashItemForModel = {
  id: string;
  title: string;
  titleTruncated?: true;
  deletedAt: string;
  purgeAt: string | null;
  deletedBy: { handle: string; displayName: string; displayNameTruncated?: true } | null;
  group: { id: string; name: string; nameTruncated?: true } | null;
  folderPath: string[];
  folderPathTruncated?: true;
};
type ListTrashOut = { retentionDays: number | null; items: TrashItemForModel[]; truncated: boolean; nextCursor: string | null; pageCutShort?: true };

async function call(app: FastifyInstance, auth: Auth, name: string, args?: unknown): Promise<Result> {
  const params = args === undefined ? { name } : { name, arguments: args };
  const res = await mcpPost(app, rpc("tools/call", params), auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().result as Result;
}
/** `list_trash` 必須成功（唯讀憑證上沒註冊、或 42P18 收成 internal 時這裡就紅）。 */
async function listTrashOf(app: FastifyInstance, auth: Auth, cursor?: string): Promise<ListTrashOut> {
  const r = await call(app, auth, "list_trash", cursor === undefined ? {} : { cursor });
  expect(r.isError, JSON.stringify(r.content)).toBeUndefined();
  return r.structuredContent as unknown as ListTrashOut;
}
/** 資料夾 PR-3d：`list_trash` 從頭翻到 `nextCursor` 為 null；每頁 `truncated` ≡ `nextCursor !== null`。 */
async function listTrashAll(app: FastifyInstance, auth: Auth): Promise<ListTrashOut[]> {
  const pages: ListTrashOut[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i += 1) {
    const page = await listTrashOf(app, auth, cursor);
    expect(page.truncated).toBe(page.nextCursor !== null);
    pages.push(page);
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("list_trash 翻了 20 頁還沒到底");
}
/** Q3 之後同一毫秒改依 id 排：把剛移入那篇的 `deleted_at` 設成前一篇＋2 ms，讓「依序移入」的順序不靠微秒（M7）。 */
async function spaceAfter(db: Db, noteId: string, prevId: string): Promise<void> {
  await db.$client.query(
    `update notes set deleted_at = (select deleted_at from notes where id = $2) + interval '2 milliseconds' where id = $1`,
    [noteId, prevId],
  );
}
async function restListOf(app: FastifyInstance, userId: string): Promise<TrashListDto> {
  const res = await inject(app, "GET", "/api/trash", userId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as TrashListDto;
}
const tokenOf = async (ctx: { db: Db }, userId: string, scope: TokenScope): Promise<Auth> => ({ token: (await seedTokenForUser(ctx.db, userId, scope)).token });
const sessionOf = async (userId: string): Promise<Auth> => ({ cookie: (await cookieOf(userId))[SESSION_COOKIE]! });
async function trash(app: FastifyInstance, noteId: string, userId: string): Promise<void> {
  const res = await inject(app, "DELETE", `/api/notes/${noteId}`, userId);
  expect(res.statusCode, res.body).toBe(204);
}

describe("LT1 範圍與順序：與 GET /api/trash 逐字相同", () => {
  it("個人兩篇＋群組（編輯＋刪除角色）一篇；別人的垃圾桶與活筆記不出現 → RW、R、session 的 items[].id 都等於 REST（含順序）", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const groupAdmin = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "LT1", [{ userId: groupAdmin.id, role: "admin" }]);
    const roleId = await seedRole(ctx.db, g.id, "edit-delete", { canRead: true, canEdit: true, canDelete: true });
    await ctx.db.insert(groupMembers).values({ groupId: g.id, userId: me.id, roleId });
    const a = await seedNote(ctx.db, { ownerId: me.id });
    const b = await seedNote(ctx.db, { ownerId: me.id });
    const gn = await seedNote(ctx.db, { groupId: g.id });
    const theirs = await seedNote(ctx.db, { ownerId: other.id });
    await seedNote(ctx.db, { ownerId: me.id }, { title: "live 1" });
    await seedNote(ctx.db, { groupId: g.id }, { title: "live 2" });
    await trash(ctx.app, a.id, me.id);
    await trash(ctx.app, gn.id, groupAdmin.id);
    await spaceAfter(ctx.db, gn.id, a.id);
    await trash(ctx.app, b.id, me.id);
    await spaceAfter(ctx.db, b.id, gn.id);
    await trash(ctx.app, theirs.id, other.id);
    await spaceAfter(ctx.db, theirs.id, b.id);

    const rest = (await restListOf(ctx.app, me.id)).items.map(i => i.id);
    expect(rest).toEqual([b.id, gn.id, a.id]); // 前提：REST 本身是對的
    for (const auth of [await tokenOf(ctx, me.id, RW), await tokenOf(ctx, me.id, R), await sessionOf(me.id)]) {
      expect((await listTrashOf(ctx.app, auth)).items.map(i => i.id)).toEqual(rest);
    }
  });
});

describe("LT2 角色（D-W9）", () => {
  it("群組垃圾桶筆記：admin、editDelete 列得到；deleteOnly、editOnly、member、readOnly、outsider 列不到", async () => {
    const ctx = await buildCollabTestApp();
    const s = await sixRoleScene(ctx.db);
    const n = await seedNote(ctx.db, { groupId: s.groupId });
    await trash(ctx.app, n.id, s.admin.id);

    const roles = ["admin", "editDelete", "deleteOnly", "editOnly", "member", "readOnly", "outsider"] as const;
    const got: Record<string, string[]> = {};
    for (const r of roles) got[r] = (await listTrashOf(ctx.app, await tokenOf(ctx, s[r].id, R))).items.map(i => i.id);
    expect(got).toEqual({ admin: [n.id], editDelete: [n.id], deleteOnly: [], editOnly: [], member: [], readOnly: [], outsider: [] });
  });
});

describe("LT3 每頁 100 與翻頁", () => {
  // 個人與群組各一批、時間交錯（各隔 1 秒），keyset 兩支都要帶到（T4-M1）。
  const seedMany = (db: Db, u: SeededUser, n: number, offset = 0) =>
    db.$client.query(
      `insert into notes (owner_id, title, slug, deleted_at, deleted_by)
       select $1::uuid, 'T' || g, 'lt3-' || $3 || '-' || g, now() - make_interval(secs => 2 * g + $4::int), $1::uuid from generate_series(1, $2::int) g`,
      [u.id, n, u.id.slice(0, 8), offset],
    );
  const seedManyGroup = (db: Db, groupId: string, by: SeededUser, n: number) =>
    db.$client.query(
      `insert into notes (group_id, title, slug, deleted_at, deleted_by)
       select $1::uuid, 'G' || g, 'lt3g-' || $3 || '-' || g, now() - make_interval(secs => 2 * g + 1), $4::uuid from generate_series(1, $2::int) g`,
      [groupId, n, groupId.slice(0, 8), by.id],
    );

  it("101 篇（個人 51＋群組 50 交錯）→ 第一頁 100、truncated、有 nextCursor、無 pageCutShort；續翻 1 篇、truncated false、nextCursor null；兩頁合計＝REST 逐字同序", async () => {
    const ctx = await buildCollabTestApp();
    const big = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "LT3", [{ userId: big.id, role: "admin" }]);
    await seedMany(ctx.db, big, 51);
    await seedManyGroup(ctx.db, g.id, big, 50);

    const pages = await listTrashAll(ctx.app, await tokenOf(ctx, big.id, R));
    expect(pages).toHaveLength(2);
    expect([pages[0]!.items.length, pages[0]!.truncated, pages[0]!.nextCursor !== null, "pageCutShort" in pages[0]!]).toEqual([100, true, true, false]);
    expect([pages[1]!.items.length, pages[1]!.truncated, pages[1]!.nextCursor]).toEqual([1, false, null]);
    const restB = await restListOf(ctx.app, big.id);
    expect(restB.items).toHaveLength(101);
    expect(restB.items.some(i => i.group !== null)).toBe(true); // 前提：fixture 含群組項
    expect(pages.flatMap(p => p.items.map(i => i.id))).toEqual(restB.items.map(i => i.id));
  });

  it("剛好 100 篇 → 100 筆、truncated false、nextCursor null", async () => {
    const ctx = await buildCollabTestApp();
    const exact = await seedUser(ctx.db);
    await seedMany(ctx.db, exact, 100);
    const e = await listTrashOf(ctx.app, await tokenOf(ctx, exact.id, R));
    expect([e.items.length, e.truncated, e.nextCursor]).toEqual([100, false, null]);
  });
});

describe("LT4 欄位", () => {
  it("保留 7 天：retentionDays 7、每項 purgeAt 等於 REST；改成 NULL → MCP 與 REST 的 retentionDays、purgeAt 全是 null", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "LT4", [{ userId: me.id, role: "admin" }]);
    const p = await seedNote(ctx.db, { ownerId: me.id });
    const gn = await seedNote(ctx.db, { groupId: g.id });
    await trash(ctx.app, p.id, me.id);
    await trash(ctx.app, gn.id, me.id);
    const auth = await tokenOf(ctx, me.id, R);

    const seven = await listTrashOf(ctx.app, auth);
    const rest7 = await restListOf(ctx.app, me.id);
    expect(seven.retentionDays).toBe(7);
    expect(seven.items.map(i => [i.id, i.purgeAt])).toEqual(rest7.items.map(i => [i.id, i.purgeAt]));
    expect(seven.items.every(i => i.purgeAt !== null)).toBe(true);

    await ctx.db.$client.query(`update site_settings set trash_retention_days = null`);
    const none = await listTrashOf(ctx.app, auth);
    expect(none.retentionDays).toBeNull();
    expect(none.items.map(i => i.purgeAt)).toEqual([null, null]);
    const restNone = await restListOf(ctx.app, me.id);
    expect(restNone.retentionDays).toBeNull();
    expect(restNone.items.map(i => i.purgeAt)).toEqual([null, null]);
  });

  it("刪除者帳號被刪 → deletedBy null；個人筆記 group null；一般資料沒有任何 *Truncated 鍵", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db, { displayName: "LT4 Me" });
    const x = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "LT4 Group", [{ userId: me.id, role: "admin" }, { userId: x.id, role: "admin" }]);
    const gn = await seedNote(ctx.db, { groupId: g.id }, { title: "LT4 G" });
    const p = await seedNote(ctx.db, { ownerId: me.id }, { title: "LT4 P" });
    const gx = await seedNote(ctx.db, { groupId: g.id }, { title: "LT4 X" });
    await trash(ctx.app, gn.id, me.id);
    await trash(ctx.app, p.id, me.id);
    await trash(ctx.app, gx.id, x.id);
    await ctx.db.$client.query(`delete from users where id = $1`, [x.id]);

    const out = await listTrashOf(ctx.app, await tokenOf(ctx, me.id, R));
    const byId = new Map(out.items.map(i => [i.id, i]));
    expect(byId.get(gx.id)!.deletedBy).toBeNull();
    expect(byId.get(p.id)!.group).toBeNull();
    expect(byId.get(p.id)).toMatchObject({ title: "LT4 P", deletedBy: { handle: me.handle, displayName: "LT4 Me" } });
    expect(byId.get(gn.id)).toMatchObject({ title: "LT4 G", group: { id: g.id, name: "LT4 Group" } });
    for (const item of out.items) {
      expect(Object.keys(item)).toEqual(["id", "title", "deletedAt", "purgeAt", "deletedBy", "group", "folderPath"]);
      if (item.deletedBy !== null) expect(Object.keys(item.deletedBy)).toEqual(["handle", "displayName"]);
      if (item.group !== null) expect(Object.keys(item.group)).toEqual(["id", "name"]);
    }
  });

  it("標題 300 個 \"、刪除者 displayName 300 個 \"、群組名 80 個 U+0001 → 三個 *Truncated: true，逃脫後長度都 ≤ 200", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db, { displayName: '"'.repeat(300) });
    const g = await seedGroup(ctx.db, "LT4 trunc", [{ userId: me.id, role: "admin" }]);
    await ctx.db.$client.query(`update groups set name = $2 where id = $1`, [g.id, String.fromCharCode(1).repeat(80)]);
    const n = await seedNote(ctx.db, { groupId: g.id }, { title: '"'.repeat(300) });
    await trash(ctx.app, n.id, me.id);

    const [item] = (await listTrashOf(ctx.app, await tokenOf(ctx, me.id, R))).items;
    expect([item!.titleTruncated, item!.deletedBy!.displayNameTruncated, item!.group!.nameTruncated]).toEqual([true, true, true]);
    expect(escapedLength(item!.title)).toBeLessThanOrEqual(200);
    expect(escapedLength(item!.deletedBy!.displayName)).toBeLessThanOrEqual(200);
    expect(escapedLength(item!.group!.name)).toBeLessThanOrEqual(200);
    expect(item!.title).toBe('"'.repeat(100)); // 前提：真的被截了（一個 " 逃脫後算 2）
  });
});

describe("LT5 輸入", () => {
  it("{} 成功；{ limit: 5 } → SDK 輸入驗證錯誤（無 structuredContent、訊息含 limit）；不帶 arguments → SDK 的 Required（同 X-241b）", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const auth = await tokenOf(ctx, me.id, R);
    expect((await call(ctx.app, auth, "list_trash", {})).isError).toBeUndefined();
    const extra = await call(ctx.app, auth, "list_trash", { limit: 5 });
    expect(extra.isError).toBe(true);
    expect(extra.structuredContent).toBeUndefined();
    expect(extra.content[0]!.text).toContain("limit");
    const bare = await call(ctx.app, auth, "list_trash");
    expect(bare.isError).toBe(true);
    expect(bare.content[0]!.text).toContain("Required");
  });
});

describe("LT6 鏡像與模型面字串", () => {
  it("content[0].text 逐字是 structuredContent 的 JSON；description／truncated 講翻頁與 folderPath（舊句不在），retentionDays 講明管理員可改設定", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    await trash(ctx.app, n.id, me.id);
    const auth = await tokenOf(ctx, me.id, R);
    const r = await call(ctx.app, auth, "list_trash", {});
    expect(r.content[0]!.text).toBe(JSON.stringify(r.structuredContent));
    expect((r.structuredContent!.items as unknown[]).length).toBe(1);

    const tools = (await mcpPost(ctx.app, rpc("tools/list"), auth)).json().result.tools as Array<{
      name: string;
      description: string;
      outputSchema: { properties: Record<string, { description?: string }> };
    }>;
    const t = tools.find(x => x.name === "list_trash")!;
    // 資料夾 PR-3d 加了 cursor：新句在、PR-2d「沒有分頁」的舊句不在；folderPath 的定義以「還原的去處」為準（各 Rev 的舊錨不得回來）。
    expect(t.description).toContain("pass `nextCursor` back as `cursor`");
    expect(t.description).toContain(`up to ${MCP_PAGE_MAX} per call`);
    expect(t.description).not.toContain("only the newest");
    expect(t.description).not.toContain("there is no paging");
    expect(t.description).toContain("`folderPath` is where the note usually goes back to when restored");
    expect(t.description).not.toContain("`folderPath` names the folders");
    expect(t.description).toContain("While the note's folder still exists, the path follows renames and moves");
    expect(t.description).not.toContain("It follows renames and moves of folders that still exist");
    expect(t.description).not.toContain("keeps the names it had then");
    expect(t.description).toContain("once that folder is deleted, the path no longer follows renames");
    expect(t.outputSchema.properties.truncated!.description).toContain("the same as `nextCursor` not being null");
    expect(t.outputSchema.properties.truncated!.description).not.toContain("older ones were left out");
    expect(t.outputSchema.properties.items!.description).toContain("`deletedBy` is null when the account that moved it there no longer exists");
    // 清理用的是當下的設定：purgeAt／保留天數都不是固定事實。
    expect(t.description).toContain("an admin can change it");
    expect(t.outputSchema.properties.retentionDays!.description).toContain("an admin can change it");
  });
});

describe("LT7 站台設定列不在", () => {
  it("DELETE FROM site_settings 後呼叫 → isError、code internal（runTool 收例外）", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const auth = await tokenOf(ctx, me.id, R);
    await ctx.db.$client.query(`delete from site_settings`);
    const r = await call(ctx.app, auth, "list_trash", {});
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.code).toBe("internal");
  });
});

// ───────────────────────── 資料夾 PR-3d T4：folderPath、cursor ─────────────────────────

describe("LT8 folderPath（還原的去處）", () => {
  it("資料夾還在 → 即時路徑（期間改名、搬動也跟著）；資料夾已刪 → 移入時的快照；根層 → []", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const pool = ctx.db.$client;
    const [a, b] = await seedFolderChain(ctx.db, { personal: me.id }, ["A", "B"]);
    const [c] = await seedFolderChain(ctx.db, { personal: me.id }, ["C"]);
    const [d] = await seedFolderChain(ctx.db, { personal: me.id }, ["D"]);
    const live = await seedNote(ctx.db, { ownerId: me.id }, { title: "LT8 live" });
    const gone = await seedNote(ctx.db, { ownerId: me.id }, { title: "LT8 gone" });
    const root = await seedNote(ctx.db, { ownerId: me.id }, { title: "LT8 root" });
    await setNoteFolder(pool, live.id, b!);
    await setNoteFolder(pool, gone.id, d!);
    for (const n of [live, gone, root]) await trash(ctx.app, n.id, me.id);
    const auth = await tokenOf(ctx, me.id, R);
    const pathOf = async (id: string) => (await listTrashOf(ctx.app, auth)).items.find(i => i.id === id)!.folderPath;

    expect(await pathOf(live.id)).toEqual(["A", "B"]);
    await pool.query(`update folders set name = 'A2' where id = $1`, [a]);
    expect(await pathOf(live.id)).toEqual(["A2", "B"]);
    await pool.query(`update folders set parent_id = $2 where id = $1`, [b, c]);
    expect(await pathOf(live.id)).toEqual(["C", "B"]);

    await pool.query(`delete from folders where id = $1`, [d]); // notes.folder_id → NULL（FK set null），快照留著
    expect((await noteFolderCols(pool, gone.id))!.folder_id).toBeNull();
    expect(await pathOf(gone.id)).toEqual(["D"]);
    expect(await pathOf(root.id)).toEqual([]);
    const item = (await listTrashOf(ctx.app, auth)).items.find(i => i.id === root.id)!;
    expect("folderPathTruncated" in item).toBe(false);
  });

  it("八層各 27 個 \"（直寫 DB）→ 留最後 7 段、folderPathTruncated、成本 ≤ 400；五層 [33,40,40,40,41] 個 \" → 5 段全留、末段截成 40、成本恰 400", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const eight = await seedFolderChain(ctx.db, { personal: me.id }, Array.from({ length: 8 }, () => '"'.repeat(27)));
    const five = await seedFolderChain(ctx.db, { personal: me.id }, [33, 40, 40, 40, 41].map(n => '"'.repeat(n)));
    const n8 = await seedNote(ctx.db, { ownerId: me.id }, { title: "LT8 eight" });
    const n5 = await seedNote(ctx.db, { ownerId: me.id }, { title: "LT8 five" });
    await setNoteFolder(ctx.db.$client, n8.id, eight.at(-1)!);
    await setNoteFolder(ctx.db.$client, n5.id, five.at(-1)!);
    await trash(ctx.app, n8.id, me.id);
    await trash(ctx.app, n5.id, me.id);

    const byId = new Map((await listTrashOf(ctx.app, await tokenOf(ctx, me.id, R))).items.map(i => [i.id, i]));
    const i8 = byId.get(n8.id)!;
    expect(i8.folderPath).toEqual(Array.from({ length: 7 }, () => '"'.repeat(27)));
    expect(i8.folderPathTruncated).toBe(true);
    expect(folderPathCost(i8.folderPath)).toBeLessThanOrEqual(400);
    const i5 = byId.get(n5.id)!;
    expect(i5.folderPath).toEqual([33, 40, 40, 40, 40].map(n => '"'.repeat(n)));
    expect(i5.folderPathTruncated).toBe(true);
    expect(folderPathCost(i5.folderPath)).toBe(400);
  });
});

describe("LT9 壞游標", () => {
  it("{ cursor: \"x\" }、list_notes 發的游標、t| 之後夾 NUL、id 不是 UUID、時間不是日期、超範圍年份 → invalid_body＋BAD_CURSOR_MESSAGE；之後照常列", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "LT9" });
    await seedNote(ctx.db, { ownerId: me.id }, { title: "LT9 live a" });
    await seedNote(ctx.db, { ownerId: me.id }, { title: "LT9 live b" });
    await trash(ctx.app, n.id, me.id);
    const auth = await tokenOf(ctx, me.id, R);
    const notesCursor = ((await call(ctx.app, auth, "list_notes", { limit: 1 })).structuredContent!.nextCursor as string | null)!;
    expect(notesCursor).not.toBeNull(); // 前提：真的拿到一個 list_notes 游標
    const enc = (s: string) => Buffer.from(s, "utf8").toString("base64url");
    const withNul = enc(`t|${new Date().toISOString()}${String.fromCharCode(0)}|${n.id}`);
    // 偽造的兩段（T4 審查 M1）：id 不是 UUID、時間不是日期；以及 JS 收、pg 不收的超範圍年份（N1）——都要是 invalid_body，不是 internal。
    const badId = enc(`t|${new Date().toISOString()}|zzz`);
    const badDate = enc(`t|not-a-date|${n.id}`);
    const farYear = enc(`t|+275760-09-13T00:00:00.000Z|${n.id}`);
    for (const [label, cursor] of [["x", "x"], ["list_notes", notesCursor], ["NUL", withNul], ["id", badId], ["date", badDate], ["year", farYear]] as const) {
      const r = await call(ctx.app, auth, "list_trash", { cursor });
      expect(r.isError, label).toBe(true);
      expect(r.structuredContent, label).toEqual({ code: "invalid_body", message: BAD_CURSOR_MESSAGE });
    }
    expect((await listTrashOf(ctx.app, auth)).items.map(i => i.id)).toEqual([n.id]);
  });
});

describe("LT-K 毫秒邊界", () => {
  it("101 篇：第 100 與第 101 篇同一毫秒、差 1 µs，µs 序與 id 序相反（µs 較大的給 id 較小者）→ 兩頁合計 101、不重，序列與 REST 逐字相同", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const pool = ctx.db.$client;
    await pool.query(
      `insert into notes (owner_id, title, slug, deleted_at, deleted_by)
       select $1::uuid, 'K' || g, 'ltk-' || $2 || '-' || g, now() - make_interval(secs => g), $1::uuid from generate_series(1, 101) g`,
      [me.id, me.id.slice(0, 8)],
    );
    const before = (await restListOf(ctx.app, me.id)).items.map(i => i.id);
    const [small, large] = [before[99]!, before[100]!].sort() as [string, string];
    const { rows } = await pool.query<{ ms: string }>(`select to_char((date_trunc('milliseconds', min(deleted_at)) - interval '1 second') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ms from notes where owner_id = $1`, [me.id]);
    const ms = rows[0]!.ms;
    await pool.query(`update notes set deleted_at = $2::timestamptz + interval '501 microseconds' where id = $1`, [small, ms]);
    await pool.query(`update notes set deleted_at = $2::timestamptz + interval '500 microseconds' where id = $1`, [large, ms]);
    const same = await pool.query<{ n: number }>(`select count(*)::int as n from notes where date_trunc('milliseconds', deleted_at) = $1::timestamptz`, [ms]);
    expect(same.rows[0]!.n).toBe(2); // 前提：這一毫秒恰好兩篇

    const rest = (await restListOf(ctx.app, me.id)).items.map(i => i.id);
    expect(rest.slice(99)).toEqual([large, small]); // Q3：同一毫秒依 id DESC（不是 µs）
    const pages = await listTrashAll(ctx.app, await tokenOf(ctx, me.id, R));
    expect(pages.map(p => p.items.length)).toEqual([100, 1]);
    const ids = pages.flatMap(p => p.items.map(i => i.id));
    expect(new Set(ids).size).toBe(101);
    expect(ids).toEqual(rest);
  });
});

// ───────────────────────── T5：delete_note／restore_note ─────────────────────────

type DeleteOut = { id: string; title: string; titleTruncated?: true; purgeAt: string | null };
type NoteSummary = { id: string; title: string; owner: { kind: string }; url: string; role: string };

const realHooks = { collabHooks: createCollabHooks } as const;
/** 測試自持的 edit 桶：呼叫後 `remaining` 仍是 EDIT_N ＝這次呼叫沒扣它。 */
const EDIT_N = 5;
const editLimiter = () => new FixedWindowLimiter({ limit: EDIT_N, windowMs: 600_000 });
const emptyLimiter = () => new FixedWindowLimiter({ limit: 0, windowMs: 600_000 });
function remaining(l: FixedWindowLimiter, key: string): number {
  let n = 0;
  while (n <= 100 && l.consume(key)) n++;
  return n;
}
const isTrashed = async (db: Db, id: string) => (await trashCols(db.$client, id))!.deleted_at !== null;
const busyErr = () => Object.assign(new Error("serialization"), { code: "40001" });

/** 一定成功的 delete_note／restore_note（失敗時把錯誤印進斷言訊息）。 */
async function deleteOk(app: FastifyInstance, auth: Auth, noteId: string): Promise<DeleteOut> {
  const r = await call(app, auth, "delete_note", { note_id: noteId });
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return r.structuredContent as unknown as DeleteOut;
}
async function restoreOk(app: FastifyInstance, auth: Auth, noteId: string): Promise<NoteSummary> {
  const r = await call(app, auth, "restore_note", { note_id: noteId });
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return (r.structuredContent as { note: NoteSummary }).note;
}
const listNotesIds = async (app: FastifyInstance, auth: Auth) =>
  ((await call(app, auth, "list_notes", {})).structuredContent!.notes as Array<{ id: string; url: string }>);

describe("DN1 owner 移入個人筆記", () => {
  it("RWD 憑證 → { id, title, purgeAt }（purgeAt 等於 REST 清單那一項）；deleted_by＝owner；閘門關著；list_notes 不再列它", async () => {
    const ctx = await buildCollabTestApp(realHooks);
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "DN1 note" });
    const auth = await tokenOf(ctx, me.id, RWD);

    const out = await deleteOk(ctx.app, auth, n.id);
    expect(Object.keys(out)).toEqual(["id", "title", "purgeAt"]);
    expect(out).toMatchObject({ id: n.id, title: "DN1 note" });
    const rest = await restListOf(ctx.app, me.id);
    expect(rest.items.map(i => [i.id, i.purgeAt])).toEqual([[n.id, out.purgeAt]]);
    expect(out.purgeAt).not.toBeNull();
    expect((await trashCols(ctx.db.$client, n.id))!.deleted_by).toBe(me.id);
    expect(ctx.collab.isDeleting(n.id)).toBe(true);
    expect((await listNotesIds(ctx.app, auth)).map(x => x.id)).not.toContain(n.id);
  });
});

describe("DN2 not_found 同形（AG2）", () => {
  it("已在垃圾桶的同一篇、別人的私人筆記、隨機 uuid → structuredContent 逐欄相同", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const theirs = await seedNote(ctx.db, { ownerId: other.id });
    const auth = await tokenOf(ctx, me.id, RWD);
    await deleteOk(ctx.app, auth, n.id);

    const again = await call(ctx.app, auth, "delete_note", { note_id: n.id });
    const foreign = await call(ctx.app, auth, "delete_note", { note_id: theirs.id });
    const random = await call(ctx.app, auth, "delete_note", { note_id: randomUUID() });
    expect(random.isError).toBe(true);
    expect(random.structuredContent).toEqual({ code: "not_found", message: DELETE_NOT_FOUND_MESSAGE });
    expect(again).toEqual(random);
    expect(foreign).toEqual(random);
    expect(await isTrashed(ctx.db, theirs.id)).toBe(false);
  });
});

describe("DN3 分享者", () => {
  it("viewer 與 editor 分享 → forbidden＋DELETE_FORBIDDEN_MESSAGE；deleted_at 仍 NULL", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: owner.id });
    for (const role of ["viewer", "editor"] as const) {
      const u = await seedUser(ctx.db);
      await seedShare(ctx.db, n.id, u.id, role);
      const r = await call(ctx.app, await tokenOf(ctx, u.id, RWD), "delete_note", { note_id: n.id });
      expect({ role, sc: r.structuredContent }).toEqual({ role, sc: { code: "forbidden", message: DELETE_FORBIDDEN_MESSAGE } });
      expect(await trashCols(ctx.db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
    }
  });
});

describe("DN4 六角色（§6.3.1）", () => {
  it("admin、editDelete、deleteOnly 成功；member、editOnly、readOnly forbidden；outsider 與隨機 uuid 逐欄相同；deleteOnly 之後 list_trash 不含、restore_note not_found", async () => {
    const ctx = await buildCollabTestApp();
    const s = await sixRoleScene(ctx.db);
    const roles = ["admin", "editDelete", "deleteOnly", "member", "editOnly", "readOnly", "outsider"] as const;
    const got: Record<string, unknown> = {};
    const notes: Record<string, string> = {};
    for (const r of roles) {
      const n = await seedNote(ctx.db, { groupId: s.groupId });
      notes[r] = n.id;
      const res = await call(ctx.app, await tokenOf(ctx, s[r].id, RWD), "delete_note", { note_id: n.id });
      got[r] = res.isError ? res.structuredContent : "ok";
      expect({ r, trashed: await isTrashed(ctx.db, n.id) }).toEqual({ r, trashed: !res.isError });
    }
    const random = (await call(ctx.app, await tokenOf(ctx, s.outsider.id, RWD), "delete_note", { note_id: randomUUID() })).structuredContent;
    const forbidden = { code: "forbidden", message: DELETE_FORBIDDEN_MESSAGE };
    expect(got).toEqual({ admin: "ok", editDelete: "ok", deleteOnly: "ok", member: forbidden, editOnly: forbidden, readOnly: forbidden, outsider: random });
    expect(random).toEqual({ code: "not_found", message: DELETE_NOT_FOUND_MESSAGE });

    const delOnly = await tokenOf(ctx, s.deleteOnly.id, RWD);
    expect((await listTrashOf(ctx.app, delOnly)).items.map(i => i.id)).not.toContain(notes.deleteOnly);
    const back = await call(ctx.app, delOnly, "restore_note", { note_id: notes.deleteOnly! });
    expect(back.structuredContent).toEqual({ code: "not_found", message: RESTORE_NOT_FOUND_MESSAGE });
    expect(await isTrashed(ctx.db, notes.deleteOnly!)).toBe(true);
  });
});

describe("DN5 大寫 id", () => {
  it("note_id 全大寫 → 成功、回應 id 是小寫、DB 列被移入", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const out = await deleteOk(ctx.app, await tokenOf(ctx, me.id, RWD), n.id.toUpperCase());
    expect(out.id).toBe(n.id);
    expect(await isTrashed(ctx.db, n.id)).toBe(true);
  });
});

describe("DN13 長標題", () => {
  it("標題 300 個 \" → titleTruncated true、escapedLength ≤ 200、已移入", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: '"'.repeat(300) });
    const out = await deleteOk(ctx.app, await tokenOf(ctx, me.id, RWD), n.id);
    expect(out.titleTruncated).toBe(true);
    expect(escapedLength(out.title)).toBeLessThanOrEqual(200);
    expect(out.title).toBe('"'.repeat(100)); // 前提：真的被截了（一個 " 逃脫後算 2）
    expect(await isTrashed(ctx.db, n.id)).toBe(true);
  });
});

describe("DN6 TOCTOU：鎖後在交易內被降權", () => {
  it("note-trash-locked 縫把 editDelete 的角色改成無刪除 → forbidden、deleted_at 仍 NULL、閘門已收", async () => {
    const holder: { db?: Db; roleId?: string } = {};
    const hook: GroupTestHook = async point => {
      if (point === "note-trash-locked" && holder.roleId) await holder.db!.update(groupRoles).set({ canDelete: false }).where(eq(groupRoles.id, holder.roleId));
    };
    const ctx = await buildCollabTestApp({ ...realHooks, groupTestHook: hook });
    holder.db = ctx.db;
    const s = await sixRoleScene(ctx.db);
    const [m] = await ctx.db.select({ roleId: groupMembers.roleId }).from(groupMembers).where(eq(groupMembers.userId, s.editDelete.id));
    holder.roleId = m!.roleId;
    const n = await seedNote(ctx.db, { groupId: s.groupId });

    const r = await call(ctx.app, await tokenOf(ctx, s.editDelete.id, RWD), "delete_note", { note_id: n.id });
    expect(r.structuredContent).toEqual({ code: "forbidden", message: DELETE_FORBIDDEN_MESSAGE });
    expect(await trashCols(ctx.db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
    await vi.waitFor(() => expect(ctx.collab.isDeleting(n.id)).toBe(false));
  });
});

describe("DN7 edit 桶", () => {
  it("edit 桶 0 格：owner → too_many_requests、deleted_at 仍 NULL；outsider → not_found、viewer 分享者 → forbidden（兩道檢查都在扣桶之前）", async () => {
    const ctx = await buildCollabTestApp({ limiters: { edit: emptyLimiter() } });
    const owner = await seedUser(ctx.db);
    const outsider = await seedUser(ctx.db);
    const viewer = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: owner.id });
    await seedShare(ctx.db, n.id, viewer.id, "viewer");

    expect((await call(ctx.app, await tokenOf(ctx, owner.id, RWD), "delete_note", { note_id: n.id })).structuredContent?.code).toBe("too_many_requests");
    expect(await isTrashed(ctx.db, n.id)).toBe(false);
    expect((await call(ctx.app, await tokenOf(ctx, outsider.id, RWD), "delete_note", { note_id: n.id })).structuredContent).toEqual({
      code: "not_found",
      message: DELETE_NOT_FOUND_MESSAGE,
    });
    expect((await call(ctx.app, await tokenOf(ctx, viewer.id, RWD), "delete_note", { note_id: n.id })).structuredContent).toEqual({
      code: "forbidden",
      message: DELETE_FORBIDDEN_MESSAGE,
    });
  });
});

describe("DN8 token 寫入預算（gate r1 I1；tokenWrite 扣點在 HTTP 上是活的）", () => {
  it("tokenWrite 0 格：RWD 憑證 → too_many_requests、deleted_at 仍 NULL、edit 桶沒被扣；session 照常成功", async () => {
    const edit = editLimiter();
    const ctx = await buildCollabTestApp({ limiters: { tokenWrite: emptyLimiter(), edit } });
    const me = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const theirs = await seedNote(ctx.db, { ownerId: other.id });

    const r = await call(ctx.app, await tokenOf(ctx, me.id, RWD), "delete_note", { note_id: n.id });
    expect(r.structuredContent?.code).toBe("too_many_requests");
    expect(await trashCols(ctx.db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
    expect(remaining(edit, me.id)).toBe(EDIT_N);

    await deleteOk(ctx.app, await sessionOf(other.id), theirs.id);
    expect(await isTrashed(ctx.db, theirs.id)).toBe(true);
  });

  it("共享鍵：tokenWrite 2 格，edit_note append 一格、delete_note 一格成功，第三發 delete_note → too_many_requests（桶 key 與既有寫入工具同為 token:${userId}）", async () => {
    const ctx = await buildCollabTestApp({ limiters: { tokenWrite: new FixedWindowLimiter({ limit: 2, windowMs: 600_000 }) } });
    const me = await seedUser(ctx.db);
    const a = await seedNote(ctx.db, { ownerId: me.id });
    const b = await seedNote(ctx.db, { ownerId: me.id });
    const c = await seedNote(ctx.db, { ownerId: me.id });
    const auth = await tokenOf(ctx, me.id, RWD);

    const appended = await call(ctx.app, auth, "edit_note", { note_id: a.id, op: "append", markdown: "DN8" });
    expect(appended.isError, JSON.stringify(appended.structuredContent)).toBeUndefined();
    await deleteOk(ctx.app, auth, b.id);
    const third = await call(ctx.app, auth, "delete_note", { note_id: c.id });
    expect(third.structuredContent?.code).toBe("too_many_requests");
    expect(await isTrashed(ctx.db, c.id)).toBe(false);
  });
});

describe("DN9 交易被併發犧牲（gate r1 m5）", () => {
  it("note-trash-locked 丟 40001 → server_busy＋DELETE_BUSY_MESSAGE；deleted_at 仍 NULL；閘門已收", async () => {
    const ctx = await buildCollabTestApp({
      ...realHooks,
      groupTestHook: async point => {
        if (point === "note-trash-locked") throw busyErr();
      },
    });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const r = await call(ctx.app, await tokenOf(ctx, me.id, RWD), "delete_note", { note_id: n.id });
    expect(r.structuredContent).toEqual({ code: "server_busy", message: DELETE_BUSY_MESSAGE });
    expect(await trashCols(ctx.db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
    await vi.waitFor(() => expect(ctx.collab.isDeleting(n.id)).toBe(false));
  });

  // DN9b：busy 句宣稱「沒移入」只對可重試的交易中止成立；其他例外交給 runTool 收成 internal（不得一律 server_busy）。
  it("DN9b：note-trash-locked 丟一般 Error → internal（不是 server_busy）；deleted_at 仍 NULL", async () => {
    const ctx = await buildCollabTestApp({
      groupTestHook: async point => {
        if (point === "note-trash-locked") throw new Error("boom");
      },
    });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const r = await call(ctx.app, await tokenOf(ctx, me.id, RWD), "delete_note", { note_id: n.id });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.code).toBe("internal");
    expect(await trashCols(ctx.db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
  });
});

describe("DN10 站台設定列不在", () => {
  it("DELETE FROM site_settings 後 delete_note → internal、deleted_at 仍 NULL、edit 桶沒被扣（設定在扣桶與移入之前讀）", async () => {
    const edit = editLimiter();
    const ctx = await buildCollabTestApp({ limiters: { edit } });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    await ctx.db.$client.query(`delete from site_settings`);
    const r = await call(ctx.app, await tokenOf(ctx, me.id, RWD), "delete_note", { note_id: n.id });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.code).toBe("internal");
    expect(await trashCols(ctx.db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
    expect(remaining(edit, me.id)).toBe(EDIT_N);
  });
});

describe("DN11 purgeAt 跟著當下設定", () => {
  it("保留 3 天 → purgeAt＝deleted_at＋3 天（SQL 算）；NULL → null；兩種都等於緊接著 list_trash 那一項", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const auth = await tokenOf(ctx, me.id, RWD);
    const sqlPurge = async (id: string, days: number) =>
      (await ctx.db.$client.query<{ p: Date }>(`select deleted_at + make_interval(days => $2::int) as p from notes where id = $1`, [id, days])).rows[0]!.p.toISOString();
    const itemPurge = async (id: string) => (await listTrashOf(ctx.app, auth)).items.find(i => i.id === id)!.purgeAt;

    await ctx.db.$client.query(`update site_settings set trash_retention_days = 3`);
    const a = await seedNote(ctx.db, { ownerId: me.id });
    const outA = await deleteOk(ctx.app, auth, a.id);
    expect(outA.purgeAt).toBe(await sqlPurge(a.id, 3));
    expect(outA.purgeAt).toBe(await itemPurge(a.id));

    await ctx.db.$client.query(`update site_settings set trash_retention_days = null`);
    const b = await seedNote(ctx.db, { ownerId: me.id });
    const outB = await deleteOk(ctx.app, auth, b.id);
    expect(outB.purgeAt).toBeNull();
    expect(await itemPurge(b.id)).toBeNull();
  });
});

describe("DN12 授權之後才落空：commit 後重讀（讀碼發現 6）與交易內重判", () => {
  it("移入交易持鎖時 site_settings 列被刪 → 移入照樣 commit，loadTrashedMeta 落空 → not_found＋同一句", async () => {
    const holder: { db?: Db; armed?: boolean } = {};
    const hook: GroupTestHook = async point => {
      if (point === "note-trash-locked" && holder.armed) await holder.db!.$client.query(`delete from site_settings`);
    };
    const ctx = await buildCollabTestApp({ groupTestHook: hook });
    holder.db = ctx.db;
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    holder.armed = true;
    const r = await call(ctx.app, await tokenOf(ctx, me.id, RWD), "delete_note", { note_id: n.id });
    expect(r.structuredContent).toEqual({ code: "not_found", message: DELETE_NOT_FOUND_MESSAGE });
    expect(await isTrashed(ctx.db, n.id)).toBe(true); // 前提：移入確實 commit 了，落空的是 commit 後那一讀
  });

  it("交易內重判 none（授權之後被別人先移入）→ not_found＋同一句，deleted_by 仍是先移入的人", async () => {
    let open!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    let entered!: () => void;
    const inside = new Promise<void>(r => { entered = r; });
    let first = true;
    const hook: GroupTestHook = async point => {
      if (point !== "note-trash-locked" || !first) return;
      first = false;
      entered();
      await gate;
    };
    const ctx = await buildCollabTestApp({ groupTestHook: hook });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const rest = inject(ctx.app, "DELETE", `/api/notes/${n.id}`, me.id);
    await inside;
    const mcp = call(ctx.app, await tokenOf(ctx, me.id, RWD), "delete_note", { note_id: n.id });
    try {
      await waitForLockWaiters(ctx.db.$client, 1);
    } finally {
      open();
    }
    expect((await rest).statusCode).toBe(204);
    expect((await mcp).structuredContent).toEqual({ code: "not_found", message: DELETE_NOT_FOUND_MESSAGE });
    expect((await trashCols(ctx.db.$client, n.id))!.deleted_by).toBe(me.id);
  });
});

describe("RN1 owner 還原", () => {
  it("delete_note → restore_note：role owner、url 與移入前 list_notes 相同；deleted_at／deleted_by NULL；閘門已開；list_notes 又列得到", async () => {
    const ctx = await buildCollabTestApp(realHooks);
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "RN1" });
    const auth = await tokenOf(ctx, me.id, RWD);
    const before = (await listNotesIds(ctx.app, auth)).find(x => x.id === n.id)!;
    await deleteOk(ctx.app, auth, n.id);
    expect(ctx.collab.isDeleting(n.id)).toBe(true);

    const note = await restoreOk(ctx.app, auth, n.id);
    expect(note).toMatchObject({ id: n.id, title: "RN1", role: "owner", url: before.url, owner: { kind: "user" } });
    expect(await trashCols(ctx.db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
    await vi.waitFor(() => expect(ctx.collab.isDeleting(n.id)).toBe(false));
    expect((await listNotesIds(ctx.app, auth)).map(x => x.id)).toContain(n.id);
  });
});

describe("RN2 not_found 同形（AG2）", () => {
  it("已還原的同一篇、活筆記、隨機 uuid、別人的個人垃圾桶筆記 → structuredContent 逐欄相同", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const live = await seedNote(ctx.db, { ownerId: me.id });
    const theirs = await seedNote(ctx.db, { ownerId: other.id });
    await markTrashed(ctx.db.$client, n.id, me.id);
    await markTrashed(ctx.db.$client, theirs.id, other.id);
    const auth = await tokenOf(ctx, me.id, RWD);
    await restoreOk(ctx.app, auth, n.id);

    const random = await call(ctx.app, auth, "restore_note", { note_id: randomUUID() });
    expect(random.isError).toBe(true);
    expect(random.structuredContent).toEqual({ code: "not_found", message: RESTORE_NOT_FOUND_MESSAGE });
    for (const id of [n.id, live.id, theirs.id]) expect(await call(ctx.app, auth, "restore_note", { note_id: id })).toEqual(random);
    expect(await isTrashed(ctx.db, theirs.id)).toBe(true);
  });

  it("預判之後被別人先還原（交易內 not_in_trash）→ 同一句 not_found", async () => {
    let open!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    let entered!: () => void;
    const inside = new Promise<void>(r => { entered = r; });
    let first = true;
    const hook: GroupTestHook = async point => {
      if (point !== "note-restore-locked" || !first) return;
      first = false;
      entered();
      await gate;
    };
    const ctx = await buildCollabTestApp({ groupTestHook: hook });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    await markTrashed(ctx.db.$client, n.id, me.id);
    const rest = inject(ctx.app, "POST", "/api/trash/restore", me.id, { ids: [n.id] });
    await inside;
    const mcp = call(ctx.app, await tokenOf(ctx, me.id, RWD), "restore_note", { note_id: n.id });
    try {
      await waitForLockWaiters(ctx.db.$client, 1);
    } finally {
      open();
    }
    expect(((await rest).json() as { restored: Array<{ id: string }> }).restored.map(x => x.id)).toEqual([n.id]);
    expect((await mcp).structuredContent).toEqual({ code: "not_found", message: RESTORE_NOT_FOUND_MESSAGE });
  });
});

describe("RN3 群組", () => {
  it("editDelete 還原 admin 移入的群組筆記 → owner.kind group、role editor", async () => {
    const ctx = await buildCollabTestApp();
    const s = await sixRoleScene(ctx.db);
    const n = await seedNote(ctx.db, { groupId: s.groupId });
    await markTrashed(ctx.db.$client, n.id, s.admin.id);
    const note = await restoreOk(ctx.app, await tokenOf(ctx, s.editDelete.id, RWD), n.id);
    expect(note).toMatchObject({ id: n.id, role: "editor", owner: { kind: "group" } });
    expect(await isTrashed(ctx.db, n.id)).toBe(false);
  });
});

describe("RN4 六角色", () => {
  it("admin、editDelete 成功；deleteOnly、editOnly、member、readOnly、outsider → 與隨機 uuid 逐欄相同的 not_found", async () => {
    const ctx = await buildCollabTestApp();
    const s = await sixRoleScene(ctx.db);
    const roles = ["admin", "editDelete", "deleteOnly", "editOnly", "member", "readOnly", "outsider"] as const;
    const got: Record<string, unknown> = {};
    for (const r of roles) {
      const n = await seedNote(ctx.db, { groupId: s.groupId });
      await markTrashed(ctx.db.$client, n.id, s.admin.id);
      const res = await call(ctx.app, await tokenOf(ctx, s[r].id, RWD), "restore_note", { note_id: n.id });
      got[r] = res.isError ? res.structuredContent : "ok";
      expect({ r, trashed: await isTrashed(ctx.db, n.id) }).toEqual({ r, trashed: !!res.isError });
    }
    const random = (await call(ctx.app, await tokenOf(ctx, s.outsider.id, RWD), "restore_note", { note_id: randomUUID() })).structuredContent;
    expect(random).toEqual({ code: "not_found", message: RESTORE_NOT_FOUND_MESSAGE });
    expect(got).toEqual({ admin: "ok", editDelete: "ok", deleteOnly: random, editOnly: random, member: random, readOnly: random, outsider: random });
  });
});

describe("RN5 edit 桶", () => {
  it("edit 桶 0 格：owner → too_many_requests、仍在垃圾桶；無垃圾桶權者 → not_found（預判在扣桶之前）", async () => {
    const ctx = await buildCollabTestApp({ limiters: { edit: emptyLimiter() } });
    const owner = await seedUser(ctx.db);
    const outsider = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: owner.id });
    await markTrashed(ctx.db.$client, n.id, owner.id);
    expect((await call(ctx.app, await tokenOf(ctx, owner.id, RWD), "restore_note", { note_id: n.id })).structuredContent?.code).toBe("too_many_requests");
    expect(await isTrashed(ctx.db, n.id)).toBe(true);
    expect((await call(ctx.app, await tokenOf(ctx, outsider.id, RWD), "restore_note", { note_id: n.id })).structuredContent).toEqual({
      code: "not_found",
      message: RESTORE_NOT_FOUND_MESSAGE,
    });
  });
});

describe("RN6 token 寫入預算", () => {
  it("tokenWrite 0 格：RWD 憑證 restore_note → too_many_requests、仍在垃圾桶、edit 桶沒被扣；session 照常成功", async () => {
    const edit = editLimiter();
    const ctx = await buildCollabTestApp({ limiters: { tokenWrite: emptyLimiter(), edit } });
    const me = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const theirs = await seedNote(ctx.db, { ownerId: other.id });
    await markTrashed(ctx.db.$client, n.id, me.id);
    await markTrashed(ctx.db.$client, theirs.id, other.id);

    const r = await call(ctx.app, await tokenOf(ctx, me.id, RWD), "restore_note", { note_id: n.id });
    expect(r.structuredContent?.code).toBe("too_many_requests");
    expect(await isTrashed(ctx.db, n.id)).toBe(true);
    expect(remaining(edit, me.id)).toBe(EDIT_N);

    await restoreOk(ctx.app, await sessionOf(other.id), theirs.id);
    expect(await isTrashed(ctx.db, theirs.id)).toBe(false);
  });
});

describe("RN7 交易被併發犧牲（gate r1 m5）", () => {
  it("note-restore-locked 丟 40001 → server_busy＋RESTORE_BUSY_MESSAGE；仍在垃圾桶", async () => {
    const ctx = await buildCollabTestApp({
      groupTestHook: async point => {
        if (point === "note-restore-locked") throw busyErr();
      },
    });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    await markTrashed(ctx.db.$client, n.id, me.id);
    const before = await trashCols(ctx.db.$client, n.id);
    const r = await call(ctx.app, await tokenOf(ctx, me.id, RWD), "restore_note", { note_id: n.id });
    expect(r.structuredContent).toEqual({ code: "server_busy", message: RESTORE_BUSY_MESSAGE });
    expect(await trashCols(ctx.db.$client, n.id)).toEqual(before);
  });

  // RN7b：同 DN9b——「was not restored」只對可重試的交易中止成立；其他例外是 internal。
  it("RN7b：note-restore-locked 丟一般 Error → internal（不是 server_busy）；仍在垃圾桶", async () => {
    const ctx = await buildCollabTestApp({
      groupTestHook: async point => {
        if (point === "note-restore-locked") throw new Error("boom");
      },
    });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    await markTrashed(ctx.db.$client, n.id, me.id);
    const before = await trashCols(ctx.db.$client, n.id);
    const r = await call(ctx.app, await tokenOf(ctx, me.id, RWD), "restore_note", { note_id: n.id });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.code).toBe("internal");
    expect(await trashCols(ctx.db.$client, n.id)).toEqual(before);
  });
});

describe("DS1 模型面字串（gate r1 I2、r2 I2）", () => {
  it("delete_note／restore_note 的 description 與 purgeAt 說明：新子句在、被拿掉的舊說法不在", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const tools = (await mcpPost(ctx.app, rpc("tools/list"), await tokenOf(ctx, me.id, RWD))).json().result.tools as Array<{
      name: string;
      description: string;
      outputSchema: { properties: Record<string, { description?: string }> };
    }>;
    const del = tools.find(t => t.name === "delete_note")!;
    const res = tools.find(t => t.name === "restore_note")!;
    expect(del.description).toContain("or sooner if someone deletes it permanently in the web app");
    expect(del.description).toContain("an admin can change that setting");
    expect(del.description).toContain("without that list_trash won't show it either");
    expect(del.description).toContain("A note that is already in the trash answers not_found — use list_trash to check.");
    expect(del.description).not.toContain("as it was");
    expect(del.description).not.toContain("Nothing is deleted permanently:");
    expect(del.outputSchema.properties.purgeAt!.description).toContain("an admin can change it");
    expect(del.outputSchema.properties.purgeAt!.description).toContain("list_trash shows the current date");
    expect(res.description).toContain("a different owner and URL");
    expect(res.description).not.toContain("same URL");
    // RN-D（資料夾 PR-3d）：RN+ 在、回應形那句仍在。
    expect(res.description).toContain(
      "It usually goes back into the folder that list_trash shows as its `folderPath`, re-creating folders on that path that are missing.",
    );
    expect(res.description).toContain("Replies with the note in the same shape list_notes returns.");
  });
});

describe("PX REST／MCP 同一份 fixture（§6.14）", () => {
  it("六角色＋outsider＋逐人分享的檢視者／編輯者 × 移入／列出／還原：REST 與 MCP 的結果對映表逐格相同", async () => {
    const ctx = await buildCollabTestApp();
    const s = await sixRoleScene(ctx.db);
    // 逐人分享（spec §6.3.1「逐人分享的編輯者／檢視者」）：另一人的個人筆記分享給他們。
    const shareOwner = await seedUser(ctx.db);
    const users: Record<string, SeededUser> = {
      admin: s.admin, editDelete: s.editDelete, deleteOnly: s.deleteOnly, member: s.member, editOnly: s.editOnly, readOnly: s.readOnly,
      outsider: s.outsider, shareViewer: await seedUser(ctx.db), shareEditor: await seedUser(ctx.db),
    };
    const shareRole = { shareViewer: "viewer", shareEditor: "editor" } as Record<string, "viewer" | "editor">;
    const roles = ["admin", "editDelete", "deleteOnly", "member", "editOnly", "readOnly", "outsider", "shareViewer", "shareEditor"] as const;
    const fresh = async (r: string, trashed: boolean) => {
      const role = shareRole[r];
      const n = role ? await seedNote(ctx.db, { ownerId: shareOwner.id }) : await seedNote(ctx.db, { groupId: s.groupId });
      if (role) await seedShare(ctx.db, n.id, users[r]!.id, role);
      if (trashed) await markTrashed(ctx.db.$client, n.id, role ? shareOwner.id : s.admin.id);
      return n.id;
    };
    const restDelete = { 204: "ok", 403: "forbidden", 404: "not_found" } as Record<number, string>;
    const table = { rest: {} as Record<string, string[]>, mcp: {} as Record<string, string[]> };
    for (const r of roles) {
      const u = users[r]!;
      const auth = await tokenOf(ctx, u.id, RWD);
      const mcpCode = (x: Result) => (x.isError ? String(x.structuredContent?.code) : "ok");

      const d1 = await fresh(r, false);
      const restDel = restDelete[(await inject(ctx.app, "DELETE", `/api/notes/${d1}`, u.id)).statusCode] ?? "other";
      const mcpDel = mcpCode(await call(ctx.app, auth, "delete_note", { note_id: await fresh(r, false) }));

      const l1 = await fresh(r, true);
      const restList = (await restListOf(ctx.app, u.id)).items.some(i => i.id === l1) ? "listed" : "absent";
      const l2 = await fresh(r, true);
      const mcpList = (await listTrashOf(ctx.app, auth)).items.some(i => i.id === l2) ? "listed" : "absent";

      const r1 = await fresh(r, true);
      const body = (await inject(ctx.app, "POST", "/api/trash/restore", u.id, { ids: [r1] })).json() as {
        restored: Array<{ id: string }>;
        skipped: Array<{ id: string; reason: string }>;
      };
      const restRes = body.restored.some(x => x.id === r1) ? "ok" : (body.skipped.find(x => x.id === r1)?.reason ?? "other");
      const mcpRes = mcpCode(await call(ctx.app, auth, "restore_note", { note_id: await fresh(r, true) }));

      table.rest[r] = [restDel, restList, restRes];
      table.mcp[r] = [mcpDel, mcpList, mcpRes];
    }
    expect(table.mcp).toEqual(table.rest);
    expect(table.rest).toEqual({
      admin: ["ok", "listed", "ok"],
      editDelete: ["ok", "listed", "ok"],
      deleteOnly: ["ok", "absent", "not_found"],
      member: ["forbidden", "absent", "not_found"],
      editOnly: ["forbidden", "absent", "not_found"],
      readOnly: ["forbidden", "absent", "not_found"],
      outsider: ["not_found", "absent", "not_found"],
      shareViewer: ["forbidden", "absent", "not_found"],
      shareEditor: ["forbidden", "absent", "not_found"],
    });
  });
});

describe("SC1 註冊與 AG3", () => {
  it("R／RW／RWM 沒有 delete_note／restore_note／delete_folder（資料夾 PR-3d T8）、有 list_trash；RWD／RWMD／session 四支都有；名字都不含 purge／empty／permanent；RWM 直接呼叫 delete_note → Tool not found", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const namesOf = async (auth: Auth) => ((await mcpPost(ctx.app, rpc("tools/list"), auth)).json().result.tools as Array<{ name: string }>).map(t => t.name);
    const has = (names: string[]) => ["list_trash", "delete_note", "restore_note", "delete_folder"].map(x => names.includes(x));
    const cases: Array<[string, Auth, boolean[]]> = [
      ["R", await tokenOf(ctx, me.id, R), [true, false, false, false]],
      ["RW", await tokenOf(ctx, me.id, RW), [true, false, false, false]],
      ["RWM", await tokenOf(ctx, me.id, RWM), [true, false, false, false]],
      ["RWD", await tokenOf(ctx, me.id, RWD), [true, true, true, true]],
      ["RWMD", await tokenOf(ctx, me.id, RWMD), [true, true, true, true]],
      ["session", await sessionOf(me.id), [true, true, true, true]],
    ];
    for (const [label, auth, want] of cases) {
      const names = await namesOf(auth);
      expect({ label, has: has(names) }).toEqual({ label, has: want });
      expect({ label, bad: names.filter(x => /purge|empty|permanent/i.test(x)) }).toEqual({ label, bad: [] });
    }
    const direct = await call(ctx.app, cases[2]![1], "delete_note", { note_id: n.id });
    expect(direct.isError).toBe(true);
    expect(direct.structuredContent).toBeUndefined();
    expect(direct.content[0]!.text).toContain("Tool delete_note not found");
    expect(await isTrashed(ctx.db, n.id)).toBe(false);
  });
});

describe("SC2 AG6（PR-2d 部分）", () => {
  it("RWMD 憑證：edit_note append、copy_note（個人、群組）、create_note（群組）、move_note_to_group 之後沒有任何筆記在垃圾桶", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "SC2", [{ userId: me.id, role: "admin" }]);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "SC2" });
    const auth = await tokenOf(ctx, me.id, RWMD);
    const trashedCount = async () => (await ctx.db.$client.query<{ n: number }>(`select count(*)::int n from notes where deleted_at is not null`)).rows[0]!.n;
    const ok = async (name: string, args: Record<string, unknown>) => {
      const r = await call(ctx.app, auth, name, args);
      expect(await trashedCount(), `${name} 之後`).toBe(0);
      expect(r.isError, `${name} ${JSON.stringify(r.structuredContent)}`).toBeUndefined();
    };
    await ok("edit_note", { note_id: n.id, op: "append", markdown: "SC2 一段" });
    await ok("copy_note", { note_id: n.id });
    await ok("copy_note", { note_id: n.id, group_id: g.id });
    await ok("create_note", { title: "SC2 group", group_id: g.id });
    await ok("move_note_to_group", { note_id: n.id, group_id: g.id });
    const { rows } = await ctx.db.$client.query<{ n: number }>(`select count(*)::int n from notes`);
    expect(rows[0]!.n).toBe(4); // 原篇、兩份副本、新建那篇
  });
});

/** 由葉往根走 `parent_id`，回根 → 葉的名字。 */
async function folderPathOf(db: Db, folderId: string): Promise<string[]> {
  const out: string[] = [];
  let cur: string | null = folderId;
  while (cur !== null) {
    const f = await folderRow(db.$client, cur);
    expect(f, `folder ${cur}`).toBeDefined();
    out.unshift(f!.name);
    cur = f!.parent_id;
  }
  return out;
}

describe("FD1 資料夾裡的筆記：delete_note → restore_note（個人）", () => {
  it("移入後 folder_id 不動、快照 [A,B,C]（REST folderPath 相同）；restore_note 回同一個資料夾、快照清掉", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const [, , c] = await seedFolderChain(ctx.db, { personal: me.id }, ["A", "B", "C"]);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "FD1" });
    await setNoteFolder(ctx.db.$client, n.id, c!);
    const auth = await tokenOf(ctx, me.id, RWD);

    await deleteOk(ctx.app, auth, n.id);
    expect(await noteFolderCols(ctx.db.$client, n.id)).toEqual({ folder_id: c, trash_folder_path: ["A", "B", "C"] });
    expect((await restListOf(ctx.app, me.id)).items.map(i => [i.id, i.folderPath])).toEqual([[n.id, ["A", "B", "C"]]]);

    await restoreOk(ctx.app, auth, n.id);
    expect(await noteFolderCols(ctx.db.$client, n.id)).toEqual({ folder_id: c, trash_folder_path: null });
  });
});

describe("FD2 資料夾在垃圾桶期間被刪：restore_note 重建路徑", () => {
  it("個人：DELETE /api/folders/A 之後 folder_id NULL、快照仍在；restore_note → 新的 A/B/C（個人空間）、筆記在 C、快照清掉", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const [a, , c] = await seedFolderChain(ctx.db, { personal: me.id }, ["A", "B", "C"]);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    await setNoteFolder(ctx.db.$client, n.id, c!);
    const auth = await tokenOf(ctx, me.id, RWD);
    await deleteOk(ctx.app, auth, n.id);
    const del = await inject(ctx.app, "DELETE", `/api/folders/${a}`, me.id);
    expect(del.statusCode, del.body).toBe(200);
    expect(await noteFolderCols(ctx.db.$client, n.id)).toEqual({ folder_id: null, trash_folder_path: ["A", "B", "C"] });

    await restoreOk(ctx.app, auth, n.id);
    const cols = (await noteFolderCols(ctx.db.$client, n.id))!;
    expect(cols.trash_folder_path).toBeNull();
    expect(cols.folder_id).not.toBeNull();
    expect(cols.folder_id).not.toBe(c);
    expect(await folderPathOf(ctx.db, cols.folder_id!)).toEqual(["A", "B", "C"]);
    expect(await folderRow(ctx.db.$client, cols.folder_id!)).toMatchObject({ kind: "personal", owner_id: me.id, group_id: null });
  });

  it("群組：admin 刪掉群組資料夾 X 之後 restore_note → 新的 X/Y 建在同一個群組、筆記在 Y", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "FD2", [{ userId: me.id, role: "admin" }]);
    const [x, y] = await seedFolderChain(ctx.db, { group: g.id }, ["X", "Y"]);
    const n = await seedNote(ctx.db, { groupId: g.id });
    await setNoteFolder(ctx.db.$client, n.id, y!);
    const auth = await tokenOf(ctx, me.id, RWD);
    await deleteOk(ctx.app, auth, n.id);
    expect(await noteFolderCols(ctx.db.$client, n.id)).toEqual({ folder_id: y, trash_folder_path: ["X", "Y"] });
    const del = await inject(ctx.app, "DELETE", `/api/folders/${x}`, me.id);
    expect(del.statusCode, del.body).toBe(200);

    await restoreOk(ctx.app, auth, n.id);
    const cols = (await noteFolderCols(ctx.db.$client, n.id))!;
    expect(cols.trash_folder_path).toBeNull();
    expect(cols.folder_id).not.toBeNull();
    expect(cols.folder_id).not.toBe(y);
    expect(await folderPathOf(ctx.db, cols.folder_id!)).toEqual(["X", "Y"]);
    expect(await folderRow(ctx.db.$client, cols.folder_id!)).toMatchObject({ kind: "group", owner_id: null, group_id: g.id });
  });
});

describe("FD3 MCP 回應的資料夾欄（restore_note 帶 folder、list_trash 帶 folderPath、delete_note 沒有）", () => {
  it("資料夾裡的筆記：delete_note 沒有含 folder 的鍵；list_trash 的 folderPath 與 REST 同值；restore_note 的 note.folder 是原資料夾", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const [f] = await seedFolderChain(ctx.db, { personal: me.id }, ["F"]);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "FD3" });
    await setNoteFolder(ctx.db.$client, n.id, f!);
    const auth = await tokenOf(ctx, me.id, RWD);
    const keysOf = (v: unknown): string[] => {
      if (Array.isArray(v)) return v.flatMap(keysOf);
      if (v === null || typeof v !== "object") return [];
      return Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]);
    };
    const folderKeys = (v: unknown) => keysOf(v).filter(k => /folder/i.test(k));

    expect(folderKeys(await deleteOk(ctx.app, auth, n.id))).toEqual([]);
    const listed = await listTrashOf(ctx.app, auth);
    expect(listed.items.map(i => i.id)).toEqual([n.id]);
    expect(listed.items[0]!.folderPath).toEqual(["F"]);
    expect(folderKeys(listed)).toEqual(["folderPath"]);
    expect((await restListOf(ctx.app, me.id)).items[0]!.folderPath).toEqual(["F"]);
    const note = await restoreOk(ctx.app, auth, n.id);
    expect(note.id).toBe(n.id);
    expect((note as NoteSummary & { folder?: unknown }).folder).toEqual({ id: f, name: "F" });
    expect(folderKeys(note)).toEqual(["folder"]); // 多出其他含 folder 的鍵就紅
    expect((await noteFolderCols(ctx.db.$client, n.id))!.folder_id).toBe(f);
  });
});
