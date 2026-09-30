/**
 * #103 群組測試共用的種子與量測工具。**只在測試裡直插**——`db.insert(notes)` 在 `test/` 不受
 * `notes-slug.test.ts` 的源碼守衛管轄（那條只掃 `src/`）。
 * 大量種子一律明寫 `slug`／`handle`：吃 `untitled-<uuid8>`／`user-<uuid8>` DEFAULT 有生日問題（#150）。
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { and, eq, sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import { SESSION_COOKIE } from "@knotebook/shared";
import { signSession } from "../src/auth/session.js";
import type { CollabHooks } from "../src/collab/hooks.js";
import type { Db } from "../src/db/index.js";
import { groupMembers, groupRoles, groups, noteRedirects, noteShares, notes, users } from "../src/db/schema.js";
import { testConfig } from "./helpers.js";

export interface SeededUser {
  id: string;
  email: string;
  handle: string;
}

export async function seedUser(
  db: Db,
  over: { isAdmin?: boolean; displayName?: string; disabled?: boolean } = {},
): Promise<SeededUser> {
  const tag = randomUUID().slice(0, 12);
  const [u] = await db
    .insert(users)
    .values({
      email: `grp-${tag}@example.com`,
      handle: `grp-${tag}`,
      displayName: over.displayName ?? `User ${tag}`,
      isAdmin: over.isAdmin ?? false,
      ...(over.disabled ? { disabledAt: new Date() } : {}),
    })
    .returning();
  return { id: u!.id, email: u!.email, handle: u!.handle };
}

/** `app.inject({ cookies })` 用的 session cookie（直接簽，tv=0——與 insert 預設的 token_version 一致）。 */
export async function cookieOf(userId: string): Promise<Record<string, string>> {
  return { [SESSION_COOKIE]: await signSession(testConfig.appSecret, { userId, tv: 0 }) };
}

/** 建群組＋兩個內建角色（與 0012 步驟 2、`createGroupInTx` 同旗標）＋成員。回兩個內建角色的 id。 */
export async function seedGroup(
  db: Db,
  name: string,
  members: ReadonlyArray<{ userId: string; role: "admin" | "member" }>,
): Promise<{ id: string; adminRoleId: string; memberRoleId: string }> {
  const [g] = await db.insert(groups).values({ name, createdBy: members[0]?.userId ?? null }).returning({ id: groups.id });
  const [admin] = await db
    .insert(groupRoles)
    .values({ groupId: g!.id, builtin: "admin", canRead: true, canCreate: true, canEdit: true, canDelete: true, canManagePublicLink: true, canManageMembers: true, canManageGroup: true })
    .returning({ id: groupRoles.id });
  const [member] = await db
    .insert(groupRoles)
    .values({ groupId: g!.id, builtin: "member", canRead: true, canCreate: true, canEdit: true })
    .returning({ id: groupRoles.id });
  if (members.length > 0) {
    await db.insert(groupMembers).values(
      members.map(m => ({ groupId: g!.id, userId: m.userId, roleId: m.role === "admin" ? admin!.id : member!.id })),
    );
  }
  return { id: g!.id, adminRoleId: admin!.id, memberRoleId: member!.id };
}

type RoleFlag = "canRead" | "canCreate" | "canEdit" | "canDelete" | "canManagePublicLink" | "canManageMembers" | "canManageGroup";

/** 自訂角色（PR1 沒有建角色的端點——只在測試裡直插；旗標蘊含由 DB CHECK 守，給錯組合會 23514）。 */
export async function seedRole(db: Db, groupId: string, name: string, flags: Partial<Record<RoleFlag, boolean>>): Promise<string> {
  const [r] = await db.insert(groupRoles).values({ groupId, name, canRead: false, ...flags }).returning({ id: groupRoles.id });
  return r!.id;
}

export async function setMemberRole(db: Db, groupId: string, userId: string, roleId: string): Promise<void> {
  await db.update(groupMembers).set({ roleId }).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
}

/** 個人筆記給 `{ ownerId }`、群組筆記給 `{ groupId }`（XOR，S6）。slug 預設隨機（#150 生日問題）。 */
export async function seedNote(
  db: Db,
  owner: { ownerId: string } | { groupId: string },
  opts: { title?: string; slug?: string; slugIsCustom?: boolean; prevSlug?: string; legacySlug?: string; publicToken?: string; publicSlug?: string } = {},
): Promise<{ id: string; slug: string }> {
  const slug = opts.slug ?? `n-${randomUUID().slice(0, 12)}`;
  const [n] = await db
    .insert(notes)
    .values({
      ...("groupId" in owner ? { groupId: owner.groupId } : { ownerId: owner.ownerId }),
      title: opts.title ?? "Untitled",
      slug,
      ...(opts.slugIsCustom !== undefined ? { slugIsCustom: opts.slugIsCustom } : {}),
      ...(opts.prevSlug !== undefined ? { prevSlug: opts.prevSlug } : {}),
      ...(opts.legacySlug !== undefined ? { legacySlug: opts.legacySlug } : {}),
      ...(opts.publicToken !== undefined ? { publicToken: opts.publicToken } : {}),
      ...(opts.publicSlug !== undefined ? { publicSlug: opts.publicSlug } : {}),
    })
    .returning({ id: notes.id });
  return { id: n!.id, slug };
}

