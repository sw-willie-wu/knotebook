/**
 * bulk transfer spec 2026-11-02 §9.4、§9.5（合併、存版、重試）；plan PR-2 T8（M1–M11、M8b–M8e）。「人」的修改走
 * `humanEdit`（直連合併進 live doc，不進 AI 修改紀錄）。
 */
import { describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteVersions, notes } from "../src/db/schema.js";
import { readTarGz } from "./tar-read.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { presenceClientId } from "../src/notes/editing/presence.js";
import { buildCollabTestApp, testEditingRuntime, type CollabTestCtx } from "./helpers.js";
import { seedContent, seedTokenForUser, tick, waitFor } from "./editing-helpers.js";
import { cookieOf, seedNote, seedUser } from "./group-helpers.js";
import { bulkPut, downloadNote, editBody, exportRaw, humanEdit, issueBulkDirect, liveBlocks, liveMarkdown, seedBlocks, seedMd, topIdsOf } from "./bulk-transfer-helpers.js";

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
const versionText = (ydoc: Uint8Array) => {
  const d = new Y.Doc();
  Y.applyUpdate(d, ydoc);
  return d.getXmlFragment(YDOC_FRAGMENT).toString();
};
const settled = (ctx: CollabTestCtx) => waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);

describe("M1–M7 合併形", () => {
  it("M1 人改第 5 段＋agent 改第 2 段 → 兩邊都在、無存版、applied", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.updateBlock(ed.document[5]!.id, { content: "Human five" }));
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 2", "Agent two")));
    expect(r.json()).toMatchObject({ result: "applied", conflicts: 0 });
    const md = await liveMarkdown(s.ctx, s.note.id);
    expect(md).toContain("Human five");
    expect(md).toContain("Agent two");
    expect(await versionsOf(s.ctx, s.note.id)).toHaveLength(0);
  });
  it("M2 人在第 2 段前插段＋agent 改第 2 段 → 插的在、無衝突", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.insertBlocks([{ type: "paragraph", content: "Human inserted" }], ed.document[2]!.id, "before"));
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 2", "Agent two")));
    expect(r.json()).toMatchObject({ result: "applied", conflicts: 0 });
    const md = await liveMarkdown(s.ctx, s.note.id);
    expect(md).toContain("Human inserted");
    expect(md).toContain("Agent two");
  });
  it("M3 同段兩邊改 → merged、conflicts 1、版本「本機檔案同步前」是人的內容、結果取 agent 的", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.updateBlock(ed.document[2]!.id, { content: "Human two" }));
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 2", "Agent two")));
    expect(r.statusCode).toBe(200);
    const body = r.json() as { result: string; conflicts: number; version: { id: string; name: string } };
    expect(body).toMatchObject({ result: "merged", conflicts: 1, version: { name: "本機檔案同步前" } });
    const vs = await versionsOf(s.ctx, s.note.id);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.id).toBe(body.version.id);
    expect(versionText(vs[0]!.ydoc)).toContain("Human two");
    const md = await liveMarkdown(s.ctx, s.note.id);
    expect(md).toContain("Agent two");
    expect(md).not.toContain("Human two");
  });
  it("M4 冷筆記＋衝突 → 版本存在（transient）", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.updateBlock(ed.document[2]!.id, { content: "Human cold" }));
    await settled(s.ctx);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 2", "Agent cold")));
    expect(r.json()).toMatchObject({ result: "merged" });
    const vs = await versionsOf(s.ctx, s.note.id);
    expect(vs).toHaveLength(1);
    expect(versionText(vs[0]!.ydoc)).toContain("Human cold");
  });
  it("M5 cutIfDirty skipped → 503、筆記未變；兩次 null → 503", async () => {
    for (const forced of ["skipped", null] as const) {
      const s = await scene({ editingTestHooks: { cutOverride: () => forced } });
      const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
      await humanEdit(s.ctx, s.note.id, ed => ed.updateBlock(ed.document[2]!.id, { content: "Human two" }));
      const before = await liveMarkdown(s.ctx, s.note.id);
      const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 2", "Agent two")));
      expect(r.statusCode, String(forced)).toBe(503);
      expect(await liveMarkdown(s.ctx, s.note.id)).toBe(before);
    }
  });
  it("M6 刪除三形：倖存者全不見 → same；被改空 → applied；被改非空 → conflict＋存版", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => {
      ed.removeBlocks([ed.document[1]!.id]);
      ed.updateBlock(ed.document[4]!.id, { content: "Human five" }); // 刪掉 1 之後，index 4＝原 Para 5
    });
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1\n\n", "").replace("Para 3\n\n", "").replace("\n\nPara 5", "")));
    expect(r.json()).toMatchObject({ result: "merged", applied: 1, same: 1, conflicts: 1, version: { name: "本機檔案同步前" } });
    const md = await liveMarkdown(s.ctx, s.note.id);
    for (const gone of ["Para 1", "Para 3", "Human five"]) expect(md).not.toContain(gone);
  });
  it("M7 人在 agent 改的清單項下加子項 → conflict、子項隨倖存者移除、存版裡有", async () => {
    const s = await scene({}, "* a\n* b\n* c");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.updateBlock(ed.document[1]!.id, { children: [{ type: "paragraph", content: "Human child" }] } as never));
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("* b", "* b2")));
    expect(r.json()).toMatchObject({ result: "merged", conflicts: 1 });
    expect(await liveMarkdown(s.ctx, s.note.id)).not.toContain("Human child");
    expect(versionText((await versionsOf(s.ctx, s.note.id))[0]!.ydoc)).toContain("Human child");
  });
});

