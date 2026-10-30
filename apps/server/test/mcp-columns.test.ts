/**
 * 並排 PR-2（spec §11.3、§11.12、§13.1、驗收 10／11 的 server 半）：MCP／REST 讀出並排、圖片寬度與表格欄寬的正規形，
 * 原樣寫回（replace_section）結構與寬度不變；只改一個字時寬度不流失（#305）；不合格的讀出（5 欄）原樣寫回整筆拒絕。
 *
 * ⚠ `callTool`／`payloadOf`／`errorOf` 是 `mcp-colors.test.ts` 那份的又一份；`humanEdit` 抄自 `note-edits.test.ts`
 * （同樣的理由：各自只有幾行）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { COLUMNS_OPEN_TAG, columnOpenTag } from "@knotebook/shared";
import { noteAiEdits } from "../src/db/schema.js";
import { loadNoteDoc } from "../src/notes/editing/read.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { buildCollabTestApp, testEditingRuntime, type CollabTestCtx, type TestClient } from "./helpers.js";
import { docText, getContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { seedUpload } from "./copy-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";

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
  noteId: string;
  client: TestClient;
}
async function scene(): Promise<Scene> {
  const ctx = await buildCollabTestApp();
  const email = `o-${randomUUID()}@example.com`;
  const owner = await ctx.createUser({ email, password: PASSWORD });
  const note = await ctx.createNote(owner.id);
  const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write", "Claude Code");
  const session = await ctx.loginAs(email, PASSWORD);
  const client = await session.connect(note.id);
  return { ctx, ownerId: owner.id, token, noteId: note.id, client };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組
type AnyBlocks = any[];
/** provider 側用 server 的 EditorSession 改 client.doc（模擬人在瀏覽器編輯），等到 server 的 live doc 收到才回傳。 */
async function humanEdit(s: Scene, sentinel: string, blocks: AnyBlocks): Promise<void> {
  const es = await EditorSession.open(testEditingRuntime, s.client.doc);
  try {
    es.editor.replaceBlocks(es.editor.document, blocks);
  } finally {
    es.close(); // ⚠ 模組層單例 runtime 的 lease，throw 也要還
  }
  await waitFor(`server 收到人工編輯（${sentinel}）`, 5_000, () => docText(s.ctx.collab.hocuspocus.documents.get(s.noteId)!).includes(sentinel));
}
/** server 目前的內容（live doc 的 fork）經編輯器讀成完整 blocks。 */
async function serverBlocks(s: Scene): Promise<AnyBlocks> {
  const { doc } = await loadNoteDoc({ db: s.ctx.db, collab: s.ctx.collab }, s.noteId);
  const es = await EditorSession.open(testEditingRuntime, doc);
  try {
    return es.editor.document;
  } finally {
    es.close();
  }
}
type SectionPayload = { section: { markdown: string; fingerprint?: string }; truncated: boolean };
const readTop = async (s: Scene) => {
  const r = payloadOf<SectionPayload>(await callTool(s.ctx.app, s.token, "read_note_section", { note_id: s.noteId, section_id: "_top" }));
  expect(r.truncated).toBe(false);
  return r.section;
};
const replaceTop = (s: Scene, markdown: string, ifMatch: string | undefined) =>
  callTool(s.ctx.app, s.token, "edit_note", { note_id: s.noteId, op: "replace_section", section_id: "_top", markdown, if_match: ifMatch });
const countEdits = async (s: Scene) => (await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId))).length;

const P = (text: string) => ({ type: "paragraph", content: text });
const col = (width: number, ...children: AnyBlocks) => ({ type: "column", props: { width }, children });
const row = (...cols: AnyBlocks) => ({ type: "columnList", children: cols });

describe("並排讀出 → 原樣寫回（驗收 10）", () => {
  it("MC1：read_note_section 的 _top 帶出正規並排行；原樣 replace_section 成功、再讀逐字相同、Y 結構仍是一列兩欄 [1, 1.5]", async () => {
    const s = await scene();
    await humanEdit(s, "後段落", [P("前段落"), row(col(1, P("左欄L")), col(1.5, P("右欄R"))), P("後段落")]);
    const r1 = await readTop(s);
    const lines = r1.markdown.split("\n");
    expect(lines).toContain(COLUMNS_OPEN_TAG);
    expect(lines).toContain(columnOpenTag(1));
    expect(lines).toContain(columnOpenTag(1.5));

    payloadOf(await replaceTop(s, r1.markdown, r1.fingerprint));
    expect((await readTop(s)).markdown).toBe(r1.markdown);
    const blocks = await serverBlocks(s);
    expect(blocks.map(b => b.type)).toEqual(["paragraph", "columnList", "paragraph"]);
    expect(blocks[1].children.map((c: { type: string; props: { width: number } }) => [c.type, c.props.width])).toEqual([["column", 1], ["column", 1.5]]);
    s.client.disconnect();
  });
});

