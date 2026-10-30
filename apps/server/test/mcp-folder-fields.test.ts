/**
 * 資料夾 PR-3d T2（plan docs/superpowers/plans/2026-10-28-folders-pr3d.md）：筆記結果帶 `folder`（呼叫者視角，AG-F1）。
 * NF＝三種空間、AF1＝被分享者看不到擁有者的資料夾、AF2＝單篇回應、AF3＝名稱截斷、AF4＝名稱查不到、AF5＝鏡像、AF6＝describe 字串；
 * LF1＝T1 骨架的兩支查詢（`loadFolderNames`／`loadFolderPath`）對真 DB。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { TokenScope } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { NS_FOLDER_DESCRIBE, noteSummariesForModel, type NoteSummaryRow } from "../src/mcp/dto.js";
import { loadFolderNames, loadFolderPath } from "../src/mcp/folder-fields.js";
import { escapedLength } from "../src/mcp/limits.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { seedFolder, seedFolderChain, seedPlacement, setNoteFolder } from "./folder-helpers.js";
import { seedGroup, seedNote, seedShare, seedUser } from "./group-helpers.js";
import { buildCollabTestApp } from "./helpers.js";
import { callTool, type McpAuth, type ToolCallResult } from "./mcp-folder-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { inject } from "./trash-helpers.js";

const R: TokenScope = "notes:read";
const RW: TokenScope = "notes:read notes:write";
const RWM: TokenScope = "notes:read notes:write notes:move";
const RWD: TokenScope = "notes:read notes:write notes:delete";

type FolderRef = { id: string; name: string; nameTruncated?: true } | null;
type NoteOut = { id: string; folder: FolderRef } & Record<string, unknown>;

const tokenOf = async (db: Db, userId: string, scope: TokenScope): Promise<McpAuth> => ({ token: (await seedTokenForUser(db, userId, scope)).token });

function ok(r: ToolCallResult): Record<string, unknown> {
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return r.structuredContent!;
}
async function listNotes(app: FastifyInstance, auth: McpAuth): Promise<Map<string, NoteOut>> {
  const out = ok(await callTool(app, auth, "list_notes", {}));
  return new Map((out.notes as NoteOut[]).map(n => [n.id, n]));
}
async function searchNotes(app: FastifyInstance, auth: McpAuth, query: string): Promise<Map<string, NoteOut>> {
  const out = ok(await callTool(app, auth, "search_notes", { query }));
  return new Map((out.notes as NoteOut[]).map(n => [n.id, n]));
}
/** 整個 HTTP 回應本文（JSON-RPC 信封＋structuredContent＋鏡像 text）。 */
async function rawCall(app: FastifyInstance, auth: McpAuth, name: string, args: unknown): Promise<string> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.body;
}
async function noteOf(app: FastifyInstance, auth: McpAuth, name: string, args: unknown): Promise<NoteOut> {
  const out = ok(await callTool(app, auth, name, args));
  expect(Object.keys(out.note as object)).toContain("folder");
  return out.note as NoteOut;
}

describe("NF1 三種空間：list_notes 與 search_notes 的 folder", () => {
  it("個人筆記在個人資料夾、群組筆記在群組資料夾 → { id, name }；根層 → null", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "NF1", [{ userId: u.id, role: "admin" }]);
    const fp = await seedFolder(ctx.db, { personal: u.id }, { name: "Personal F" });
    const fg = await seedFolder(ctx.db, { group: g.id }, { name: "Group F" });
    const np = await seedNote(ctx.db, { ownerId: u.id }, { title: "nfone personal" });
    const ng = await seedNote(ctx.db, { groupId: g.id }, { title: "nfone group" });
    const nr = await seedNote(ctx.db, { ownerId: u.id }, { title: "nfone root" });
    await setNoteFolder(ctx.db.$client, np.id, fp.id);
    await setNoteFolder(ctx.db.$client, ng.id, fg.id);
    const auth = await tokenOf(ctx.db, u.id, R);

    for (const byId of [await listNotes(ctx.app, auth), await searchNotes(ctx.app, auth, "nfone")]) {
      expect(byId.get(np.id)!.folder).toEqual({ id: fp.id, name: "Personal F" });
      expect(byId.get(ng.id)!.folder).toEqual({ id: fg.id, name: "Group F" });
      expect(byId.get(nr.id)!.folder).toBeNull();
    }
  });
});