describe("M8 重試與扣桶", () => {
  it("M8 beforeMerge 改倖存者一次 → 重試成功、版本恰一個；扣桶只扣 1（limit 2：另一篇仍 200、第三篇 429）", async () => {
    let hit = 0;
    const ref = {} as { ctx: CollabTestCtx };
    let noteRef = "";
    const transferWrite = new FixedWindowLimiter({ limit: 2, windowMs: 60_000 });
    const s = await scene({
      limiters: { transferWrite },
      editingTestHooks: {
        beforeMerge: async () => {
          if (noteRef === "" || hit++ > 0) return;
          await humanEdit(ref.ctx, noteRef, ed => ed.updateBlock(ed.document[2]!.id, { content: "Human during merge" }));
        },
      },
    });
    ref.ctx = s.ctx;
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    noteRef = s.note.id;
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 2", "Agent two")));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: "merged", conflicts: 1 });
    expect(hit).toBe(2);
    expect(await versionsOf(s.ctx, s.note.id)).toHaveLength(1);
    noteRef = "";
    const mk = async (t: string) => {
      const n = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: t });
      await seedMd(s.ctx.db, n.id, `${t} para`);
      const dn = await downloadNote(s.ctx.app, s.bulk.token, n.id);
      return bulkPut(s.ctx.app, s.bulk.token, editBody(dn.text, () => `${t} changed`));
    };
    expect((await mk("Second")).statusCode).toBe(200);
    expect((await mk("Third")).statusCode).toBe(429);
  });
  it("M8 改三次 → 503；在倖存者之間插入 → 保留", async () => {
    const ref = {} as { ctx: CollabTestCtx };
    let noteRef = "";
    let n = 0;
    let mode: "change" | "insert" = "change";
    const s = await scene({
      editingTestHooks: {
        beforeMerge: async () => {
          if (noteRef === "") return;
          n++;
          if (mode === "change") await humanEdit(ref.ctx, noteRef, ed => ed.updateBlock(ed.document[2]!.id, { content: `Human ${n}` }));
          else if (n === 1) await humanEdit(ref.ctx, noteRef, ed => ed.insertBlocks([{ type: "paragraph", content: "Between survivors" }], ed.document[3]!.id, "after"));
        },
      },
    });
    ref.ctx = s.ctx;
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    noteRef = s.note.id;
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 2", "Agent two")))).statusCode).toBe(503);
    expect(n).toBe(3);
    // 插入在倖存者之間（改寫區＝Para 3、Para 4 兩段）
    noteRef = "";
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    mode = "insert";
    n = 0;
    noteRef = s.note.id;
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d2.text, b => b.replace("Para 3\n\nPara 4", "Agent three\n\nAgent four")));
    expect(r.statusCode).toBe(200);
    expect(await liveMarkdown(s.ctx, s.note.id)).toContain("Between survivors");
  });
  it("M8b 一開始就衝突＋重試（beforeMerge 只在第一次改另一區的倖存者）→ 版本恰好 1", async () => {
    const ref = {} as { ctx: CollabTestCtx };
    let noteRef = "";
    let n = 0;
    const s = await scene({
      editingTestHooks: {
        beforeMerge: async () => {
          if (noteRef === "" || n++ > 0) return;
          await humanEdit(ref.ctx, noteRef, ed => ed.updateBlock(ed.document[4]!.id, { content: "Human four late" }));
        },
      },
    });
    ref.ctx = s.ctx;
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.updateBlock(ed.document[1]!.id, { content: "Human one" }));
    noteRef = s.note.id;
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "Agent one").replace("Para 4", "Agent four")));
    expect(r.json()).toMatchObject({ result: "merged", conflicts: 2 });
    expect(n).toBe(2);
    expect(await versionsOf(s.ctx, s.note.id)).toHaveLength(1);
  });
  it("M8c 衝突時內容恰等於最新的手動版本 → 不新增版本列、回應帶 version、名稱仍是「我的版本」", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.updateBlock(ed.document[2]!.id, { content: "Human two" }));
    const save = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/versions`, cookies: await cookieOf(s.u.id), headers: { "content-type": "application/json" }, payload: { name: "我的版本" } });
    expect(save.statusCode).toBeLessThan(300);
    expect(await versionsOf(s.ctx, s.note.id)).toHaveLength(1);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 2", "Agent two")));
    expect(r.json()).toMatchObject({ result: "merged", version: { name: "我的版本" } });
    expect(await versionsOf(s.ctx, s.note.id)).toHaveLength(1);
  });
  it("M8d 重試後才變零區（人在 beforeMerge 做了同樣的修改）→ tokenRead limit 0 仍 200（本請求已扣 transferWrite）", async () => {
    const ref = {} as { ctx: CollabTestCtx };
    let noteRef = "";
    let n = 0;
    const tokenRead = new FixedWindowLimiter({ limit: 0, windowMs: 60_000 });
    const s = await scene({
      limiters: { tokenRead },
      editingTestHooks: {
        beforeMerge: async () => {
          if (noteRef === "" || n++ > 0) return;
          await humanEdit(ref.ctx, noteRef, ed => ed.replaceBlocks([ed.document[2]!.id], [{ type: "paragraph", content: "Same change" }]));
        },
      },
    });
    ref.ctx = s.ctx;
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    noteRef = s.note.id;
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 2", "Same change")));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: "unchanged" });
  });
  it("M8e 判 same 所依據的外來 block 在合併前被刪 → 重試重判成 applied → 恰一份 agent 的內容", async () => {
    const ref = {} as { ctx: CollabTestCtx };
    let noteRef = "";
    let n = 0;
    const s = await scene({
      editingTestHooks: {
        beforeMerge: async () => {
          if (noteRef === "" || n++ > 0) return;
          await humanEdit(ref.ctx, noteRef, ed => {
            const f = ed.document.find(b => JSON.stringify(b.content).includes("Foreign same"));
            if (f) ed.removeBlocks([f.id]);
          });
        },
      },
    });
    ref.ctx = s.ctx;
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    // 人先插入與 agent 要插的相同內容（外來 F），另外 agent 也改了第 4 段讓請求不是零區
    await humanEdit(s.ctx, s.note.id, ed => ed.insertBlocks([{ type: "paragraph", content: "Foreign same" }], ed.document[1]!.id, "after"));
    noteRef = s.note.id;
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "Para 1\n\nForeign same").replace("Para 4", "Agent four")));
    expect(r.statusCode).toBe(200);
    expect(n).toBe(2);
    const md = await liveMarkdown(s.ctx, s.note.id);
    expect(md.split("Foreign same").length - 1).toBe(1);
  });

  it("M8f（T8-M20）判 same 所依據的外來 block 不是 sameTail（不在 anchorIds）、合併前被人改 → 只有 expectEach 抓得到 → 重試重判成 applied、agent 的內容在", async () => {
    // M8e 刪的是 sameTail（R19 會把它加進 anchorIds），所以拿掉「sameForeign 進 expectEach」時 M8e 仍會因錨點不見而重試；
    // 這案改的是外來兩顆中的第一顆（不是 tail）→ 只剩 expectEach 守。
    const ref = {} as { ctx: CollabTestCtx };
    let noteRef = "";
    let n = 0;
    const s = await scene({
      editingTestHooks: {
        beforeMerge: async () => {
          if (noteRef === "" || n++ > 0) return;
          await humanEdit(ref.ctx, noteRef, ed => {
            const f = ed.document.find(b => JSON.stringify(b.content).includes("Alpha same"));
            if (f) ed.updateBlock(f.id, { content: "Alpha human" });
          });
        },
      },
    });
    ref.ctx = s.ctx;
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.insertBlocks([{ type: "paragraph", content: "Alpha same" }, { type: "paragraph", content: "Beta same" }], ed.document[1]!.id, "after"));
    noteRef = s.note.id;
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "Para 1\n\nAlpha same\n\nBeta same").replace("Para 4", "Agent four")));
    expect(r.statusCode).toBe(200);
    expect(n).toBe(2);
    const md = await liveMarkdown(s.ctx, s.note.id);
    expect(md).toContain("Alpha human");
    expect(md.split("Alpha same").length - 1).toBe(1);
  });
});

describe("M9–M11", () => {
  it("M9 只 mount 兩次（scratch＋fork，沒有重試）；存版時 inFlight 0（熱筆記與冷筆記）", async () => {
    const inFlight: number[] = [];
    const s = await scene({ editingTestHooks: { beforeCut: async () => void inFlight.push(testEditingRuntime.inFlight) } });
    for (const cold of [false, true]) {
      const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
      await humanEdit(s.ctx, s.note.id, ed => ed.updateBlock(ed.document[2]!.id, { content: `Human ${cold}` }));
      if (cold) await settled(s.ctx);
      const m0 = testEditingRuntime.mounts;
      const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace(/Para 2|Agent false/, `Agent ${cold}`)));
      expect(r.json(), String(cold)).toMatchObject({ result: "merged" });
      expect(testEditingRuntime.mounts - m0, String(cold)).toBe(2);
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

describe("X1–X6（§14.4 守衛；plan T13）", () => {
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
    // 五形各自一區（中間夾著沒改的段 S0–S4；同一區裡連著兩組「註解＋下一行」會併成一段，見 X3b）
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

  it("X4（known-limitation F31）改帶段落子的 bullet → 寫回後巢狀消失、子段落成頂層", async () => {
    const s = await scene();
    const nid = (await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "X" })).id;
    await seedBlocks(s.ctx.db, nid, [{ type: "bulletListItem", content: "a", children: [{ type: "paragraph", content: "child" }] }, { type: "paragraph", content: "after" }]);
    const d = await downloadNote(s.ctx.app, s.bulk.token, nid);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("* a", "* a2")))).statusCode).toBe(200);
    expect((await liveBlocks(s.ctx, nid)).map(b => `${b.type}:${b.text}:${b.children}`)).toEqual(["bulletListItem:a2:0", "paragraph:child:0", "paragraph:after:0"]);
  });

  it("X5（known-limitation E14）toggle 改內容 → 寫回後變 bullet", async () => {
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
