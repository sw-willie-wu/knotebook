/**
 * bulk transfer 合併（M9–M11、X1–X6）。筆記動過就 409，
 * 合併、存版、衝突與重試的案已隨程式刪除（「動過就拒」的案在 `transfer-write-reread.test.ts`）。
 */
import { describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import * as Y from "yjs";
import { noteVersions, notes } from "../src/db/schema.js";
import { readTarGz } from "./tar-read.js";
import { presenceClientId } from "../src/notes/editing/presence.js";
import { buildCollabTestApp, testEditingRuntime, type CollabTestCtx } from "./helpers.js";
import { seedContent, seedTokenForUser, tick, waitFor } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { bulkPut, downloadNote, editBody, exportRaw, issueBulkDirect, liveBlocks, liveMarkdown, seedBlocks, seedMd, topIdsOf } from "./bulk-transfer-helpers.js";

type Opts = Parameters<typeof buildCollabTestApp>[0];
const PARAS = (n: number) => Array.from({ length: n }, (_, i) => `Para ${i}`).join("\n\n");

async function scene(opts: Opts = {}, md = PARAS(6)) {
  const ctx = await buildCollabTestApp(opts);
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
  await seedMd(ctx.db, note.id, md);
  return { ctx, u, pat, bulk, note };
}
const versionsOf = (ctx: CollabTestCtx, noteId: string) => ctx.db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId));

describe("M9–M11", () => {
  it("M9 只 mount 兩次（scratch＋fork，沒有重試；判「動過沒」用結構比對、不 mount）；合併前 inFlight 0（冷筆記與剛寫過的熱筆記）", async () => {
    const inFlight: number[] = [];
    const s = await scene({ editingTestHooks: { beforeMerge: async () => void inFlight.push(testEditingRuntime.inFlight) } });
    for (const label of ["cold", "hot"]) {
      const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
      const m0 = testEditingRuntime.mounts;
      const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace(/Para 2( agent cold)?/, `Para 2 agent ${label}`)));
      expect(r.json(), label).toMatchObject({ result: "applied" });
      expect(testEditingRuntime.mounts - m0, label).toBe(2);
    }
    expect(inFlight).toEqual([0, 0]);
  });
  it("M10 同檔同時兩發 → 一發 applied、另一發 unchanged；內容不重複", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const text = editBody(d.text, b => b.replace("Para 1", "Para 1\n\nConcurrent insert"));
    const [a, b] = await Promise.all([bulkPut(s.ctx.app, s.bulk.token, text), bulkPut(s.ctx.app, s.bulk.token, text)]);
    expect([a.json().result, b.json().result].sort()).toEqual(["applied", "unchanged"]);
    expect((await liveMarkdown(s.ctx, s.note.id)).split("Concurrent insert").length - 1).toBe(1);
    expect((await versionsOf(s.ctx, s.note.id)).length).toBeLessThanOrEqual(1);
  });
  it("M11 presence：寫回後該 token 的 awareness 落在第一顆寫入的 block；unchanged 不 touch", async () => {
    const PASSWORD = "correct-horse-battery";
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "p@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("p@example.com", PASSWORD);
    const client = await seedContent(ctx, session, note.id, "First para\n\nSecond para\n\nThird para");
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code");
    const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
    const id = presenceClientId(note.id, pat.tokenId);
    const remote = () => client.provider.awareness!.getStates().get(id) as { cursor?: { anchor: unknown } } | undefined;
    const d = await downloadNote(ctx.app, bulk.token, note.id);
    expect((await bulkPut(ctx.app, bulk.token, d.text)).json()).toMatchObject({ result: "unchanged" });
    for (let i = 0; i < 20; i++) await tick();
    expect(remote()).toBeUndefined();
    expect((await bulkPut(ctx.app, bulk.token, editBody(d.text, b => b.replace("Second para", "Agent second")))).json()).toMatchObject({ result: "applied" });
    const cursorText = () => {
      const r = remote();
      if (!r?.cursor) return null;
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(r.cursor.anchor as never), client.doc);
      return abs ? (abs.type as Y.XmlText).toString() : null;
    };
    await waitFor("游標到 Agent second", 3_000, () => (cursorText() ?? "").includes("Agent second"));
    client.disconnect();
    void topIdsOf;
  });
});