describe("AF1 被分享者看不到擁有者的資料夾（AG-F1）", () => {
  it("B 的 list_notes／search_notes：folder null、wire 上沒有擁有者的資料夾名與 id；B 放進自己的 shared 資料夾 → 看到自己的；擁有者仍看到自己的", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await seedUser(ctx.db);
    const b = await seedUser(ctx.db);
    const secretName = `SECRET-${randomUUID().slice(0, 8)}`;
    const secret = await seedFolder(ctx.db, { personal: owner.id }, { name: secretName });
    const n = await seedNote(ctx.db, { ownerId: owner.id }, { title: "afone shared" });
    await setNoteFolder(ctx.db.$client, n.id, secret.id);
    await seedShare(ctx.db, n.id, b.id, "viewer");
    const bAuth = await tokenOf(ctx.db, b.id, R);
    const ownerAuth = await tokenOf(ctx.db, owner.id, R);

    expect((await listNotes(ctx.app, bAuth)).get(n.id)!.folder).toBeNull();
    expect((await searchNotes(ctx.app, bAuth, "afone")).get(n.id)!.folder).toBeNull();
    for (const wire of [await rawCall(ctx.app, bAuth, "list_notes", {}), await rawCall(ctx.app, bAuth, "search_notes", { query: "afone" })]) {
      expect(wire).toContain(n.id); // 前提：這篇真的在回應裡
      expect(wire).not.toContain("SECRET-");
      expect(wire).not.toContain(secret.id);
    }

    const mine = await seedFolder(ctx.db, { shared: b.id }, { name: "Mine" });
    await seedPlacement(ctx.db.$client, b.id, n.id, mine.id);
    expect((await listNotes(ctx.app, bAuth)).get(n.id)!.folder).toEqual({ id: mine.id, name: "Mine" });
    expect((await searchNotes(ctx.app, bAuth, "afone")).get(n.id)!.folder).toEqual({ id: mine.id, name: "Mine" });
    expect((await listNotes(ctx.app, ownerAuth)).get(n.id)!.folder).toEqual({ id: secret.id, name: secretName });
  });

  it("另一位被分享者 C 的放置不會漏給 B：B 沒放置 → folder null、wire 上沒有 C 的資料夾名與 id；C 看到自己的", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await seedUser(ctx.db);
    const b = await seedUser(ctx.db);
    const c = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: owner.id }, { title: "afthree shared" });
    await seedShare(ctx.db, n.id, b.id, "viewer");
    await seedShare(ctx.db, n.id, c.id, "viewer");
    const cName = `CFOLDER-${randomUUID().slice(0, 8)}`;
    const cFolder = await seedFolder(ctx.db, { shared: c.id }, { name: cName });
    await seedPlacement(ctx.db.$client, c.id, n.id, cFolder.id);
    const bAuth = await tokenOf(ctx.db, b.id, R);

    expect((await listNotes(ctx.app, bAuth)).get(n.id)!.folder).toBeNull();
    expect((await searchNotes(ctx.app, bAuth, "afthree")).get(n.id)!.folder).toBeNull();
    for (const wire of [await rawCall(ctx.app, bAuth, "list_notes", {}), await rawCall(ctx.app, bAuth, "search_notes", { query: "afthree" })]) {
      expect(wire).toContain(n.id); // 前提：這篇真的在回應裡
      expect(wire).not.toContain("CFOLDER-");
      expect(wire).not.toContain(cFolder.id);
    }
    expect((await listNotes(ctx.app, await tokenOf(ctx.db, c.id, R))).get(n.id)!.folder).toEqual({ id: cFolder.id, name: cName });
  });
});

describe("AF2 單篇回應都帶 folder", () => {
  it("create_note（不帶 folder_id → null）、copy_note（個人，根層 → null）、move_note_to_group（→ 群組根層 null）、restore_note（回原資料夾）", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "AF2", [{ userId: u.id, role: "admin" }]);
    const f = await seedFolder(ctx.db, { personal: u.id }, { name: "Kept" });

    const created = await noteOf(ctx.app, await tokenOf(ctx.db, u.id, RW), "create_note", { title: "af2 created" });
    expect(created.folder).toBeNull();

    const src = await seedNote(ctx.db, { ownerId: u.id }, { title: "af2 source" });
    await setNoteFolder(ctx.db.$client, src.id, f.id);
    const copy = await noteOf(ctx.app, await tokenOf(ctx.db, u.id, RW), "copy_note", { note_id: src.id });
    expect(copy.id).not.toBe(src.id);
    expect(copy.folder).toBeNull();

    const mover = await seedNote(ctx.db, { ownerId: u.id }, { title: "af2 mover" });
    await setNoteFolder(ctx.db.$client, mover.id, f.id);
    const moved = await noteOf(ctx.app, await tokenOf(ctx.db, u.id, RWM), "move_note_to_group", { note_id: mover.id, group_id: g.id });
    expect(moved.folder).toBeNull();

    const res = await inject(ctx.app, "DELETE", `/api/notes/${src.id}`, u.id);
    expect(res.statusCode, res.body).toBe(204);
    const restored = await noteOf(ctx.app, await tokenOf(ctx.db, u.id, RWD), "restore_note", { note_id: src.id });
    expect(restored.id).toBe(src.id);
    expect(restored.folder).toEqual({ id: f.id, name: "Kept" });
  });
});