/** 直插一列轉址（PR1 沒有寫轉址的生產路徑——PR2 的移動才有）。`expired` 給一列已過期的。 */
export async function seedRedirect(db: Db, oldPath: string, noteId: string, opts: { expired?: boolean } = {}): Promise<void> {
  await db.insert(noteRedirects).values({
    oldPath,
    noteId,
    expiresAt: opts.expired ? sql`now() - interval '1 minute'` : sql`now() + interval '1 month'`,
  });
}

export async function seedShare(db: Db, noteId: string, userId: string, role: "viewer" | "editor"): Promise<void> {
  await db.insert(noteShares).values({ noteId, userId, role });
}

/** `explain (costs off)` 一段 drizzle `.toSQL()` 的輸出（參數照原樣綁定）。 */
export async function planOf(pool: Pool, q: { sql: string; params: unknown[] }): Promise<string> {
  const { rows } = await pool.query(`explain (costs off) ${q.sql}`, q.params);
  return rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
}

/** `seedPlannerData` 裡使用者 1 所屬的第一個群組（使用者 1 屬於群組 8、9、10）。 */
export const PLANNER_GROUP_OF_USER1 = "00000000-0000-4000-9000-000000000008";

/**
 * EXPLAIN 用的規模資料（比照 migrate.test.ts 的 #18 慣例：seed 後 analyze，讓 planner 真的做選擇）：
 * 2000 位使用者、500 個群組、每人 3 個群組（約 6000 列成員）、5000 篇筆記（4/5 在群組裡、每群組約 8 篇）、
 * 每篇一列逐人分享。回傳使用者 1 與群組 8 裡的一篇筆記。
 * ⚠ 保留下來的「每篇一列逐人分享」也落在群組筆記上（S5 破裂的形）——只為 EXPLAIN 的規模，**不得**拿這份 seed 做可見性斷言。
 * ⚠ 也只建了 `member` 內建角色，沒有 admin 角色、沒有任何管理員（S1 不成立）——**不得**拿來測 S1。
 */
