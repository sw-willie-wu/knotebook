/**
 * 資料夾寫入的節流桶（`FOLDER_LIMIT`，http/rate-limit.ts）：`folders/service.ts` 四支（REST 與 MCP 共用）扣自己的 `folder` 桶，
 * 不扣內容寫入的 `edit` 桶（`EDIT_LIMIT` 30/min）。回歸對象：側欄選取模式一次移動 31 篇以上，第 31 篇起 429，
 * 而且把同一分鐘 AI 編輯的額度一起吃光。
 *
 * 承重的寫法：把 `app.ts` 的 `foldersRoutes`／`mcpRoutes` 接線改回 `edit` 實例（共桶）→ FRL-1、FRL-2、FRL-4 紅；
 * 服務層四支任一支不扣 `folder` 桶 → FRL-3 紅。
 */
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { TokenScope } from "@knotebook/shared";
import { EDIT_LIMIT, FixedWindowLimiter, FOLDER_LIMIT } from "../src/http/rate-limit.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { noteFolderCols, seedFolder } from "./folder-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { callTool } from "./mcp-folder-helpers.js";
import { inject } from "./trash-helpers.js";

const RW: TokenScope = "notes:read notes:write";

/** 剩幾次（耗盡它；上限 1000 防無窮迴圈）。 */
function remaining(l: FixedWindowLimiter, key: string): number {
  let n = 0;
  while (n <= 1000 && l.consume(key)) n += 1;
  return n;
}

function status(res: LightMyRequestResponse, expected: number): void {
  expect(res.statusCode, res.body).toBe(expected);
}

const place = (app: FastifyInstance, userId: string, noteId: string, folderId: string | null) =>
  inject(app, "PUT", `/api/notes/${noteId}/folder`, userId, { folderId });