describe("AF3 名稱截斷", () => {
  it("80 個 \" → name 40 個＋nameTruncated、逃脫後 ≤ 80；80 個中文不截、沒有旗標鍵", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const quotes = await seedFolder(ctx.db, { personal: u.id }, { name: '"'.repeat(80) });
    const cjk = await seedFolder(ctx.db, { personal: u.id }, { name: "資".repeat(80) });
    const a = await seedNote(ctx.db, { ownerId: u.id }, { title: "af3 quotes" });
    const c = await seedNote(ctx.db, { ownerId: u.id }, { title: "af3 cjk" });
    await setNoteFolder(ctx.db.$client, a.id, quotes.id);
    await setNoteFolder(ctx.db.$client, c.id, cjk.id);

    const byId = await listNotes(ctx.app, await tokenOf(ctx.db, u.id, R));
    const qa = byId.get(a.id)!.folder!;
    expect(qa).toEqual({ id: quotes.id, name: '"'.repeat(40), nameTruncated: true });
    expect(escapedLength(qa.name)).toBeLessThanOrEqual(80);
    expect(byId.get(c.id)!.folder).toEqual({ id: cjk.id, name: "資".repeat(80) });
    expect(Object.keys(byId.get(c.id)!.folder!)).toEqual(["id", "name"]);
  });
});

describe("AF4 名稱查不到（兩句之間資料夾被刪）", () => {
  it("noteSummariesForModel：viewerFolderId 指向不存在的 uuid → folder null、不 throw；同批查得到的照常帶名稱", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const f = await seedFolder(ctx.db, { personal: u.id }, { name: "Real" });
    const base: NoteSummaryRow & { role: string } = {
      id: randomUUID(), title: "t", ownerHandle: u.handle, groupId: null, groupName: null, slug: "s", updatedAt: new Date(0),
      lastEditedAt: null, lastEditedAgentLabel: null, editorHandle: null, viewerFolderId: randomUUID(), role: "owner",
    };
    const [gone, real, root] = await noteSummariesForModel(ctx.db, [base, { ...base, viewerFolderId: f.id }, { ...base, viewerFolderId: null }]);
    expect(gone!.folder).toBeNull();
    expect(real!.folder).toEqual({ id: f.id, name: "Real" });
    expect(root!.folder).toBeNull();
  });
});

describe("AF5 鏡像", () => {
  it("list_notes：content[0].text 逐字＝JSON.stringify(structuredContent)，且含 folder", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const f = await seedFolder(ctx.db, { personal: u.id }, { name: "Mirror" });
    const n = await seedNote(ctx.db, { ownerId: u.id }, { title: "af5" });
    await setNoteFolder(ctx.db.$client, n.id, f.id);
    const r = await callTool(ctx.app, await tokenOf(ctx.db, u.id, R), "list_notes", {});
    expect(r.content[0]!.text).toBe(JSON.stringify(r.structuredContent));
    expect(r.content[0]!.text).toContain(`"folder":{"id":"${f.id}","name":"Mirror"}`);
  });
});

describe("AF6 describe 字串（NS-F）", () => {
  it("tools/list 上 list_notes 的 notes.items.folder 說明逐字＝NS-F，且不提 read_note_outline", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const res = await mcpPost(ctx.app, rpc("tools/list"), await tokenOf(ctx.db, u.id, R));
    expect(res.statusCode).toBe(200);
    type Tool = { name: string; outputSchema: { properties: { notes: { items: { properties: { folder: { description?: string } } } } } } };
    const tool = (res.json().result.tools as Tool[]).find(t => t.name === "list_notes")!;
    const description = tool.outputSchema.properties.notes.items.properties.folder.description;
    expect(description).toBe(
      "Where this note is filed for you, or null at the top level; for a note shared with you, where you filed it, not where its owner did. Only the folder itself — list_folders gives its path.",
    );
    expect(description).toBe(NS_FOLDER_DESCRIBE);
    expect(description).not.toContain("read_note_outline");
  });
});

describe("LF1 loadFolderNames／loadFolderPath（T1 骨架的查詢）對真 DB", () => {
  it("名稱：空集合／全 null 不查、去重、查無的 id 不在 Map；路徑：根 → 葉、單層、查無 → null", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const [a, b, c] = await seedFolderChain(ctx.db, { personal: u.id }, ["A", "B 資料", 'C"q']);
    expect((await loadFolderNames(ctx.db, [])).size).toBe(0);
    expect((await loadFolderNames(ctx.db, [null, null])).size).toBe(0);
    const names = await loadFolderNames(ctx.db, [a!, null, c!, a!, randomUUID()]);
    expect([...names.entries()].sort()).toEqual([[a!, "A"], [c!, 'C"q']].sort());
    expect(await loadFolderPath(ctx.db, c!)).toEqual(["A", "B 資料", 'C"q']);
    expect(await loadFolderPath(ctx.db, b!)).toEqual(["A", "B 資料"]);
    expect(await loadFolderPath(ctx.db, a!)).toEqual(["A"]);
    expect(await loadFolderPath(ctx.db, randomUUID())).toBeNull();
  });
});