export async function seedPlannerData(pool: Pool): Promise<{ userId: string; noteId: string }> {
  const U = (n: string): string => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
  const G = (n: string): string => `('00000000-0000-4000-9000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
  await pool.query(
    `insert into users (id, email, display_name, handle)
     select ${U("g")}, 'planner' || g || '@example.com', 'P' || g, 'planner-' || g from generate_series(1, 2000) g`,
  );
  await pool.query(`insert into groups (id, name) select ${G("g")}, 'G' || g from generate_series(1, 500) g`);
  await pool.query(`insert into group_roles (group_id, builtin, can_read, can_create, can_edit) select id, 'member', true, true, true from groups`);
  await pool.query(
    `insert into group_members (group_id, user_id, role_id)
     select x.gid, x.uid, r.id
     from (select ${G("((u * 7 + k) % 500) + 1")} as gid, ${U("u")} as uid from generate_series(1, 2000) u, generate_series(0, 2) k) x
     join group_roles r on r.group_id = x.gid and r.builtin = 'member'
     on conflict do nothing`,
  );
  await pool.query(
    `insert into notes (owner_id, title, slug, group_id)
     select case when g % 5 = 0 then ${U("(g % 2000) + 1")} else null end, 'T' || g, 'planner-' || g,
            case when g % 5 = 0 then null else ${G("(g % 500) + 1")} end
     from generate_series(1, 5000) g`,
  );
  await pool.query(
    `insert into note_shares (note_id, user_id, role)
     select n.id, ${U("((hashtext(n.id::text) & 2147483647) % 2000) + 1")}, 'viewer' from notes n
     on conflict do nothing`,
  );
  for (const t of ["users", "groups", "group_roles", "group_members", "notes", "note_shares"]) await pool.query(`analyze ${t}`);
  const { rows } = await pool.query(`select id from notes where group_id = $1 limit 1`, [PLANNER_GROUP_OF_USER1]);
  return { userId: "00000000-0000-4000-8000-000000000001", noteId: rows[0].id as string };
}

/** 五個成員全是 spy 的 `CollabHooks`（`linkSyncGate` 恆拒，比照既有測試的 stub）。 */
export function spyCollabHooks() {
  return {
    onShareChanged: vi.fn<(noteId: string, userId: string) => void>(),
    onUserRevoked: vi.fn<(userId: string) => void>(),
    onGroupAccessChanged: vi.fn<(noteIds: readonly string[], userIds: readonly string[]) => void>(),
    beforeNoteDeleted: vi.fn(async () => ({ release: () => {} })),
    linkSyncGate: () => ({ ok: false as const }),
  } satisfies CollabHooks;
}

export type MatrixActor = "anon" | "nonMember" | "member" | "admin" | "siteAdmin" | "badId" | "missing";
export const MATRIX_ACTORS: readonly MatrixActor[] = ["anon", "nonMember", "member", "admin", "siteAdmin", "badId", "missing"];

export interface MatrixScene {
  groupId: string;
  admin: SeededUser;
  member: SeededUser;
  other: SeededUser;
  outsider: SeededUser;
  siteAdmin: SeededUser;
  newcomer: SeededUser;
}

export interface MatrixEndpoint {
  method: "GET" | "PUT" | "PATCH" | "DELETE";
  /** `groupId` 已依 actor 換好（`badId`＝非 UUID、`missing`＝不存在的 UUID）。 */
  url: (groupId: string, scene: MatrixScene) => string;
  payload?: (scene: MatrixScene) => Record<string, unknown>;
  expected: Record<MatrixActor, number>;
}

async function seedMatrixScene(db: Db): Promise<MatrixScene> {
  const admin = await seedUser(db);
  const member = await seedUser(db);
  const other = await seedUser(db);
  const outsider = await seedUser(db);
  const siteAdmin = await seedUser(db, { isAdmin: true });
  const newcomer = await seedUser(db);
  const g = await seedGroup(db, "Matrix", [
    { userId: admin.id, role: "admin" },
    { userId: member.id, role: "member" },
    { userId: other.id, role: "member" },
  ]);
  return { groupId: g.id, admin, member, other, outsider, siteAdmin, newcomer };
}

/**
 * spec §11.1 的群組路由授權矩陣：每個 actor 一個全新的場景（破壞性端點互不干擾）。
 * 非成員／非 UUID／不存在三者的 404 回應必須**逐位元組相同**（S4）。
 */
export async function runGroupAuthMatrix(app: FastifyInstance, db: Db, endpoint: MatrixEndpoint): Promise<void> {
  const notFoundBodies: string[] = [];
  for (const actor of MATRIX_ACTORS) {
    const scene = await seedMatrixScene(db);
    const groupId = actor === "badId" ? "not-a-uuid" : actor === "missing" ? randomUUID() : scene.groupId;
    const who =
      actor === "anon" ? null
        : actor === "nonMember" ? scene.outsider
          : actor === "member" ? scene.member
            : actor === "siteAdmin" ? scene.siteAdmin
              : scene.admin;
    const res = await app.inject({
      method: endpoint.method,
      url: endpoint.url(groupId, scene),
      ...(who ? { cookies: await cookieOf(who.id) } : {}),
      ...(endpoint.payload ? { payload: endpoint.payload(scene) } : {}),
    });
    expect(res.statusCode, `${endpoint.method} ${endpoint.url("<id>", scene)} as ${actor}：${res.body}`).toBe(endpoint.expected[actor]);
    if (actor === "nonMember" || actor === "badId" || actor === "missing") notFoundBodies.push(res.body);
  }
  expect(new Set(notFoundBodies).size, "非成員／非 UUID／不存在的 404 必須逐位元組相同").toBe(1);
  expect(JSON.parse(notFoundBodies[0]!)).toEqual({ error: { code: "not_found", message: "找不到此群組" } });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 等到「這個測試 DB 上有連線在等鎖」或「另一個請求已經結束」。並發測試在注入縫裡呼叫它：
 * 回 `"blocked"` ＝ 交錯真的發生（另一條請求卡在我們持有的鎖上）；回 `"settled"` ＝ 另一條請求沒被擋
 * 就跑完了。測試在最後斷言它是 `"blocked"`，證明那一案測到的是交錯而不是序列。
 */
export async function waitForBlockedOrSettled(pool: Pool, other: Promise<unknown>, timeoutMs = 5_000): Promise<"blocked" | "settled"> {
  let settled = false;
  void other.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (settled) return "settled";
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (rows[0]!.n >= 1) return "blocked";
    await sleep(20);
  }
  throw new Error(`waitForBlockedOrSettled 逾時（${timeoutMs}ms）`);
}

/** 筆記的歸屬與公開連結狀態；`updated_at` 取文字形（微秒精度，比 JS Date 準）。 */
export async function noteState(pool: Pool, noteId: string): Promise<{
  owner_id: string | null; group_id: string | null; slug: string; prev_slug: string | null; slug_is_custom: boolean;
  public_token: string | null; public_slug: string | null; updated_at: string;
}> {
  const { rows } = await pool.query(
    `select owner_id, group_id, slug, prev_slug, slug_is_custom, public_token, public_slug, updated_at::text as updated_at from notes where id = $1`,
    [noteId],
  );
  return rows[0];
}

export async function sharesOf(db: Db, noteId: string): Promise<Array<{ userId: string; role: string }>> {
  const rows = await db.select({ userId: noteShares.userId, role: noteShares.role }).from(noteShares).where(eq(noteShares.noteId, noteId));
  return rows.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}
