/**
 * #175 PR3 §7 的端到端踢線（角色變更）：全部走真路由（`onGroupAccessChanged` 只在路由裡被呼叫）＋真 CollabHooks。
 * 自訂角色一律以 `POST /api/groups/:id/roles` 建（閱讀恆真，不經 `seedRole` 的 `canRead: false` 預設——PR3 plan 複驗第 14 條）。
 * 連線、寫入、等待的形照抄 `groups-v2-revocation.test.ts`（PR1；該檔不改）。
 *
 * 等待與負向斷言的判定責任（每案在案內再寫一次）：
 * - 「重驗發生了」一律用 `armTokenSync` 的確定性等待（回呼在 server `onTokenSync` 的 `finally`、`setReadOnly` 之後）——
 *   踢線沒被觸發時這個 `waitFor` 會逾時 → **紅**，不會假綠。
 * - 「寫入沒傳過去」與「沒有重驗」是負向斷言，只能靠固定 sleep。案 3 的 sleep 是 `REVERIFY_DEADLINE_MS + 1_000`（6 秒）：
 *   被誤觸發且 client 沒回應的重驗要到 deadline（5 秒）才會關連線，窗口必須蓋過它才看得到。案 1／4 不靠窗口長度：
 *   server 端 `Connection.readOnly` 有確定性斷言（`serverConn`），sleep 只留 `collab-auth.test.ts` 慣例的 500 ms 當保險。
 * - 本檔沒有任何斷言依賴 collab server 的落盤 debounce（`STORE_DEBOUNCE_MS`）：傳播是即時廣播；案 4 的「內容在 server 端」以
 *   A 新連上時從 server 拿到的 doc 判定（帶 content 建立在回 201 之前已把內容寫進 server 端的 doc；
 *   不主張經過儲存層——A 連上前文件可能仍在記憶體）。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_CLOSE_REVOKED, YDOC_FRAGMENT, type GroupMemberDto, type GroupRoleDto, type GroupRoleFlags } from "@knotebook/shared";
import { createCollabHooks, REVERIFY_DEADLINE_MS } from "../src/collab/hooks-impl.js";
import { buildCollabTestApp, type CollabTestCtx, type HttpSession } from "./helpers.js";

const PASSWORD = "correct-horse-battery";
/** 六個可設旗標全關＝只能閱讀（閱讀恆真）。 */
const NONE: GroupRoleFlags = { create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false };
/** 案 3 的負向等待：等過重驗 deadline（沒回應的重驗在 deadline 到期才會被關）再多 1 秒。 */
const NEGATIVE_WAIT_MS = REVERIFY_DEADLINE_MS + 1_000;
/** 案 1／4 的負向等待：有 `serverConn(...).readOnly` 的確定性斷言，只需蓋過傳播耗時（比照 collab-auth.test.ts:66）。 */
const SHORT_NEGATIVE_WAIT_MS = 500;

function buildApp(): Promise<CollabTestCtx> {
  return buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log) });
}

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

function insertParagraph(doc: Y.Doc, text: string): void {
  const element = new Y.XmlElement("paragraph");
  element.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);
}

const text = (doc: Y.Doc): string => doc.getXmlFragment(YDOC_FRAGMENT).toString();
const revoked = (closes: Array<{ reason: string }>): boolean => closes.some(c => c.reason === COLLAB_CLOSE_REVOKED);