describe("FRL 資料夾桶與 edit 桶分開", () => {
  it("FRL-1 生產預設值：連續 40 篇放進資料夾＋5 個資料夾搬家（共 45 次）全 200；edit 桶一次都沒扣", async () => {
    expect(EDIT_LIMIT.limit).toBeLessThan(45);
    expect(FOLDER_LIMIT.limit).toBeGreaterThanOrEqual(45);
    const edit = new FixedWindowLimiter(EDIT_LIMIT);
    const folder = new FixedWindowLimiter(FOLDER_LIMIT);
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ edit, folder }) });
    const u = await seedUser(db);
    const target = (await seedFolder(db, { personal: u.id }, { name: "target" })).id;
    const notes: string[] = [];
    for (let i = 0; i < 40; i += 1) notes.push((await seedNote(db, { ownerId: u.id })).id);
    const subs: string[] = [];
    for (let i = 0; i < 5; i += 1) subs.push((await seedFolder(db, { personal: u.id }, { name: `sub-${i}` })).id);

    for (const id of notes) status(await place(app, u.id, id, target), 200);
    for (const id of subs) status(await inject(app, "PATCH", `/api/folders/${id}`, u.id, { parentId: target }), 200);

    for (const id of notes) expect((await noteFolderCols(db.$client, id))?.folder_id).toBe(target);
    expect(remaining(edit, u.id)).toBe(EDIT_LIMIT.limit);
    expect(remaining(folder, u.id)).toBe(FOLDER_LIMIT.limit - 45);
  });

  it("FRL-2 edit 桶已耗盡（0）：建立、改名、搬家、放置、刪除資料夾照常成功", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ edit: new FixedWindowLimiter({ limit: 0, windowMs: 60_000 }) }) });
    const u = await seedUser(db);
    const n = (await seedNote(db, { ownerId: u.id })).id;

    const created = await inject(app, "POST", "/api/folders", u.id, { name: "A", space: { kind: "personal" } });
    status(created, 201);
    const a = (created.json() as { id: string }).id;
    const b = (await seedFolder(db, { personal: u.id }, { name: "B" })).id;
    status(await inject(app, "PATCH", `/api/folders/${a}`, u.id, { name: "A2" }), 200);
    status(await inject(app, "PATCH", `/api/folders/${b}`, u.id, { parentId: a }), 200);
    status(await place(app, u.id, n, b), 200);
    status(await place(app, u.id, n, null), 200);
    status(await inject(app, "DELETE", `/api/folders/${a}`, u.id), 200);
    const { rows } = await db.$client.query<{ n: number }>("select count(*)::int as n from folders");
    expect(rows[0]!.n).toBe(0);
  });

  it("FRL-3 folder 桶上限 4：四支各一次後第五次 429 too_many_requests、不寫；edit 桶沒被扣", async () => {
    const edit = new FixedWindowLimiter(EDIT_LIMIT);
    const folder = new FixedWindowLimiter({ limit: 4, windowMs: 60_000 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ edit, folder }) });
    const u = await seedUser(db);
    const n = (await seedNote(db, { ownerId: u.id })).id;
    const keep = (await seedFolder(db, { personal: u.id }, { name: "keep" })).id;
    const gone = (await seedFolder(db, { personal: u.id }, { name: "gone" })).id;

    status(await inject(app, "POST", "/api/folders", u.id, { name: "C", space: { kind: "personal" } }), 201);
    status(await inject(app, "PATCH", `/api/folders/${keep}`, u.id, { name: "keep2" }), 200);
    status(await place(app, u.id, n, keep), 200);
    status(await inject(app, "DELETE", `/api/folders/${gone}`, u.id), 200);

    const limited = await place(app, u.id, n, null);
    status(limited, 429);
    expect(limited.json()).toEqual({ error: { code: "too_many_requests", message: "Too many writes. Wait a moment and try again." } });
    expect((await noteFolderCols(db.$client, n))?.folder_id).toBe(keep);
    status(await inject(app, "POST", "/api/folders", u.id, { name: "D", space: { kind: "personal" } }), 429);
    status(await inject(app, "PATCH", `/api/folders/${keep}`, u.id, { name: "keep3" }), 429);
    status(await inject(app, "DELETE", `/api/folders/${keep}`, u.id), 429);
    const { rows } = await db.$client.query<{ name: string }>("select name from folders order by name");
    expect(rows.map(r => r.name)).toEqual(["C", "keep2"]);
    expect(remaining(edit, u.id)).toBe(EDIT_LIMIT.limit);
  });

  it("FRL-4 MCP 資料夾工具扣同一顆 folder 桶：edit 0 時 move_note_to_folder 照常成功；folder 0 時 too_many_requests", async () => {
    const folder = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const { app, db } = await buildTestApp({
      limiters: freshLimiters({ edit: new FixedWindowLimiter({ limit: 0, windowMs: 60_000 }), folder }),
    });
    const u = await seedUser(db);
    const n = (await seedNote(db, { ownerId: u.id })).id;
    const f = (await seedFolder(db, { personal: u.id }, { name: "F" })).id;
    const auth = { token: (await seedTokenForUser(db, u.id, RW)).token };

    const first = await callTool(app, auth, "move_note_to_folder", { note_id: n, folder_id: f });
    expect(first.isError, JSON.stringify(first.structuredContent)).toBeUndefined();
    expect((await noteFolderCols(db.$client, n))?.folder_id).toBe(f);
    // 同一顆實例：MCP 扣掉唯一一次後，REST 也被擋。
    status(await place(app, u.id, n, null), 429);
    const second = await callTool(app, auth, "move_note_to_folder", { note_id: n, folder_id: null });
    expect([second.isError, second.structuredContent]).toEqual([
      true,
      { code: "too_many_requests", message: "Too many folder changes right now, so nothing was changed. Try again in a moment." },
    ]);
    expect((await noteFolderCols(db.$client, n))?.folder_id).toBe(f);
  });
});
