/**
 * #386：段落內換行經 markdown 寫入後，下一行開頭不得多一個空白——每條寫入路徑寫進含段落內換行的內容，讀出逐字比對：
 * REST 建立（`POST /api/notes` 帶 content）、REST `/edits` 四個寫內容的 op、MCP `create_note`、MCP `edit_note` 四個寫內容的 op、
 * 批次寫回（改段落、新增段落、原樣送回）、檔案寫回新增筆記。另驗修好前寫入、資料庫裡已帶空白的舊內容：讀出 → 原樣寫回不產生改動。
 * 寫入管線與讀出的單元層在 `unit/softbreak-386.test.ts`。
 */
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildCollabTestApp } from "./helpers.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { bulkPut, callTool, downloadNote, editBody, issueBulkDirect, liveMarkdown, seedBlocks } from "./bulk-transfer-helpers.js";

/** 三種段落內換行寫法：軟換行、`\` 換行、行尾兩空白。 */
const FORMS = [
  ["軟換行", "行一ABC\n行二DEF"],
  ["\\ 換行", "行一ABC\\\n行二DEF"],
  ["行尾兩空白", "行一ABC  \n行二DEF"],
  ["CRLF 軟換行", "行一ABC\r\n行二DEF"],
] as const;
/** 讀出的形：`\` 換行、下一行開頭沒有空白。 */
const READ = "行一ABC\\\n行二DEF";

async function scene() {
  const ctx = await buildCollabTestApp();
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  return { ctx, u, pat };
}
const contentOf = async (app: FastifyInstance, id: string, token: string) => {
  const r = await getContent(app, id, token);
  expect(r.statusCode).toBe(200);
  return r.json() as { markdown: string; fingerprint: string; outline: Array<{ sectionId: string; heading: string; fingerprint: string }> };
};
const restCreate = (app: FastifyInstance, token: string, content: string) =>
  app.inject({ method: "POST", url: "/api/notes", headers: bearer(token), payload: { title: "T", content } });
const restEdit = (app: FastifyInstance, token: string, id: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/notes/${id}/edits`, headers: bearer(token), payload: body });

describe("#386 REST", () => {
  it.each(FORMS)("POST /api/notes 帶 content（%s）→ 讀出 %j", async (_l, md) => {
    const s = await scene();
    const r = await restCreate(s.ctx.app, s.pat.token, md);
    expect(r.statusCode).toBe(201);
    expect((await contentOf(s.ctx.app, r.json().id, s.pat.token)).markdown).toBe(`${READ}\n`);
  });

  it("POST /edits：append、replace_all、replace_section、insert_after 寫進去的換行都不多空白", async () => {
    const s = await scene();
    const id = (await restCreate(s.ctx.app, s.pat.token, "# A\n\nold\n\n# B\n\nkeep")).json().id as string;
    expect((await restEdit(s.ctx.app, s.pat.token, id, { op: "append", markdown: "ap1\nap2" })).statusCode).toBe(201);
    let c = await contentOf(s.ctx.app, id, s.pat.token);
    expect(c.markdown).toBe("# A\n\nold\n\n# B\n\nkeep\n\nap1\\\nap2\n");
    const a = c.outline.find(o => o.heading === "A")!;
    expect((await restEdit(s.ctx.app, s.pat.token, id, { op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nrs1\nrs2", if_match: a.fingerprint })).statusCode).toBe(201);
    c = await contentOf(s.ctx.app, id, s.pat.token);
    const b = c.outline.find(o => o.heading === "B")!;
    expect((await restEdit(s.ctx.app, s.pat.token, id, { op: "insert_after", section_id: b.sectionId, markdown: "ia1\\\nia2", if_match: b.fingerprint })).statusCode).toBe(201);
    c = await contentOf(s.ctx.app, id, s.pat.token);
    expect(c.markdown).toBe("# A\n\nrs1\\\nrs2\n\n# B\n\nkeep\n\nap1\\\nap2\n\nia1\\\nia2\n");
    expect((await restEdit(s.ctx.app, s.pat.token, id, { op: "replace_all", markdown: "ra1  \nra2", if_match: c.fingerprint })).statusCode).toBe(201);
    c = await contentOf(s.ctx.app, id, s.pat.token);
    expect(c.markdown).toBe("ra1\\\nra2\n");
    // CRLF（審查 M4）：段落尾不留空白、換行後不多空白
    expect((await restEdit(s.ctx.app, s.pat.token, id, { op: "replace_all", markdown: "p\r\n\r\nc1\r\nc2\r\n", if_match: c.fingerprint })).statusCode).toBe(201);
    expect((await contentOf(s.ctx.app, id, s.pat.token)).markdown).toBe("p\n\nc1\\\nc2\n");
  });
});

describe("#386 MCP", () => {
  it.each(FORMS)("create_note 帶 content（%s）→ 讀出 %j", async (_l, md) => {
    const s = await scene();
    const r = await callTool(s.ctx.app, s.pat.token, "create_note", { title: "T", content: md });
    expect(r.isError).toBeUndefined();
    const id = (r.structuredContent as { note: { id: string } }).note.id;
    expect((await contentOf(s.ctx.app, id, s.pat.token)).markdown).toBe(`${READ}\n`);
  });

  it("edit_note：append、replace_section、insert_after、replace_all 寫進去的換行都不多空白", async () => {
    const s = await scene();
    const r0 = await callTool(s.ctx.app, s.pat.token, "create_note", { title: "T", content: "# A\n\nold\n\n# B\n\nkeep" });
    const id = (r0.structuredContent as { note: { id: string } }).note.id;
    const edit = async (args: Record<string, unknown>) => {
      const r = await callTool(s.ctx.app, s.pat.token, "edit_note", { note_id: id, ...args });
      expect(r.isError).toBeUndefined();
    };
    await edit({ op: "append", markdown: "起頭。\n\n行一ABC\n行二DEF" });
    let c = await contentOf(s.ctx.app, id, s.pat.token);
    expect(c.markdown).toBe(`# A\n\nold\n\n# B\n\nkeep\n\n起頭。\n\n${READ}\n`);
    const a = c.outline.find(o => o.heading === "A")!;
    await edit({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nrs1\nrs2", if_match: a.fingerprint });
    c = await contentOf(s.ctx.app, id, s.pat.token);
    const b = c.outline.find(o => o.heading === "B")!;
    await edit({ op: "insert_after", section_id: b.sectionId, markdown: "ia1\\\nia2", if_match: b.fingerprint });
    c = await contentOf(s.ctx.app, id, s.pat.token);
    expect(c.markdown).toBe(`# A\n\nrs1\\\nrs2\n\n# B\n\nkeep\n\n起頭。\n\n${READ}\n\nia1\\\nia2\n`);
    await edit({ op: "replace_all", markdown: "ra1  \nra2", if_match: c.fingerprint });
    c = await contentOf(s.ctx.app, id, s.pat.token);
    expect(c.markdown).toBe("ra1\\\nra2\n");
    await edit({ op: "replace_all", markdown: "p\r\n\r\nc1\r\nc2\r\n", if_match: c.fingerprint });
    expect((await contentOf(s.ctx.app, id, s.pat.token)).markdown).toBe("p\n\nc1\\\nc2\n");
  });
});

