/**
 * #222：MCP／REST 讀寫筆記的文字色／底色（整合層）。
 *
 * - 寫入：不在色盤的色值整筆拒絕——MCP `edit_note`／`create_note` 的工具錯誤 `unsupported_color`、
 *   REST `POST /api/notes/:id/edits`／`POST /api/notes` 的 400；錯誤訊息列出可用色名；什麼都不存。
 * - 讀取：`read_note_section` 帶出顏色（寫入端認得的 HTML），拿讀到的原文與指紋 `replace_section`
 *   寫回，再讀一次逐字相同。
 *
 * ⚠ `callTool`／`payloadOf`／`errorOf` 與 `mcp-edit-note.test.ts` 等的同名 helper 是又一份
 * （同樣的理由：各自只有幾行）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { noteAiEdits, notes, noteStates } from "../src/db/schema.js";
import { PALETTE_COLORS } from "../src/notes/editing/colors.js";
import { buildCollabTestApp, type CollabTestCtx } from "./helpers.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";

interface ToolResultBody {
  isError?: true;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown> & { code?: string; message?: string };
}
interface ToolCall {
  status: number;
  result: ToolResultBody;
}

async function callTool(app: FastifyInstance, token: string, name: string, args: unknown = {}): Promise<ToolCall> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  return { status: res.statusCode, result: res.json().result };
}
function payloadOf<T>(call: ToolCall): T {
  expect(call.status).toBe(200);
  expect(call.result.isError, JSON.stringify(call.result)).toBeUndefined();
  return call.result.structuredContent as unknown as T;
}
function errorOf(call: ToolCall): Record<string, unknown> & { code?: string; message?: string } {
  expect(call.status).toBe(200);
  expect(call.result.isError).toBe(true);
  expect(call.result.content[0]!.text).toBe(JSON.stringify(call.result.structuredContent));
  return call.result.structuredContent!;
}

interface Scene {
  ctx: CollabTestCtx;
  ownerId: string;
  token: string;
}
async function scene(): Promise<Scene> {
  const ctx = await buildCollabTestApp();
  const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
  const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write", "Claude Code");
  return { ctx, ownerId: owner.id, token };
}

const countNotes = async (s: Scene) => (await s.ctx.db.select().from(notes).where(eq(notes.ownerId, s.ownerId))).length;
const countEdits = async (s: Scene, noteId: string) => (await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, noteId))).length;
const stateBytes = async (s: Scene, noteId: string) => {
  const [r] = await s.ctx.db.select({ y: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, noteId));
  return r ? Buffer.from(r.y).toString("base64") : null;
};

const COLORED =
  "# Colors\n\n" +
  'plain <span style="color:red">red</span> and <span style="color:blue;background-color:yellow">both</span>\n\n' +
  '<p data-background-color="yellow" data-text-color="purple">whole paragraph</p>\n\n' +
  '<table><tr><th>h1</th><th>h2</th></tr><tr><td data-background-color="blue">c</td><td>d</td></tr></table>\n\n' +
  "# Other\n\nplain";
const BAD = 'x <span style="color:#ff6600">orange-ish</span>';

const expectListsPalette = (message: string | undefined) => {
  for (const c of PALETTE_COLORS) expect(message).toContain(c);
};

async function createColored(s: Scene): Promise<string> {
  const { note } = payloadOf<{ note: { id: string } }>(await callTool(s.ctx.app, s.token, "create_note", { title: "C", content: COLORED }));
  return note.id;
}

describe("#222 MCP 寫入：只收內建色名", () => {
  it("create_note 帶不在色盤的色值 → unsupported_color、訊息列出 10 個色名、一列都不建", async () => {
    const s = await scene();
    const err = errorOf(await callTool(s.ctx.app, s.token, "create_note", { title: "T", content: BAD }));
    expect(err.code).toBe("unsupported_color");
    expectListsPalette(err.message);
    expect(await countNotes(s)).toBe(0);
  });

  it("edit_note 帶不在色盤的色值 → unsupported_color、內容位元組相同、修改紀錄零新增", async () => {
    const s = await scene();
    const noteId = await createColored(s);
    const beforeState = await stateBytes(s, noteId);
    const beforeEdits = await countEdits(s, noteId);
    const err = errorOf(await callTool(s.ctx.app, s.token, "edit_note", { note_id: noteId, op: "append", markdown: BAD }));
    expect(err.code).toBe("unsupported_color");
    expectListsPalette(err.message);
    expect(await stateBytes(s, noteId)).toBe(beforeState);
    expect(await countEdits(s, noteId)).toBe(beforeEdits);
  });
});

describe("#222 REST 寫入：同一條管線、400 unsupported_color", () => {
  it("POST /api/notes/:id/edits 與 POST /api/notes {content} → 400 unsupported_color，訊息列出色名", async () => {
    const s = await scene();
    const noteId = await createColored(s);
    const beforeState = await stateBytes(s, noteId);
    const r1 = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${noteId}/edits`, headers: bearer(s.token), payload: { op: "append", markdown: BAD } });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.code).toBe("unsupported_color");
    expectListsPalette(r1.json().error.message);
    expect(await stateBytes(s, noteId)).toBe(beforeState);

    const before = await countNotes(s);
    const r2 = await s.ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(s.token), payload: { title: "X", content: BAD } });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error.code).toBe("unsupported_color");
    expectListsPalette(r2.json().error.message);
    expect(await countNotes(s)).toBe(before);
  });
});

describe("#222 讀取帶出顏色，讀 → replace_section 寫回 → 再讀一致", () => {
  it("read_note_section 的 markdown 帶出三種顏色；原文＋指紋寫回後再讀逐字相同", async () => {
    const s = await scene();
    const noteId = await createColored(s);
    // section id 跟著 heading block 走，replace_section 之後會換——每次讀都重拿大綱。
    const colorsId = async () =>
      payloadOf<{ sections: Array<{ sectionId: string; heading: string }> }>(
        await callTool(s.ctx.app, s.token, "read_note_outline", { note_id: noteId })
      ).sections.find(x => x.heading === "Colors")!.sectionId;
    const read = async () =>
      payloadOf<{ section: { markdown: string; fingerprint?: string }; truncated: boolean }>(
        await callTool(s.ctx.app, s.token, "read_note_section", { note_id: noteId, section_id: await colorsId() })
      );
    const r1 = await read();
    expect(r1.truncated).toBe(false);
    const md1 = r1.section.markdown;
    // 只有行內顏色的段落維持 markdown，span 夾在裡面；整段／儲存格顏色才整段 HTML。
    expect(md1).toContain('\nplain <span style="color:red">red</span> and <span style="color:blue;background-color:yellow">both</span>\n');
    expect(md1).toContain('<p data-background-color="yellow" data-text-color="purple">whole paragraph</p>');
    expect(md1).toContain('<td data-background-color="blue">c</td>');
    expect(md1).not.toContain("| ---");

    payloadOf(await callTool(s.ctx.app, s.token, "edit_note", { note_id: noteId, op: "replace_section", section_id: await colorsId(), markdown: md1, if_match: r1.section.fingerprint }));
    const r2 = await read();
    expect(r2.section.markdown).toBe(md1);

    // 其他段落（無色）的輸出不受影響：仍是純 markdown。
    const rest = await getContent(s.ctx.app, noteId, s.token);
    expect(rest.json().markdown).toContain("# Other\n\nplain\n");
  });
});