describe("#305：只改一個字，圖片寬度與表格欄寬不流失（驗收 11 server 半）", () => {
  const sized = (uploadId: string): AnyBlocks => [
    P("old words"),
    { type: "image", props: { url: `/api/uploads/${uploadId}`, previewWidth: 300 } },
    { type: "table", content: { type: "tableContent", columnWidths: [120, undefined], rows: [{ cells: ["h1", "h2"] }, { cells: ["a", "b"] }] } },
    {
      type: "table",
      content: { type: "tableContent", headerRows: 1, columnWidths: [120, undefined, 80], rows: [{ cells: [{ type: "tableCell", props: { colspan: 2 }, content: "ab" }, "c"] }, { cells: ["d", "e", "f"] }] },
    },
    P("tail sentinel"),
  ];
  const seedSized = async (s: Scene) => {
    const uploadId = await seedUpload(s.ctx.db, s.ctx.uploadsDir, s.noteId, s.ownerId);
    await humanEdit(s, "tail sentinel", sized(uploadId));
  };

  it("MC2：讀 _top → 只把 old 換成 new → replace_section → 段落換字、previewWidth 300、兩張表的 columnWidths 不變（合併格未設寬仍是 undefined）、再讀逐字相同", async () => {
    const s = await scene();
    await seedSized(s);
    const r1 = await readTop(s);
    expect(r1.markdown.split("old").length - 1).toBe(1);
    const md = r1.markdown.replace("old", "new");
    payloadOf(await replaceTop(s, md, r1.fingerprint));

    const blocks = await serverBlocks(s);
    expect(blocks.map(b => b.type)).toEqual(["paragraph", "image", "table", "table", "paragraph"]);
    expect(blocks[0].content.map((t: { text: string }) => t.text).join("")).toBe("new words");
    expect(blocks[1].props.previewWidth).toBe(300);
    expect(blocks[2].content.columnWidths[0]).toBe(120);
    const ws = blocks[3].content.columnWidths as unknown[];
    expect(ws.map(v => (v === undefined ? "unset" : v))).toEqual([120, "unset", 80]);
    expect((await readTop(s)).markdown).toBe(md);
    s.client.disconnect();
  });

  it("MC3（§11.12）：REST GET /api/notes/:id/content 同樣讀出 <figure> 寬度與第一列 colwidth", async () => {
    const s = await scene();
    await seedSized(s);
    const res = await getContent(s.ctx.app, s.noteId, s.token);
    expect(res.statusCode).toBe(200);
    const md = res.json().markdown as string;
    expect(md).toContain('width="300"></figure>');
    expect(md).toContain('colwidth="120"');
    s.client.disconnect();
  });
});

describe("不合格的既存結構（I5 例外）", () => {
  it("MC4：人工編輯出的 5 欄列讀出 5 個欄行；原樣 replace_section → unsupported_columns、內容不變", async () => {
    const s = await scene();
    await humanEdit(s, "第五欄", [row(col(1, P("第一欄")), col(1, P("第二欄")), col(1, P("第三欄")), col(1, P("第四欄")), col(1, P("第五欄")))]);
    const r1 = await readTop(s);
    expect(r1.markdown.split("\n").filter(l => l === columnOpenTag(1))).toHaveLength(5);
    const liveBefore = docText(s.ctx.collab.hocuspocus.documents.get(s.noteId)!);
    const editsBefore = await countEdits(s);

    const err = errorOf(await replaceTop(s, r1.markdown, r1.fingerprint));
    expect(err.code).toBe("unsupported_columns");
    expect(docText(s.ctx.collab.hocuspocus.documents.get(s.noteId)!)).toBe(liveBefore);
    expect(await countEdits(s)).toBe(editsBefore);
    expect((await readTop(s)).markdown).toBe(r1.markdown);
    s.client.disconnect();
  });
});