describe("#386 實例：引言裡的粗體＋inline code＋換行，edit_note replace_section 讀出原樣寫回", () => {
  it("讀出 → replace_section 寫回 → 再讀出逐字相同（三輪）", async () => {
    const s = await scene();
    const note = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "Q" });
    const B = { bold: true };
    const C = { code: true };
    // agent 寫 `**test 跟 lint 沒有 `soft_` 開關，是刻意的。**` 存成的形（粗體在 code 兩側斷開、粗體跨換行）＋修好前換行後多的那格空白
    await seedBlocks(s.ctx.db, note.id, [
      { type: "heading", props: { level: 2 }, content: "說明" },
      {
        type: "quote",
        content: [
          { type: "text", text: "test 跟 lint 沒有 ", styles: B },
          { type: "text", text: "soft_", styles: C },
          { type: "text", text: " 開關，是刻意的。\n", styles: B },
          { type: "text", text: " 其他每一道預設都是硬的，需要過渡期才調軟 —— 而且 ", styles: {} },
          { type: "text", text: "soft_*", styles: C },
          { type: "text", text: " 一開就是所有分支一起軟化，", styles: {} },
          { type: "text", text: "包含發版 tag", styles: B },
          { type: "text", text: "。", styles: {} },
        ],
      },
    ]);
    const reads: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const c = await contentOf(s.ctx.app, note.id, s.pat.token);
      reads.push(c.markdown);
      const sec = c.outline.find(o => o.heading === "說明")!;
      const one = await getContent(s.ctx.app, note.id, s.pat.token, sec.sectionId);
      const md = (one.json() as { section: { markdown: string } }).section.markdown;
      const r = await callTool(s.ctx.app, s.pat.token, "edit_note", { note_id: note.id, op: "replace_section", section_id: sec.sectionId, markdown: md, if_match: sec.fingerprint });
      expect(r.isError).toBeUndefined();
    }
    expect(reads[0]).toContain("> **test 跟 lint 沒有** `soft_` **開關，是刻意的。**<br> 其他");
    expect(reads[1]).toBe(reads[0]);
    expect(reads[2]).toBe(reads[0]);
  });
});

