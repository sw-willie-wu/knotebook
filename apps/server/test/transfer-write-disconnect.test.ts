/**
 * bulk transfer plan PR-2 §0.1-11、T8（D1–D5）：S14 斷線語意——用戶端斷線**不中止寫回**、只記 `clientClosed`；偵測只掛
 * `reply.raw` 的 close（T1 探針：PUT 上 `request.raw` 的 close 在 body 讀完時就觸發）。真 HTTP（`putRaw`），不用 inject。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { noteAiEdits, transferBases } from "../src/db/schema.js";
import { buildCollabTestApp } from "./helpers.js";
import { seedTokenForUser, waitFor } from "./editing-helpers.js";
import { seedNote, seedUser, sleep } from "./group-helpers.js";
import { bulkPut, downloadNote, editBody, gate, issueBulkDirect, liveMarkdown, putRaw, seedMd } from "./bulk-transfer-helpers.js";

type Opts = Parameters<typeof buildCollabTestApp>[0];
const PARAS = (n: number) => Array.from({ length: n }, (_, i) => `Para ${i}`).join("\n\n");

async function scene(opts: Opts = {}) {
  const chunks: string[] = [];
  const ctx = await buildCollabTestApp({ logger: { level: "info", stream: { write: (x: string) => void chunks.push(x) } }, ...opts });
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
  await seedMd(ctx.db, note.id, PARAS(5));
  const writeLines = () =>
    chunks
      .flatMap(c => c.split("\n"))
      .filter(Boolean)
      .map(l => JSON.parse(l) as Record<string, unknown>)
      .filter(o => o.msg === "bulk transfer write");
  const errorLines = () => chunks.flatMap(c => c.split("\n")).filter(Boolean).map(l => JSON.parse(l) as { level: number }).filter(o => o.level >= 50);
  return { ctx, u, bulk, note, writeLines, errorLines };
}

describe("S14 斷線語意", () => {
  it("D1 正常完成 → clientClosed false", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await putRaw(s.ctx.baseUrl, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "D1 change")));
    expect(r?.status).toBe(200);
    await waitFor("log", 3_000, () => s.writeLines().length === 1);
    expect(s.writeLines()[0]).toMatchObject({ result: "applied", clientClosed: false });
  });

  it("D2 佇列中斷線 → 照常完成（筆記恰改一次、applied_body_sha 已寫）、clientClosed true、沒有 error log；同檔重送 → unchanged", async () => {
    const hold = gate();
    const entered = gate();
    const closed = gate();
    let holding = true;
    let handlers = 0;
    const s = await scene({
      editingTestHooks: {
        beforeMerge: async () => {
          if (!holding) return;
          holding = false;
          entered.open();
          await hold.wait;
        },
      },
      transferTestHooks: {
        beforeWriteHandler: async () => {
          handlers++;
        },
        onWriteClientClose: () => closed.open(),
      },
    });
    const d1 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const p1 = bulkPut(s.ctx.app, s.bulk.token, editBody(d1.text, b => b.replace("Para 1", "Occupier")));
    await entered.wait;
    const destroy = gate();
    const text2 = editBody(d2.text, b => b.replace("Para 3", "D2 change"));
    const p2 = putRaw(s.ctx.baseUrl, s.bulk.token, text2, { destroyAfter: destroy.wait });
    await waitFor("第二發進 handler", 3_000, () => handlers === 2);
    await sleep(200); // 讓它走到佇列等待
    destroy.open();
    await closed.wait;
    hold.open();
    expect((await p1).statusCode).toBe(200);
    expect(await p2).toBeNull();
    await waitFor("第二發的 log", 10_000, () => s.writeLines().length === 2);
    const second = s.writeLines()[1]!;
    expect(second).toMatchObject({ clientClosed: true });
    expect(["applied", "merged"]).toContain(second.result);
    const md = await liveMarkdown(s.ctx, s.note.id);
    expect(md.split("D2 change").length - 1).toBe(1);
    expect((await s.ctx.db.select().from(transferBases).where(eq(transferBases.key, d2.fm.base!)))[0]!.appliedBodySha).not.toBeNull();
    expect(s.errorLines()).toEqual([]);
    expect((await bulkPut(s.ctx.app, s.bulk.token, text2)).json()).toMatchObject({ result: "unchanged" });
  });

  it("D3 合併中斷線（beforeRecord 內等到 close）→ 紀錄照寫、1 列", async () => {
    const closed = gate();
    const destroy = gate();
    const s = await scene({
      editingTestHooks: {
        beforeRecord: async () => {
          destroy.open();
          await closed.wait;
        },
      },
      transferTestHooks: { onWriteClientClose: () => closed.open() },
    });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await putRaw(s.ctx.baseUrl, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "D3 change")), { destroyAfter: destroy.wait });
    expect(r).toBeNull();
    await waitFor("log", 10_000, () => s.writeLines().length === 1);
    expect(s.writeLines()[0]).toMatchObject({ result: "applied", clientClosed: true });
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id))).toHaveLength(1);
  });

  it("D4 body 送一半就斷 → 不進 handler（syncFile 沒被呼叫）、筆記與基底未變、沒有 error log", async () => {
    let merges = 0;
    let handlers = 0;
    const s = await scene({
      editingTestHooks: { beforeMerge: async () => void merges++ },
      transferTestHooks: { beforeWriteHandler: async () => void handlers++ },
    });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const before = await liveMarkdown(s.ctx, s.note.id);
    const r = await putRaw(s.ctx.baseUrl, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "D4 change")), { half: true, destroyAfter: sleep(200) });
    expect(r).toBeNull();
    await sleep(300);
    expect(handlers).toBe(0);
    expect(merges).toBe(0);
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(before);
    expect((await s.ctx.db.select().from(transferBases).where(eq(transferBases.key, d.fm.base!)))[0]!.appliedBodySha).toBeNull();
    expect(s.errorLines()).toEqual([]);
  });

  it("D5 handler 開始前就斷線 → clientClosed true（掛上監聽後補查 destroyed）", async () => {
    const entered = gate();
    const proceed = gate();
    const destroy = gate();
    const s = await scene({
      transferTestHooks: {
        beforeWriteHandler: async () => {
          entered.open();
          await proceed.wait;
        },
      },
    });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const p = putRaw(s.ctx.baseUrl, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "D5 change")), { destroyAfter: destroy.wait });
    await entered.wait;
    destroy.open();
    await sleep(200);
    proceed.open();
    expect(await p).toBeNull();
    await waitFor("log", 10_000, () => s.writeLines().length === 1);
    expect(s.writeLines()[0]).toMatchObject({ result: "applied", clientClosed: true });
  });
});