describe("X1–X6（守衛）", () => {
  const filesOfExport = async (s: Awaited<ReturnType<typeof scene>>) => {
    const ex = await exportRaw(s.ctx.baseUrl, s.bulk.token);
    expect(ex.status).toBe(200);
    return readTarGz(ex.body).filter(e => e.type === "file" && !e.path.startsWith(".knotebook/"));
  };
  const fileFor = (files: Awaited<ReturnType<typeof filesOfExport>>, id: string) => files.find(f => f.data.toString("utf8").includes(id))!;
  const liveCount = async (ctx: CollabTestCtx) => (await ctx.db.select({ id: notes.id }).from(notes).where(isNull(notes.deletedAt))).length;

  it("X1 下載整包 → 刪掉兩個檔、改一個檔寫回 → 筆記數不變、只改那一篇（Leaving a file out, or deleting it, deletes nothing）", async () => {
    const s = await scene();
    const others = [];
    for (const t of ["Other one", "Other two"]) {
      const n = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: t });
      await seedMd(s.ctx.db, n.id, `${t} body`);
      others.push(n.id);
    }
    const files = await filesOfExport(s);
    expect(files).toHaveLength(3);
    const before = await Promise.all(others.map(id => liveMarkdown(s.ctx, id)));
    // 「刪掉」兩個檔＝不送；只送改過的那一個
    const mine = fileFor(files, s.note.id).data.toString("utf8");
    const r = await bulkPut(s.ctx.app, s.bulk.token, mine.replace("Para 2", "Para 2 by agent"));
    expect(r.json()).toMatchObject({ id: s.note.id, result: "applied" });
    expect(await liveCount(s.ctx)).toBe(3);
    expect(await Promise.all(others.map(id => liveMarkdown(s.ctx, id)))).toEqual(before);
    expect(await liveMarkdown(s.ctx, s.note.id)).toContain("Para 2 by agent");
    expect(await filesOfExport(s)).toHaveLength(3);
  });

  it("X2 本機改檔名後寫回 → 照 front matter 的 `id` 寫進原筆記（Moving or renaming a file … doesn't move, rename or delete the note）", async () => {
    const s = await scene();
    const files = await filesOfExport(s);
    const f = fileFor(files, s.note.id);
    const renamed = { path: "somewhere/else/renamed-by-agent.md", data: f.data };
    expect(renamed.path).not.toBe(f.path);
    const r = await bulkPut(s.ctx.app, s.bulk.token, renamed.data.toString("utf8").replace("Para 3", "Para 3 moved file"));
    expect(r.json()).toMatchObject({ id: s.note.id, result: "applied", renamed: false });
    expect((await s.ctx.db.select({ title: notes.title }).from(notes).where(eq(notes.id, s.note.id)))[0]!.title).toBe("Title");
    expect(await liveMarkdown(s.ctx, s.note.id)).toContain("Para 3 moved file");
    expect(await liveCount(s.ctx)).toBe(1);
  });

  it("X3 HTML 註解五形（註解行後不空行接 heading／bullet／quote／code fence／表格 → 各成一段純文字）＋行內 `a <!-- c --> b` → `a  b`、那顆換 id", async () => {
    // 五形各自一區（中間夾著沒改的段 S0–S4；同一區裡連著兩組「註解＋下一行」會併成一段）
    const s = await scene({}, "S0\n\nS1\n\nS2\n\nS3\n\nS4\n\nInline target");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const idsBefore = await topIdsOf(s.ctx, s.note.id);
    const forms = ["## Head", "* item", "> q", "```js\ncode\n```", "| a | b |\n| - | - |\n| 1 | 2 |"];
    const body = [...forms.flatMap((f, i) => [`S${i}`, `<!-- note -->\n${f}`]), "a <!-- c --> b"].join("\n\n");
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, () => body));
    expect(r.statusCode).toBe(200);
    const blocks = await liveBlocks(s.ctx, s.note.id);
    expect(blocks).toHaveLength(11);
    expect(blocks.filter((_, i) => i % 2 === 0 && i < 10).map(b => b.id)).toEqual(idsBefore.slice(0, 5));
    const inserted = blocks.filter((_, i) => i % 2 === 1);
    expect(inserted.map(b => b.type)).toEqual(["paragraph", "paragraph", "paragraph", "paragraph", "paragraph"]);
    expect(inserted.map(b => b.text.replace(/\s+/g, " ").trim())).toEqual(["## Head", "* item", "> q", "```js code ```", "| a | b | | - | - | | 1 | 2 |"]);
    expect(blocks[10]).toMatchObject({ type: "paragraph", text: "a  b" });
    expect(blocks[10]!.id).not.toBe(idsBefore[5]);
  });

  // RW `next`：「lines right below one become plain text that can run on into the text after a later comment」——X3（五形各成純文字）＋X3b（接到後一個註解之後的字）
  it("X3b 同一區裡兩組「註解＋下一行」隔空行相連 → 下一行成純文字、並接上後一個註解之後的字（併成一段）", async () => {
    const s = await scene({}, "Keep");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, () => "Keep\n\n<!-- a -->\n## X\n\n<!-- b -->\nY"));
    expect(r.statusCode).toBe(200);
    expect((await liveBlocks(s.ctx, s.note.id)).map(b => `${b.type}:${b.text}`)).toEqual(["paragraph:Keep", "paragraph:## X Y"]);
  });

  // RW `next`：「text after one, on its line …, becomes plain text that can run on into the text after a later comment」；
  // 「with nothing after it on its line」——同一行有字時，空一行只救得了後面的行，救不了同一行的字
  it("X3d 註解後同一行的字也成純文字：`<!-- c --> ## H` → 段落「## H」；同一行有字的兩組隔空行 → 接成一段；同一行有字、空一行後的 `* i` 仍是 bullet", async () => {
    const s = await scene({}, "S0\n\nS1\n\nKeep");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const body = ["S0", "<!-- c --> ## H", "S1", "<!-- c --> x\n\n<!-- d --> y", "Keep", "<!-- c --> z\n\n* i"].join("\n\n");
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, () => body));
    expect(r.statusCode).toBe(200);
    expect((await liveBlocks(s.ctx, s.note.id)).map(b => `${b.type}:${b.text}`)).toEqual([
      "paragraph:S0", "paragraph:## H", "paragraph:S1", "paragraph:x y", "paragraph:Keep", "paragraph:z", "bulletListItem:i",
    ]);
  });

  // RW `next`：「leave a blank line after each comment to keep the lines below it as markdown」
  it("X3c 每個註解後空一行 → 註解下面照 markdown 解讀（heading／bullet／quote／code／表格各成原本的 block），彼此不併", async () => {
    const s = await scene({}, "Keep");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const forms = ["## Head", "* item", "> q", "```js\ncode\n```", "| a | b |\n| - | - |\n| 1 | 2 |", "X", "Y"];
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, () => ["Keep", ...forms.map(f => `<!-- note -->\n\n${f}`)].join("\n\n")));
    expect(r.statusCode).toBe(200);
    expect((await liveBlocks(s.ctx, s.note.id)).map(b => `${b.type}:${b.text}`)).toEqual([
      "paragraph:Keep", "heading:Head", "bulletListItem:item", "quote:q", "codeBlock:code", "table:", "paragraph:X", "paragraph:Y",
    ]);
  });

  it("X4（已知限制）改帶段落子的 bullet → 寫回後巢狀消失、子段落成頂層", async () => {
    const s = await scene();
    const nid = (await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "X" })).id;
    await seedBlocks(s.ctx.db, nid, [{ type: "bulletListItem", content: "a", children: [{ type: "paragraph", content: "child" }] }, { type: "paragraph", content: "after" }]);
    const d = await downloadNote(s.ctx.app, s.bulk.token, nid);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("* a", "* a2")))).statusCode).toBe(200);
    expect((await liveBlocks(s.ctx, nid)).map(b => `${b.type}:${b.text}:${b.children}`)).toEqual(["bulletListItem:a2:0", "paragraph:child:0", "paragraph:after:0"]);
  });

  it("X5（已知限制）toggle 改內容 → 寫回後變 bullet", async () => {
    const s = await scene();
    const nid = (await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "X" })).id;
    await seedBlocks(s.ctx.db, nid, [{ type: "toggleListItem", content: "t1" }, { type: "toggleListItem", content: "t2" }]);
    const d = await downloadNote(s.ctx.app, s.bulk.token, nid);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("* t1", "* t1x")))).statusCode).toBe(200);
    expect((await liveBlocks(s.ctx, nid)).map(b => `${b.type}:${b.text}`)).toEqual(["bulletListItem:t1x", "toggleListItem:t2"]);
  });

  it("X6 含有色項的清單改其中一項 → 整串一區、清單的 id 全換、清單後的段落 id 不變", async () => {
    const s = await scene();
    const nid = (await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "X" })).id;
    await seedBlocks(s.ctx.db, nid, [
      { type: "bulletListItem", content: "a", props: { backgroundColor: "red" } },
      { type: "bulletListItem", content: "b" },
      { type: "bulletListItem", content: "c" },
      { type: "paragraph", content: "after" },
    ]);
    const idsBefore = await topIdsOf(s.ctx, nid);
    const d = await downloadNote(s.ctx.app, s.bulk.token, nid);
    expect(d.body).toContain("<p>b</p>");
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("<p>b</p>", "<p>b2</p>")));
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
    const after = await liveBlocks(s.ctx, nid);
    expect(after.map(b => b.text)).toEqual(["a", "b2", "c", "after"]);
    expect(after.slice(0, 3).filter(b => idsBefore.includes(b.id))).toEqual([]);
    expect(after[3]!.id).toBe(idsBefore[3]);
  });
});