async function api(session: HttpSession, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await session.fetch(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const raw = await res.text();
  return { status: res.status, json: raw ? JSON.parse(raw) : null };
}

async function user(ctx: CollabTestCtx, email: string): Promise<{ id: string; session: HttpSession }> {
  const u = await ctx.createUser({ email, password: PASSWORD });
  return { id: u.id, session: await ctx.loginAs(email, PASSWORD) };
}

/** `creator` 建群組、加入 `members`（email，預設內建一般成員）；回 groupId。 */
async function makeGroup(creator: HttpSession, members: string[], name = "Crew"): Promise<string> {
  const g = await api(creator, "POST", "/api/groups", { name });
  expect(g.status).toBe(201);
  const id = (g.json as { id: string }).id;
  for (const email of members) expect((await api(creator, "PUT", `/api/groups/${id}/members`, { email })).status).toBe(200);
  return id;
}

/** 成員在群組裡建一篇群組筆記，回 id。 */
async function createGroupNote(session: HttpSession, groupId: string, title: string): Promise<string> {
  const res = await api(session, "POST", "/api/notes", { groupId, title });
  expect(res.status).toBe(201);
  return (res.json as { id: string }).id;
}

/** 以 `POST …/roles` 建自訂角色（server 寫 `can_read = true`），回 id。 */
async function createRole(admin: HttpSession, groupId: string, name: string, permissions: GroupRoleFlags): Promise<string> {
  const res = await api(admin, "POST", `/api/groups/${groupId}/roles`, { name, permissions });
  expect(res.status).toBe(201);
  return (res.json as GroupRoleDto).id;
}

async function assignRole(admin: HttpSession, groupId: string, userId: string, roleId: string): Promise<void> {
  expect((await api(admin, "PATCH", `/api/groups/${groupId}/members/${userId}`, { roleId })).status).toBe(200);
}

/**
 * 在觸發重驗**之前**登記：`userId` 在這篇上那條連線的下一次 `onTokenSync` 完成時回 true。
 * `CollabServer.onNextTokenSync` 的回呼在 `onTokenSync` 的 `finally` 裡派送，位置在
 * `handle.setReadOnly(...)` 之後（`collab/server.ts` 的 `onTokenSync`）——確定性等待，取代固定 sleep。
 */
async function armTokenSync(ctx: CollabTestCtx, noteId: string, userId: string): Promise<() => boolean> {
  await waitFor("連線已登記進索引", 5_000, () => [...ctx.collab.connectionsOfNote(noteId)].some(c => c.userId === userId));
  const handle = [...ctx.collab.connectionsOfNote(noteId)].find(c => c.userId === userId)!;
  let synced = false;
  ctx.collab.onNextTokenSync(handle, () => {
    synced = true;
  });
  return () => synced;
}

/** server 端 Hocuspocus 那條連線（依 socketId）；`readOnly` 是 server 實際套用的旗標。 */
function serverConn(ctx: CollabTestCtx, noteId: string, userId: string) {
  const handle = [...ctx.collab.connectionsOfNote(noteId)].find(c => c.userId === userId)!;
  const conn = ctx.collab.hocuspocus.documents.get(noteId)?.getConnections().find(c => c.socketId === handle.socketId);
  if (!conn) throw new Error("找不到 server 端連線");
  return conn;
}

describe("#175 PR3 角色變更的踢線（spec §7，真連線）", () => {
  it("改角色旗標 edit:false：持有者續留但變唯讀（寫入不再傳到管理員那邊）", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-r1@example.com");
    const member = await user(ctx, "m-r1@example.com");
    const groupId = await makeGroup(admin.session, ["m-r1@example.com"]);
    const writers = await createRole(admin.session, groupId, "Writers", { ...NONE, edit: true });
    await assignRole(admin.session, groupId, member.id, writers);
    const noteId = await createGroupNote(admin.session, groupId, "crew note");

    const adminClient = await admin.session.connect(noteId);
    const memberClient = await member.session.connect(noteId);
    // 正向對照：改角色之前 member 的寫入傳得過去（同一對連線上傳播的實際耗時，負向斷言的 sleep 以此為參照）
    insertParagraph(memberClient.doc, "before-downgrade");
    await waitFor("改角色前的寫入傳到管理員那邊", 10_000, () => text(adminClient.doc).includes("before-downgrade"));

    const synced = await armTokenSync(ctx, noteId, member.id);
    expect(serverConn(ctx, noteId, member.id).readOnly).toBe(false);
    expect((await api(admin.session, "PATCH", `/api/groups/${groupId}/roles/${writers}`, { permissions: NONE })).status).toBe(200);
    // 主判定：PATCH 路由沒呼叫 onGroupAccessChanged 時不會有重驗，這裡逾時 → 紅
    await waitFor("member 那條連線完成重驗（setReadOnly 之後）", 10_000, synced);
    // 確定性斷言：server 端這條連線已被設成唯讀（不靠 sleep）
    expect(serverConn(ctx, noteId, member.id).readOnly).toBe(true);
    insertParagraph(memberClient.doc, "after-downgrade");
    // 負向斷言的保險 sleep（見檔頭）：唯讀沒生效時，這筆寫入會像上面的正向對照一樣在 waitFor 的輪詢間隔內就到
    await sleep(SHORT_NEGATIVE_WAIT_MS);
    expect(text(adminClient.doc)).not.toContain("after-downgrade");
    expect(memberClient.closes).toEqual([]);
    expect(revoked(memberClient.closes)).toBe(false);
  });

  it("刪自訂角色 Readers（只讀）：持有者改掛內建一般成員、續留且解除唯讀（寫入傳到管理員那邊）", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-r2@example.com");
    const member = await user(ctx, "m-r2@example.com");
    const groupId = await makeGroup(admin.session, ["m-r2@example.com"]);
    const readers = await createRole(admin.session, groupId, "Readers", NONE);
    await assignRole(admin.session, groupId, member.id, readers);
    const noteId = await createGroupNote(admin.session, groupId, "crew note");

    const adminClient = await admin.session.connect(noteId);
    const memberClient = await member.session.connect(noteId); // 以只讀角色連上：唯讀
    const synced = await armTokenSync(ctx, noteId, member.id);
    // 確定性斷言：刪角色之前 server 端這條連線是唯讀（不用「先寫一筆」當對照——被丟掉的 update 會讓之後的寫入在管理員端缺依賴）
    expect(serverConn(ctx, noteId, member.id).readOnly).toBe(true);
    expect((await api(admin.session, "DELETE", `/api/groups/${groupId}/roles/${readers}`)).status).toBe(204);
    // 主判定：DELETE 路由沒呼叫 onGroupAccessChanged 時連線不會重驗、維持唯讀，這裡逾時 → 紅
    await waitFor("member 那條連線完成重驗（setReadOnly 之後）", 10_000, synced);
    expect(serverConn(ctx, noteId, member.id).readOnly).toBe(false);
    insertParagraph(memberClient.doc, "after-role-delete");
    await waitFor("解除唯讀後的寫入傳到管理員那邊", 10_000, () => text(adminClient.doc).includes("after-role-delete"));
    expect(memberClient.closes).toEqual([]);
    const members = await api(admin.session, "GET", `/api/groups/${groupId}/members`);
    expect((members.json as GroupMemberDto[]).find(m => m.userId === member.id)?.builtin).toBe("member");
  });

  it("只改 delete 旗標（read／edit 不變）：沒有重驗，連線續留、仍可寫", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-r3@example.com");
    const member = await user(ctx, "m-r3@example.com");
    const groupId = await makeGroup(admin.session, ["m-r3@example.com"]);
    const writers = await createRole(admin.session, groupId, "Writers", { ...NONE, edit: true });
    await assignRole(admin.session, groupId, member.id, writers);
    const noteId = await createGroupNote(admin.session, groupId, "crew note");

    const adminClient = await admin.session.connect(noteId);
    const memberClient = await member.session.connect(noteId);
    const synced = await armTokenSync(ctx, noteId, member.id);
    const res = await api(admin.session, "PATCH", `/api/groups/${groupId}/roles/${writers}`, { permissions: { ...NONE, edit: true, delete: true } });
    expect(res.status).toBe(200);
    expect((res.json as GroupRoleDto).permissions.delete).toBe(true);
    // 「沒有重驗」是負向斷言、只能靠 sleep（見檔頭）：被誤觸發的重驗是一來一回的 token 交換，遠短於 6 秒
    await sleep(NEGATIVE_WAIT_MS);
    expect(synced()).toBe(false);
    expect(memberClient.closes).toEqual([]);
    insertParagraph(memberClient.doc, "still-writable");
    await waitFor("仍可寫：寫入傳到管理員那邊", 10_000, () => text(adminClient.doc).includes("still-writable"));
  });

  it("create-only 角色帶 content 建立群組筆記（Willie 2026-10-01 裁決：允許，投稿者形）：201 viewer、內容在，之後的寫入傳不過去", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-r4@example.com");
    const member = await user(ctx, "m-r4@example.com");
    const groupId = await makeGroup(admin.session, ["m-r4@example.com"]);
    const contributors = await createRole(admin.session, groupId, "Contributors", { ...NONE, create: true });
    await assignRole(admin.session, groupId, member.id, contributors);

    // cookie session 走 `authenticateAny("notes:write")`；buildCollabTestApp 有協作元件，部署閘門放行 content
    const created = await api(member.session, "POST", "/api/notes", { groupId, title: "Pitch", content: "contributed-text" });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ role: "viewer", groupId, ownerId: null, permissions: { read: true, edit: false } });
    const noteId = (created.json as { id: string }).id;
    const token = await api(member.session, "POST", `/api/notes/${noteId}/collab-token`);
    expect((token.json as { role: string }).role).toBe("viewer");

    // 內容在 server 端：A 新連上、首次 sync 完成就看得到
    const adminClient = await admin.session.connect(noteId);
    expect(text(adminClient.doc)).toContain("contributed-text");
    // 正向對照：A（內建管理員，可編輯）的寫入傳得到 member 那邊——同一對連線上傳播的實際耗時
    const memberClient = await member.session.connect(noteId);
    insertParagraph(adminClient.doc, "admin-edit");
    await waitFor("管理員的寫入傳到 member 那邊", 10_000, () => text(memberClient.doc).includes("admin-edit"));

    insertParagraph(memberClient.doc, "after-create");
    // 確定性斷言：member 一連上 server 端就是唯讀（collab-token 的 role 是 viewer，上面已斷言）；sleep 只是保險（見檔頭）
    expect(serverConn(ctx, noteId, member.id).readOnly).toBe(true);
    await sleep(SHORT_NEGATIVE_WAIT_MS);
    expect(text(adminClient.doc)).not.toContain("after-create");
    expect(memberClient.closes).toEqual([]);
  });
});
