import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { noteAiEdits, noteLinkConversion, noteLinks, notes, users } from "../src/db/schema.js";
import { LINK_CONVERSION_VERSION_NAME, runLinkConversion, type LinkConversionDeps } from "../src/notes/link-conversion.js";
import { buildCollabTestApp, testConfig, type CollabTestCtx } from "./helpers.js";
import { loadDoc, seedDoc, wikilinkDoc } from "./copy-helpers.js";
import { seedGroup, seedNote, seedShare } from "./group-helpers.js";
import { seedOldNote, versionsOf } from "./version-helpers.js";

// spec 2026-10-13 site-links §12、§15.2 I3；Review Focus RF5。
const PASSWORD = "correct-horse-battery";
const ORIGIN = testConfig.publicUrl.origin;

type Ctx = CollabTestCtx;
function depsOf(ctx: Ctx): LinkConversionDeps {
  return ctx.app.linkConversion.deps!;
}
async function run(ctx: Ctx, deps: LinkConversionDeps = depsOf(ctx), signal = new AbortController().signal) {
  return runLinkConversion(deps, { signal, batchSize: 50 });
}
async function pending(ctx: Ctx, noteId: string): Promise<void> {
  await ctx.db.insert(noteLinkConversion).values({ noteId, status: "pending" });
}
async function statusOf(ctx: Ctx, noteId: string) {
  const [r] = await ctx.db.select().from(noteLinkConversion).where(eq(noteLinkConversion.noteId, noteId));
  return r ? { status: r.status, attempts: r.attempts, converted: r.converted, unresolved: r.unresolved } : null;
}
function wikilinks(doc: Y.Doc): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const n of doc.getXmlFragment(YDOC_FRAGMENT).createTreeWalker(x => x instanceof Y.XmlElement && x.nodeName === "wikilink")) out.push((n as Y.XmlElement).getAttributes());
  return out;
}
function linkHrefs(doc: Y.Doc): string[] {
  const out: string[] = [];
  for (const n of doc.getXmlFragment(YDOC_FRAGMENT).createTreeWalker(x => x instanceof Y.XmlText)) {
    for (const op of (n as Y.XmlText).toDelta() as Array<{ attributes?: { link?: { href: string } } }>) if (op.attributes?.link) out.push(op.attributes.link.href);
  }
  return out;
}
/** 頂層 block 的 Yjs item id（client:clock）——同一個 id ＝ 沒被重寫。 */
function itemIdOf(doc: Y.Doc, index: number): string {
  const c = topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT))[index] as unknown as { _item: { id: { client: number; clock: number } } };
  return `${c._item.id.client}:${c._item.id.clock}`;
}
async function linksOf(ctx: Ctx, noteId: string): Promise<string[]> {
  return (await ctx.db.select({ t: noteLinks.targetNoteId }).from(noteLinks).where(eq(noteLinks.sourceNoteId, noteId))).map(r => r.t).sort();
}
/** 版本列的快照（note_versions.ydoc）解回 Y.Doc。 */
function versionDoc(row: { ydoc: Uint8Array }): Y.Doc {
  const d = new Y.Doc();
  Y.applyUpdate(d, new Uint8Array(row.ydoc));
  return d;
}
/** 收 warn 的 log（M3：非例外的 retry 也要有一行 warn）。 */
function spyLog(): { log: LinkConversionDeps["log"]; warns: Array<Record<string, unknown>> } {
  const warns: Array<Record<string, unknown>> = [];
  return { warns, log: { info: () => {}, warn: (o: object) => void warns.push(o as Record<string, unknown>), error: () => {} } };
}

