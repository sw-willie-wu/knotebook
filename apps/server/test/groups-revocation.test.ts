/**
 * #103 §7 的端到端踢線：全部走真路由（hook 只在路由裡被呼叫）＋真 CollabHooks。
 * 「續留」一律等過重驗 deadline 再斷言（沒回應的重驗在 deadline 到期才會被關）。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_CLOSE_REVOKED, YDOC_FRAGMENT, type NoteDto } from "@knotebook/shared";
import { createCollabHooks, REVERIFY_DEADLINE_MS } from "../src/collab/hooks-impl.js";
import { buildCollabTestApp, type CollabTestCtx, type HttpSession } from "./helpers.js";

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

/** `creator` 建群組、加入 `members`（email）；回 groupId。 */
async function makeGroup(creator: HttpSession, members: string[]): Promise<string> {
  const g = await api(creator, "POST", "/api/groups", { name: "Crew" });
  expect(g.status).toBe(201);
  const id = (g.json as { id: string }).id;
  for (const email of members) expect((await api(creator, "PUT", `/api/groups/${id}/members`, { email })).status).toBe(200);
  return id;
}

async function moveIn(owner: HttpSession, noteId: string, groupId: string, role: "viewer" | "editor"): Promise<void> {
  expect((await api(owner, "PUT", `/api/notes/${noteId}/group`, { groupId, role })).status).toBe(200);
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

describe("#103 踢線（spec §7）", () => {
  it("移人：只靠群組取得存取的人 10 秒內被 close(revoked)；另有逐人分享者（塞 DB）續留", async () => {
    const ctx = await buildApp();
    const owner = await user(ctx, "owner-k1@example.com");
    const onlyGroup = await user(ctx, "m-k1@example.com");
    const alsoShared = await user(ctx, "s-k1@example.com");
    const groupId = await makeGroup(owner.session, ["m-k1@example.com", "s-k1@example.com"]);
    const note = await ctx.createNote(owner.id);
    await moveIn(owner.session, note.id, groupId, "editor");
    await ctx.share(note.id, alsoShared.id, "editor"); // S5 破裂：刻意製造「另有來源」

    const mClient = await onlyGroup.session.connect(note.id);
    const sClient = await alsoShared.session.connect(note.id);
    expect((await api(owner.session, "DELETE", `/api/groups/${groupId}/members/${onlyGroup.id}`)).status).toBe(204);
    await waitFor("只靠群組的人被踢", 10_000, () => revoked(mClient.closes));
    expect((await api(owner.session, "DELETE", `/api/groups/${groupId}/members/${alsoShared.id}`)).status).toBe(204);
    await sleep(REVERIFY_DEADLINE_MS + 1_000);
    expect(sClient.closes).toEqual([]);
  });

  it("RF2：筆記 owner 自行退出群組（A1）→ 自己那篇上的連線不被踢；清單裡那篇恰一列、role=owner、group 有值", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-k2@example.com");
    const owner = await user(ctx, "owner-k2@example.com");
    const groupId = await makeGroup(admin.session, ["owner-k2@example.com"]);
    const note = await ctx.createNote(owner.id);
    await moveIn(owner.session, note.id, groupId, "editor");

    const client = await owner.session.connect(note.id);
    expect((await api(owner.session, "DELETE", `/api/groups/${groupId}/members/${owner.id}`)).status).toBe(204);
    await sleep(REVERIFY_DEADLINE_MS + 1_000);
    expect(client.closes).toEqual([]);
    const list = (await api(owner.session, "GET", "/api/notes")).json as NoteDto[];
    const mine = list.filter(n => n.id === note.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.role).toBe("owner");
    expect(mine[0]!.group?.id).toBe(groupId);
  });

  it("筆記移出群組：成員被踢；owner 不受影響", async () => {
    const ctx = await buildApp();
    const owner = await user(ctx, "owner-k3@example.com");
    const member = await user(ctx, "m-k3@example.com");
    const groupId = await makeGroup(owner.session, ["m-k3@example.com"]);
    const note = await ctx.createNote(owner.id);
    await moveIn(owner.session, note.id, groupId, "editor");

    const ownerClient = await owner.session.connect(note.id);
    const memberClient = await member.session.connect(note.id);
    expect((await api(owner.session, "DELETE", `/api/notes/${note.id}/group`)).status).toBe(200);
    await waitFor("成員被踢", 10_000, () => revoked(memberClient.closes));
    await sleep(REVERIFY_DEADLINE_MS + 1_000);
    expect(ownerClient.closes).toEqual([]);
  });

  it("個人→群組：被清掉的逐人分享對象被踢；同時是新群組成員的人續留", async () => {
    const ctx = await buildApp();
    const owner = await user(ctx, "owner-k4@example.com");
    const outsider = await user(ctx, "c-k4@example.com");
    const insider = await user(ctx, "d-k4@example.com");
    const groupId = await makeGroup(owner.session, ["d-k4@example.com"]);
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, outsider.id, "editor");
    await ctx.share(note.id, insider.id, "editor");

    const cClient = await outsider.session.connect(note.id);
    const dClient = await insider.session.connect(note.id);
    await moveIn(owner.session, note.id, groupId, "editor");
    await waitFor("被清掉分享的人被踢", 10_000, () => revoked(cClient.closes));
    await sleep(REVERIFY_DEADLINE_MS + 1_000);
    expect(dClient.closes).toEqual([]);
  });

  it("group_role editor→viewer：成員續留但變唯讀（寫入不再傳到 owner）", async () => {
    const ctx = await buildApp();
    const owner = await user(ctx, "owner-k5@example.com");
    const member = await user(ctx, "m-k5@example.com");
    const groupId = await makeGroup(owner.session, ["m-k5@example.com"]);
    const note = await ctx.createNote(owner.id);
    await moveIn(owner.session, note.id, groupId, "editor");

    const ownerClient = await owner.session.connect(note.id);
    const memberClient = await member.session.connect(note.id);
    const synced = await armTokenSync(ctx, note.id, member.id);
    await moveIn(owner.session, note.id, groupId, "viewer");
    await waitFor("member 那條連線完成重驗（setReadOnly 之後）", 10_000, synced);
    insertParagraph(memberClient.doc, "after-downgrade");
    await sleep(1_000);
    expect(text(ownerClient.doc)).not.toContain("after-downgrade");
    expect(memberClient.closes).toEqual([]);
  });

  it("group_role viewer→editor：成員續留且解除唯讀（寫入傳到 owner）", async () => {
    const ctx = await buildApp();
    const owner = await user(ctx, "owner-k6@example.com");
    const member = await user(ctx, "m-k6@example.com");
    const groupId = await makeGroup(owner.session, ["m-k6@example.com"]);
    const note = await ctx.createNote(owner.id);
    await moveIn(owner.session, note.id, groupId, "viewer");

    const ownerClient = await owner.session.connect(note.id);
    const memberClient = await member.session.connect(note.id); // 以 viewer 連上：唯讀
    const synced = await armTokenSync(ctx, note.id, member.id);
    await moveIn(owner.session, note.id, groupId, "editor");
    await waitFor("member 那條連線完成重驗（setReadOnly 之後）", 10_000, synced);
    insertParagraph(memberClient.doc, "after-upgrade");
    await waitFor("升級後的寫入傳到 owner", 10_000, () => text(ownerClient.doc).includes("after-upgrade"));
    expect(memberClient.closes).toEqual([]);
  });

  it("加人／成員升級／刪群組：沒有任何連線被關", async () => {
    // 鑑別範圍只有「沒有誤關」：即使實作誤觸發重驗，這些人仍有存取權、`resolveRole` 不會關他們，
    // 所以這案對「多呼叫了 hook」沒有鑑別力。真正守「這三個事件不呼叫 onGroupAccessChanged」的是
    // Task 8（加人、升級）與 Task 10（刪群組）的 spy 斷言（`not.toHaveBeenCalled`）。
    const ctx = await buildApp();
    const owner = await user(ctx, "owner-k7@example.com");
    const member = await user(ctx, "m-k7@example.com");
    await user(ctx, "n-k7@example.com");
    const groupId = await makeGroup(owner.session, ["m-k7@example.com"]);
    const note = await ctx.createNote(owner.id);
    await moveIn(owner.session, note.id, groupId, "editor");

    const ownerClient = await owner.session.connect(note.id);
    const memberClient = await member.session.connect(note.id);
    expect((await api(owner.session, "PUT", `/api/groups/${groupId}/members`, { email: "n-k7@example.com" })).status).toBe(200);
    expect((await api(owner.session, "PATCH", `/api/groups/${groupId}/members/${member.id}`, { role: "admin" })).status).toBe(200);
    expect((await api(owner.session, "DELETE", `/api/groups/${groupId}`)).status).toBe(204);
    await sleep(REVERIFY_DEADLINE_MS + 1_000);
    expect(ownerClient.closes).toEqual([]);
    expect(memberClient.closes).toEqual([]);
  });
});