describe("#386 批次寫回", () => {
  async function bulkScene() {
    const s = await scene();
    const bulk = await issueBulkDirect(s.ctx.db, s.pat.tokenId, { access: "write" });
    const note = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "E" });
    await seedBlocks(s.ctx.db, note.id, [{ type: "paragraph", content: "原文。" }]);
    return { ...s, bulk, note };
  }

  it.each(FORMS)("檔案新增兩行段落（%s）→ applied、讀出逐字；改另一段再送 → 那段不動；原樣再送 → unchanged", async (_l, md) => {
    const s = await bulkScene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, body => body.replace("原文。", `原文。\n\n${md}`)));
    expect(r.json()).toMatchObject({ result: "applied" });
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(`原文。\n\n${READ}\n`);

    const d2 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect(d2.body).toContain(READ);
    const r2 = await bulkPut(s.ctx.app, s.bulk.token, editBody(d2.text, body => body.replace("原文。", "原文改。")));
    expect(r2.json()).toMatchObject({ result: "applied", applied: 1 });
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(`原文改。\n\n${READ}\n`);

    const d3 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, d3.text)).json()).toMatchObject({ result: "unchanged" });
  });

  it("改兩行段落本身（換掉第一行）→ 寫回後下一行開頭沒有空白；反覆三輪都一樣", async () => {
    const s = await bulkScene();
    let d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, body => body.replace("原文。", "行一ABC\n行二DEF")));
    for (const round of [1, 2, 3]) {
      d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
      const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, body => body.replace(/^行一ABC(-\d)?/m, `行一ABC-${round}`)));
      expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
      expect(await liveMarkdown(s.ctx, s.note.id)).toBe(`行一ABC-${round}\\\n行二DEF\n`);
    }
  });

  it.each(FORMS)("沒有 id 的檔（新增筆記，%s）→ 201、讀出逐字", async (_l, md) => {
    const s = await bulkScene();
    const r = await bulkPut(s.ctx.app, s.bulk.token, `---\nknotebook: 1\ntitle: "New"\n---\n${md}\n`);
    expect(r.statusCode).toBe(201);
    expect(await liveMarkdown(s.ctx, (r.json() as { id: string }).id)).toBe(`${READ}\n`);
  });
});

describe("#386 修好前寫入的舊內容（下一行開頭帶一格空白，不做資料修正）", () => {
  async function oldScene() {
    const s = await scene();
    const bulk = await issueBulkDirect(s.ctx.db, s.pat.tokenId, { access: "write" });
    const note = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "Old" });
    await seedBlocks(s.ctx.db, note.id, [
      { type: "paragraph", content: "起頭。" },
      { type: "paragraph", content: [{ type: "text", text: "行一ABC\n 行二DEF", styles: {} }] },
    ]);
    return { ...s, bulk, note };
  }
  const OLD_READ = "行一ABC<br> 行二DEF";

  it("讀出用行內 <br> 留住那格空白；批次原樣送回 unchanged；改另一段送回 → 舊段不動", async () => {
    const s = await oldScene();
    expect((await contentOf(s.ctx.app, s.note.id, s.pat.token)).markdown).toBe(`起頭。\n\n${OLD_READ}\n`);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, d.text)).json()).toMatchObject({ result: "unchanged" });
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, body => body.replace("起頭。", "起頭改。")));
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(`起頭改。\n\n${OLD_READ}\n`);
  });

  it("批次：把舊段整段（含讀出的 <br>）改動又改回、連同相鄰段一起送 → 舊段的空白照留", async () => {
    const s = await oldScene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    // 起頭與舊段相鄰、兩段都在改寫區裡：舊段的文字原樣、只是被一起重新解析
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, body => body.replace(`起頭。\n\n${OLD_READ}`, `起頭改。\n\n${OLD_READ}`)));
    expect(r.json()).toMatchObject({ result: "applied" });
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(`起頭改。\n\n${OLD_READ}\n`);
  });

  it("edit_note：讀出的整篇原樣 replace_all 寫回 → 內容與指紋不變", async () => {
    const s = await oldScene();
    const c = await contentOf(s.ctx.app, s.note.id, s.pat.token);
    const r = await callTool(s.ctx.app, s.pat.token, "edit_note", { note_id: s.note.id, op: "replace_all", markdown: c.markdown, if_match: c.fingerprint });
    expect(r.isError).toBeUndefined();
    const after = await contentOf(s.ctx.app, s.note.id, s.pat.token);
    expect(after.markdown).toBe(c.markdown);
    expect(after.fingerprint).toBe(c.fingerprint);
  });
});