describe("#269 I3 一次性站內連結轉換", () => {
  it("個人筆記：owner 看得到的轉、看不到的留、表格轉、樣式丟；先存「連結轉換前」；note_links 只增；不落款、不寫 AI 紀錄；未動的 block 不重寫；標 done", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-a@example.com", password: PASSWORD });
    const bob = await ctx.createUser({ email: "lc-b@example.com", password: PASSWORD });
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A", slug: "a" });
    const shared = await seedNote(ctx.db, { ownerId: bob.id }, { title: "Shared" });
    await seedShare(ctx.db, shared.id, alice.id, "viewer");
    const secret = await seedNote(ctx.db, { ownerId: bob.id }, { title: "Secret" });
    const host = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Host" });
    const [{ handle }] = await ctx.db.select({ handle: users.handle }).from(users).where(eq(users.id, alice.id));
    await seedOldNote(ctx.db, host.id, [
      "untouched paragraph",
      "",
      `see [A](/n/${handle}/a) and [**b**old](${ORIGIN}/notes/${a.id}#b-h1) and [s](/notes/${shared.id}) and [x](/notes/${secret.id})`,
      "",
      "| c |",
      "| --- |",
      `| [t](/notes/${a.id}) |`,
    ].join("\n"));
    await pending(ctx, host.id);
    const before = (await loadDoc(ctx.db, host.id))!;
    const untouchedBefore = itemIdOf(before, 0);

    const summary = await run(ctx);

    const doc = (await loadDoc(ctx.db, host.id))!;
    const wl = wikilinks(doc);
    expect(wl.map(w => [w.targetNoteId, w.label ?? "", w.anchorBlockId ?? ""])).toEqual([
      [a.id, "", ""],
      [a.id, "bold", "h1"],
      [shared.id, "s", ""],
      [a.id, "t", ""],
    ]);
    expect(linkHrefs(doc)).toEqual([`/notes/${secret.id}`]);
    expect(itemIdOf(doc, 0)).toBe(untouchedBefore);
    // plan gate r1 I1：只斷言 manual 列（spec §15.2 I3／M5：不斷言轉換後的切版時機——#272 前離線即切 auto、#272 後交給掃描器）。
    const manual = (await versionsOf(ctx.db, host.id)).filter(v => v.kind === "manual");
    expect(manual.map(v => v.name)).toEqual([LINK_CONVERSION_VERSION_NAME]);
    // 那一版是轉換「前」切的：快照裡沒有 wikilink、仍是原本的一般連結。
    const snap = versionDoc(manual[0]!);
    expect(wikilinks(snap)).toEqual([]);
    expect(new Set(linkHrefs(snap))).toEqual(new Set([`/n/${handle}/a`, `${ORIGIN}/notes/${a.id}#b-h1`, `/notes/${shared.id}`, `/notes/${secret.id}`, `/notes/${a.id}`]));
    expect(await linksOf(ctx, host.id)).toEqual([a.id, shared.id].sort());
    const [n] = await ctx.db.select({ at: notes.lastEditedAt, by: notes.lastEditedBy }).from(notes).where(eq(notes.id, host.id));
    expect(n).toEqual({ at: null, by: null });
    expect(await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, host.id))).toEqual([]);
    expect(await statusOf(ctx, host.id)).toEqual({ status: "done", attempts: 0, converted: 4, unresolved: 1 });
    expect(summary).toMatchObject({ scanned: 1, notesConverted: 1, linksConverted: 4, unresolved: 1, retry: 0, failed: 0 });
  });

  it("群組筆記：只轉目標在同一群組的連結；他群組與 /n/ 個人筆記留（E9'）", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-g@example.com", password: PASSWORD });
    const g = await seedGroup(ctx.db, "G", [{ userId: alice.id, role: "admin" }]);
    const h = await seedGroup(ctx.db, "H", [{ userId: alice.id, role: "admin" }]);
    const same = await seedNote(ctx.db, { groupId: g.id }, { title: "Same", slug: "same" });
    const otherGroup = await seedNote(ctx.db, { groupId: h.id }, { title: "Other", slug: "other" });
    const personal = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Mine", slug: "mine" });
    const [{ handle }] = await ctx.db.select({ handle: users.handle }).from(users).where(eq(users.id, alice.id));
    const host = await seedNote(ctx.db, { groupId: g.id }, { title: "Host" });
    await seedOldNote(ctx.db, host.id, `[s](/g/${g.id}/same) [o](/g/${h.id}/other) [m](/n/${handle}/mine)`);
    await pending(ctx, host.id);
    await run(ctx);
    const doc = (await loadDoc(ctx.db, host.id))!;
    expect(wikilinks(doc).map(w => w.targetNoteId)).toEqual([same.id]);
    expect(linkHrefs(doc)).toEqual([`/g/${h.id}/other`, `/n/${handle}/mine`]);
    expect(await linksOf(ctx, host.id)).toEqual([same.id]);
    expect([otherGroup.id, personal.id].every(id => !wikilinks(doc).some(w => w.targetNoteId === id))).toBe(true);
  });

  it("「連結轉換前」：基底同內容且使用者已命名 → 名字不變、不多一列（O8）；基底沒名字 → 換成「連結轉換前」", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-v@example.com", password: PASSWORD });
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A" });
    const named = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Named" });
    const unnamed = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Unnamed" });
    for (const n of [named, unnamed]) {
      await seedOldNote(ctx.db, n.id, `[x](/notes/${a.id})`);
      await pending(ctx, n.id);
    }
    const versions = depsOf(ctx).versions;
    for (const [n, name] of [[named, "My name"], [unnamed, null]] as const) {
      const { doc, transient } = await versions.docFor(n.id);
      // PF-W2：兩篇都用 manual（unnamed 帶 name: null）——未載入筆記的無基底 auto 一律判 clean 回 null，前置會失敗。
      const r = await versions.cutIfDirty(n.id, doc, { kind: "manual", name, transient });
      expect(r && "row" in r).toBe(true);
    }
    await run(ctx);
    // plan gate r1 I1：只看 manual 列（轉換後的 auto 切版時機不斷言）；manual 那一列的快照仍是一般連結。
    const manualOf = async (id: string) => (await versionsOf(ctx.db, id)).filter(v => v.kind === "manual");
    const namedManual = await manualOf(named.id);
    expect(namedManual.map(v => v.name)).toEqual(["My name"]);
    expect(wikilinks(versionDoc(namedManual[0]!))).toEqual([]);
    const unnamedManual = await manualOf(unnamed.id);
    expect(unnamedManual.map(v => v.name)).toEqual([LINK_CONVERSION_VERSION_NAME]);
    expect(wikilinks(versionDoc(unnamedManual[0]!))).toEqual([]);
  });

  it("重跑：已 done 的不再處理；把列改回 pending 後重跑——內容零寫入、note_links 只補缺；合併已落盤但 note_links 沒寫的篇（預掃為 0）補上連結列", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-r@example.com", password: PASSWORD });
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A" });
    const host = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Host" });
    await seedOldNote(ctx.db, host.id, `[x](/notes/${a.id})`);
    await pending(ctx, host.id);
    await run(ctx);
    // PF-W3：已 done 的列不再是候選——同樣狀態再跑一輪，一篇都不碰。
    expect((await run(ctx)).scanned).toBe(0);
    const versionsAfterFirst = await versionsOf(ctx.db, host.id);
    const bytes1 = Buffer.from(Y.encodeStateAsUpdate((await loadDoc(ctx.db, host.id))!)).toString("base64");
    await ctx.db.delete(noteLinks).where(eq(noteLinks.sourceNoteId, host.id));
    await ctx.db.update(noteLinkConversion).set({ status: "pending" }).where(eq(noteLinkConversion.noteId, host.id));
    const second = await run(ctx);
    expect(Buffer.from(Y.encodeStateAsUpdate((await loadDoc(ctx.db, host.id))!)).toString("base64")).toBe(bytes1);
    expect(await linksOf(ctx, host.id)).toEqual([a.id]);
    expect(second).toMatchObject({ scanned: 1, notesConverted: 0, linksConverted: 0 });
    // plan gate r1 I1：第二輪沒有站內一般連結 ⇒ 不再存版本——比前後，不斷言總數（第一輪之後的 auto 切版依 #272 是否已 merge 而不同）。
    const versionsAfterSecond = await versionsOf(ctx.db, host.id);
    expect(versionsAfterSecond.map(v => v.id)).toEqual(versionsAfterFirst.map(v => v.id));
    expect(versionsAfterSecond.filter(v => v.name === LINK_CONVERSION_VERSION_NAME)).toHaveLength(1);

    const already = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Already" });
    await seedDoc(ctx.db, already.id, wikilinkDoc([a.id]));
    await pending(ctx, already.id);
    await run(ctx);
    expect(await linksOf(ctx, already.id)).toEqual([a.id]);
    expect(await statusOf(ctx, already.id)).toMatchObject({ status: "done" });
  });

  it("FingerprintMismatch 兩次 → retry（attempts 1）、內容不變", async () => {
    let target = "";
    let aliceId = "";
    let ctxRef: Ctx | null = null;
    let mergeAttempts = 0;
    const ctx = await buildCollabTestApp({
      editingTestHooks: {
        beforeMerge: async () => {
          mergeAttempts += 1;
          // 合併前在活文件插一段：整篇指紋必不符（apply-version 的 r4 實跑結論）。
          const direct = await ctxRef!.collab.hocuspocus.openDirectConnection(target, { userId: aliceId });
          await direct.transact(doc => {
            const g = doc.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement;
            const c = new Y.XmlElement("blockContainer");
            c.setAttribute("id", `ins-${Math.random().toString(36).slice(2)}`);
            c.insert(0, [new Y.XmlElement("paragraph")]);
            g.insert(g.length, [c]);
          });
          await direct.disconnect();
        },
      },
    });
    ctxRef = ctx;
    const alice = await ctx.createUser({ email: "lc-f@example.com", password: PASSWORD });
    aliceId = alice.id;
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A" });
    const host = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Host" });
    target = host.id;
    await seedOldNote(ctx.db, host.id, `[x](/notes/${a.id})`);
    await pending(ctx, host.id);
    const spy = spyLog();
    await run(ctx, { ...depsOf(ctx), log: spy.log });
    // spec §12.3-6：指紋不符「從步 1 重來一次」——恰好合併兩次（不重來、或重來兩次以上都紅）。
    expect(mergeAttempts).toBe(2);
    expect(await statusOf(ctx, host.id)).toMatchObject({ status: "retry", attempts: 1 });
    expect(wikilinks((await loadDoc(ctx.db, host.id))!)).toEqual([]);
    // M3（spec §12.5）：非例外的 retry 也有一行 warn，形狀只有 { noteId, stage, err }（不含 href／標題／文字）。
    expect(spy.warns).toEqual([{ noteId: host.id, stage: "merge", err: "fingerprint-mismatch" }]);
  });

  it("uninitialized → retry；非預期例外 → retry，第 3 次 → failed，之後不再處理", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-u@example.com", password: PASSWORD });
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A" });
    const h1 = await seedNote(ctx.db, { ownerId: alice.id }, { title: "H1" });
    await seedOldNote(ctx.db, h1.id, `[x](/notes/${a.id})`);
    await pending(ctx, h1.id);
    const real = depsOf(ctx);
    const spy = spyLog();
    await run(ctx, { ...real, log: spy.log, versions: { docFor: real.versions.docFor, cutIfDirty: async () => ({ skipped: "uninitialized" as const }) } });
    expect(await statusOf(ctx, h1.id)).toMatchObject({ status: "retry", attempts: 1 });
    expect(spy.warns).toEqual([{ noteId: h1.id, stage: "version", err: "version-skipped" }]); // M3

    const throwing = { ...real, versions: { docFor: real.versions.docFor, cutIfDirty: async () => { throw new Error("boom"); } } };
    await run(ctx, throwing);
    expect(await statusOf(ctx, h1.id)).toMatchObject({ status: "retry", attempts: 2 });
    await run(ctx, throwing);
    expect(await statusOf(ctx, h1.id)).toMatchObject({ status: "failed", attempts: 3 });
    const fourth = await run(ctx, throwing);
    expect(fourth.scanned).toBe(0);
  });

  it("PF-W4：attempts 已達 3 的 retry 列（手寫）不是候選——不處理、狀態不變、內容不變", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-m@example.com", password: PASSWORD });
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A" });
    const host = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Host" });
    await seedOldNote(ctx.db, host.id, `[x](/notes/${a.id})`);
    await ctx.db.insert(noteLinkConversion).values({ noteId: host.id, status: "retry", attempts: 3 });
    const summary = await run(ctx);
    expect(summary.scanned).toBe(0);
    expect(await statusOf(ctx, host.id)).toEqual({ status: "retry", attempts: 3, converted: 0, unresolved: 0 });
    expect(linkHrefs((await loadDoc(ctx.db, host.id))!)).toEqual([`/notes/${a.id}`]);
    expect(await versionsOf(ctx.db, host.id)).toEqual([]);
  });

  it("abort 中途：在途那篇不留標記（維持 pending）、內容不變", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-x@example.com", password: PASSWORD });
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A" });
    const host = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Host" });
    await seedOldNote(ctx.db, host.id, `[x](/notes/${a.id})`);
    await pending(ctx, host.id);
    const controller = new AbortController();
    const real = depsOf(ctx);
    const aborting = {
      ...real,
      versions: {
        docFor: real.versions.docFor,
        cutIfDirty: async (...args: Parameters<typeof real.versions.cutIfDirty>) => {
          controller.abort();
          return real.versions.cutIfDirty(...args);
        },
      },
    };
    await run(ctx, aborting, controller.signal);
    expect(await statusOf(ctx, host.id)).toEqual({ status: "pending", attempts: 0, converted: 0, unresolved: 0 });
    expect(wikilinks((await loadDoc(ctx.db, host.id))!)).toEqual([]);
  });

  it("migration 之後才建立的筆記（沒有列）永遠不被處理、不切「連結轉換前」（N2）", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-n@example.com", password: PASSWORD });
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A" });
    const late = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Late" });
    await seedOldNote(ctx.db, late.id, `[x](/notes/${a.id})`);
    const summary = await run(ctx);
    expect(summary.scanned).toBe(0);
    expect(linkHrefs((await loadDoc(ctx.db, late.id))!)).toEqual([`/notes/${a.id}`]);
    expect(await versionsOf(ctx.db, late.id)).toEqual([]);
  });

  it("RF5：指向自己的站內一般連結 → 轉成自連結 wikilink；note_links 不寫自己；標 done", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "lc-s@example.com", password: PASSWORD });
    const self = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Self", slug: "self" });
    const [{ handle }] = await ctx.db.select({ handle: users.handle }).from(users).where(eq(users.id, alice.id));
    await seedOldNote(ctx.db, self.id, `[top](/notes/${self.id}#b-abc) [me](/n/${handle}/self)`);
    await pending(ctx, self.id);
    await run(ctx);
    expect(wikilinks((await loadDoc(ctx.db, self.id))!).map(w => w.targetNoteId)).toEqual([self.id, self.id]);
    expect(await linksOf(ctx, self.id)).toEqual([]);
    expect(await statusOf(ctx, self.id)).toMatchObject({ status: "done", converted: 2 });
  });
});
