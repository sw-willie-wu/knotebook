/**
 * #175 §7 的端到端踢線（群組筆記）：全部走真路由（hook 只在路由裡被呼叫）＋真 CollabHooks。
 * 群組筆記由成員以 `POST /api/notes {groupId}` 建立（群組持有，沒有 owner、沒有逐人分享）。
 * 「續留」一律等過重驗 deadline 再斷言（沒回應的重驗在 deadline 到期才會被關）。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_CLOSE_REVOKED, YDOC_FRAGMENT, type GroupRoleDto } from "@knotebook/shared";
import { createCollabHooks, REVERIFY_DEADLINE_MS } from "../src/collab/hooks-impl.js";
import { buildCollabTestApp, type CollabTestCtx, type HttpSession } from "./helpers.js";
import { seedRole } from "./group-helpers.js";

const PASSWORD = "correct-horse-battery";

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

/** 群組的內建一般成員角色 id（走 `GET …/roles`）。 */
async function memberRoleId(session: HttpSession, groupId: string): Promise<string> {
  const res = await api(session, "GET", `/api/groups/${groupId}/roles`);
  expect(res.status).toBe(200);
  return (res.json as GroupRoleDto[]).find(r => r.builtin === "member")!.id;
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

describe("#175 踢線（spec §7，群組筆記）", () => {
  it("移人：只靠群組取得存取的人 10 秒內被 close(revoked)；管理員那條續留", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-v1@example.com");
    const member = await user(ctx, "m-v1@example.com");
    const groupId = await makeGroup(admin.session, ["m-v1@example.com"]);
    const noteId = await createGroupNote(member.session, groupId, "crew note");

    const adminClient = await admin.session.connect(noteId);
    const memberClient = await member.session.connect(noteId);
    expect((await api(admin.session, "DELETE", `/api/groups/${groupId}/members/${member.id}`)).status).toBe(204);
    await waitFor("被移出的人被踢", 10_000, () => revoked(memberClient.closes));
    await sleep(REVERIFY_DEADLINE_MS + 1_000);
    expect(adminClient.closes).toEqual([]);
  });

  it("換成只讀自訂角色：成員續留但變唯讀（寫入不再傳到管理員那邊）", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-v2@example.com");
    const member = await user(ctx, "m-v2@example.com");
    const groupId = await makeGroup(admin.session, ["m-v2@example.com"]);
    const noteId = await createGroupNote(member.session, groupId, "crew note");
    const reader = await seedRole(ctx.db, groupId, "Reader", { canRead: true });

    const adminClient = await admin.session.connect(noteId);
    const memberClient = await member.session.connect(noteId);
    const synced = await armTokenSync(ctx, noteId, member.id);
    expect((await api(admin.session, "PATCH", `/api/groups/${groupId}/members/${member.id}`, { roleId: reader })).status).toBe(200);
    await waitFor("member 那條連線完成重驗（setReadOnly 之後）", 10_000, synced);
    insertParagraph(memberClient.doc, "after-downgrade");
    await sleep(1_000);
    expect(text(adminClient.doc)).not.toContain("after-downgrade");
    expect(memberClient.closes).toEqual([]);
  });

  it("從只讀自訂角色換回內建一般成員：成員續留且解除唯讀（寫入傳到管理員那邊）", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-v3@example.com");
    const member = await user(ctx, "m-v3@example.com");
    const groupId = await makeGroup(admin.session, ["m-v3@example.com"]);
    const noteId = await createGroupNote(member.session, groupId, "crew note");
    const reader = await seedRole(ctx.db, groupId, "Reader", { canRead: true });
    expect((await api(admin.session, "PATCH", `/api/groups/${groupId}/members/${member.id}`, { roleId: reader })).status).toBe(200);

    const adminClient = await admin.session.connect(noteId);
    const memberClient = await member.session.connect(noteId); // 以只讀角色連上：唯讀
    const synced = await armTokenSync(ctx, noteId, member.id);
    const back = await memberRoleId(admin.session, groupId);
    expect((await api(admin.session, "PATCH", `/api/groups/${groupId}/members/${member.id}`, { roleId: back })).status).toBe(200);
    await waitFor("member 那條連線完成重驗（setReadOnly 之後）", 10_000, synced);
    insertParagraph(memberClient.doc, "after-upgrade");
    await waitFor("升級後的寫入傳到管理員那邊", 10_000, () => text(adminClient.doc).includes("after-upgrade"));
    expect(memberClient.closes).toEqual([]);
  });

  it("加人／改名／刪空群組：沒有任何連線被關", async () => {
    // 鑑別範圍只有「沒有誤關」：即使實作誤觸發重驗，這些人仍有存取權、重驗不會關他們，所以這案對「多呼叫了
    // hook」沒有鑑別力。守「這三個事件不呼叫 onGroupAccessChanged」的是 groups-members（加人）與
    // groups-v2-delete（刪群組）的 spy 斷言。
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-v4@example.com");
    const member = await user(ctx, "m-v4@example.com");
    await user(ctx, "n-v4@example.com");
    const groupId = await makeGroup(admin.session, ["m-v4@example.com"]);
    const emptyGroupId = await makeGroup(admin.session, ["m-v4@example.com"], "Empty");
    const noteId = await createGroupNote(member.session, groupId, "crew note");

    const adminClient = await admin.session.connect(noteId);
    const memberClient = await member.session.connect(noteId);
    expect((await api(admin.session, "PUT", `/api/groups/${groupId}/members`, { email: "n-v4@example.com" })).status).toBe(200);
    expect((await api(admin.session, "PATCH", `/api/groups/${groupId}`, { name: "Renamed" })).status).toBe(200);
    expect((await api(admin.session, "DELETE", `/api/groups/${emptyGroupId}`)).status).toBe(204);
    await sleep(REVERIFY_DEADLINE_MS + 1_000);
    expect(adminClient.closes).toEqual([]);
    expect(memberClient.closes).toEqual([]);
  });
});
