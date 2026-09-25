/**
 * #103 群組測試共用的種子與量測工具。**只在測試裡直插**——`db.insert(notes)` 在 `test/` 不受
 * `notes-slug.test.ts` 的源碼守衛管轄（那條只掃 `src/`）。
 * 大量種子一律明寫 `slug`／`handle`：吃 `untitled-<uuid8>`／`user-<uuid8>` DEFAULT 有生日問題（#150）。
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { expect, vi } from "vitest";
import { SESSION_COOKIE } from "@knotebook/shared";
import { signSession } from "../src/auth/session.js";
import type { CollabHooks } from "../src/collab/hooks.js";
import type { Db } from "../src/db/index.js";
import { groupMembers, groups, noteShares, notes, users } from "../src/db/schema.js";
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

export async function seedGroup(
  db: Db,
  name: string,
  members: ReadonlyArray<{ userId: string; role: "admin" | "member" }>,
): Promise<{ id: string }> {
  const [g] = await db
    .insert(groups)
    .values({ name, createdBy: members[0]?.userId ?? null })
    .returning({ id: groups.id });
  if (members.length > 0) {
    await db.insert(groupMembers).values(members.map(m => ({ groupId: g!.id, userId: m.userId, role: m.role })));
  }
  return { id: g!.id };
}

export async function seedNote(
  db: Db,
  ownerId: string,
  opts: { title?: string; groupId?: string; groupRole?: "viewer" | "editor"; publicToken?: string; publicSlug?: string } = {},
): Promise<{ id: string; slug: string }> {
  const slug = `n-${randomUUID().slice(0, 12)}`;
  const [n] = await db
    .insert(notes)
    .values({
      ownerId,
      title: opts.title ?? "Untitled",
      slug,
      ...(opts.groupId !== undefined ? { groupId: opts.groupId } : {}),
      ...(opts.groupRole !== undefined ? { groupRole: opts.groupRole } : {}),
      ...(opts.publicToken !== undefined ? { publicToken: opts.publicToken } : {}),
      ...(opts.publicSlug !== undefined ? { publicSlug: opts.publicSlug } : {}),
    })
    .returning({ id: notes.id });
  return { id: n!.id, slug };
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
 * 每篇一列逐人分享。回傳使用者 1 與「群組 8 裡一篇不是使用者 1 的筆記」。
 */
export async function seedPlannerData(pool: Pool): Promise<{ userId: string; noteId: string }> {
  const U = (n: string): string => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
  const G = (n: string): string => `('00000000-0000-4000-9000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
  await pool.query(
    `insert into users (id, email, display_name, handle)
     select ${U("g")}, 'planner' || g || '@example.com', 'P' || g, 'planner-' || g from generate_series(1, 2000) g`,
  );
  await pool.query(`insert into groups (id, name) select ${G("g")}, 'G' || g from generate_series(1, 500) g`);
  await pool.query(
    `insert into group_members (group_id, user_id, role)
     select ${G("((u * 7 + k) % 500) + 1")}, ${U("u")}, 'member'
     from generate_series(1, 2000) u, generate_series(0, 2) k
     on conflict do nothing`,
  );
  await pool.query(
    `insert into notes (owner_id, title, slug, group_id)
     select ${U("(g % 2000) + 1")}, 'T' || g, 'planner-' || g,
            case when g % 5 = 0 then null else ${G("(g % 500) + 1")} end
     from generate_series(1, 5000) g`,
  );
  await pool.query(
    `insert into note_shares (note_id, user_id, role)
     select n.id, ${U("((hashtext(n.id::text) & 2147483647) % 2000) + 1")}, 'viewer' from notes n
     on conflict do nothing`,
  );
  for (const t of ["users", "groups", "group_members", "notes", "note_shares"]) await pool.query(`analyze ${t}`);
  const { rows } = await pool.query(
    `select id from notes where group_id = $1 and owner_id <> $2 limit 1`,
    [PLANNER_GROUP_OF_USER1, "00000000-0000-4000-8000-000000000001"],
  );
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
