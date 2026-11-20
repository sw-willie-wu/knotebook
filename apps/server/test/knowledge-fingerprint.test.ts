/**
 * Through the real HTTP routes, Hocuspocus persistence, bulk write-back and version apply: a document written before
 * headings carried knowledge props must keep serving the fingerprints clients already hold.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { KNOWLEDGE_PROP_NAMES, SESSION_COOKIE, YDOC_FRAGMENT, canonicalizeElements, topLevelBlocks } from "@knotebook/shared";
import { noteAiEdits, noteStates } from "../src/db/schema.js";
import { outlineOf, topLevelFingerprints, fingerprintOf } from "../src/notes/editing/fingerprint.js";
import { loadNoteDoc } from "../src/notes/editing/read.js";
import { versionFingerprint } from "../src/notes/version-fingerprint.js";
import { buildCollabTestApp, signTestSession } from "./helpers.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";
import { loadDoc, seedDoc } from "./copy-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { bulkPut, downloadNote, editBody, issueBulkDirect } from "./bulk-transfer-helpers.js";
import { buildPreUpgradeDoc, preUpgradeBlocks } from "./helpers/knowledge-docs.js";

function snapshot(doc: Y.Doc) {
  const frag = doc.getXmlFragment(YDOC_FRAGMENT);
  const { outline, whole } = outlineOf(frag);
  const tl = topLevelFingerprints(frag);
  const headingAttrs: Record<string, string[]> = {};
  for (const c of topLevelBlocks(frag)) {
    const first = c.get(0);
    if (first instanceof Y.XmlElement && first.nodeName === "heading") headingAttrs[String(c.getAttribute("id"))] = Object.keys(first.getAttributes()).sort();
  }
  return {
    sections: Object.fromEntries(outline.map((o) => [o.sectionId, o.fingerprint])),
    whole,
    perBlock: Object.fromEntries(tl.ids.map((id, i) => [id, tl.fps[i]!])),
    version: versionFingerprint(frag),
    headingAttrs,
  };
}

describe("pre-upgrade documents through the real routes", () => {
  it("a pre-upgrade note: reading keeps every fingerprint, an append changes no earlier block, an if_match from before is accepted, and a file downloaded before is written back changing only the edited paragraph", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
    const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
    const old = buildPreUpgradeDoc(preUpgradeBlocks());
    const base = snapshot(old);
    await seedDoc(ctx.db, note.id, old);

    const read = (await getContent(ctx.app, note.id, pat.token)).json() as { fingerprint: string; outline: Array<{ sectionId: string; fingerprint: string }> };
    const readSections = Object.fromEntries(read.outline.map((o) => [o.sectionId, o.fingerprint]));
    expect(read.fingerprint).toBe(base.whole);
    expect(readSections).toEqual(base.sections);
    const dl = await downloadNote(ctx.app, bulk.token, note.id);

    const put = await bulkPut(ctx.app, bulk.token, editBody(dl.text, (b) => b.replace("five", "five agent")));
    expect(put.statusCode, put.body).toBe(200);
    const afterPut = snapshot((await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, note.id)).doc);
    expect(Object.keys(base.perBlock).filter((id) => base.perBlock[id] !== afterPut.perBlock[id])).toEqual(["d1"]);

    const append = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(pat.token), payload: { op: "append", markdown: "tail paragraph" } });
    expect(append.statusCode, append.body).toBe(201);
    const afterAppend = snapshot((await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, note.id)).doc);
    expect(Object.keys(base.perBlock).filter((id) => afterPut.perBlock[id] !== afterAppend.perBlock[id])).toEqual([]);
    // The level-2 heading hE sits inside hD's section, so only hD's section fingerprint may move.
    expect(Object.keys(base.sections).filter((id) => id !== "hD" && afterPut.sections[id] !== afterAppend.sections[id])).toEqual([]);

    const ifMatch = await ctx.app.inject({
      method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(pat.token),
      payload: { op: "replace_section", section_id: "hB", if_match: base.sections.hB, markdown: "# B\n\nthree edited" },
    });
    expect(ifMatch.statusCode, ifMatch.body).toBe(201);
    await ctx.destroy();
  });

  it("applying a version whose middle section differs keeps the fingerprints of the untouched headings after it", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
    const cookie = `${SESSION_COOKIE}=${await signTestSession({ userId: u.id, tv: 0 })}`;
    const headers = { cookie, "content-type": "application/json", origin: "http://localhost:3000" };
    const blocksWith = (b1: string) => preUpgradeBlocks().map((b) => ((b as { id: string }).id === "b1" ? { id: "b1", type: "paragraph", content: b1 } : b));
    const original = buildPreUpgradeDoc(blocksWith("three"));
    await seedDoc(ctx.db, note.id, original);
    const base = snapshot(original);

    const saved = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/versions`, headers, payload: {} });
    expect(saved.statusCode, saved.body).toBe(201);

    const changed = buildPreUpgradeDoc(blocksWith("three changed"));
    await ctx.db.update(noteStates).set({ ydoc: Buffer.from(Y.encodeStateAsUpdate(changed)) }).where(eq(noteStates.noteId, note.id));
    const before = snapshot(changed);
    expect(before.perBlock.b1).not.toBe(base.perBlock.b1);

    const applied = await ctx.app.inject({
      method: "POST", url: `/api/notes/${note.id}/versions/${saved.json().seq}/apply`, headers, payload: { versionId: saved.json().id, discardUnsaved: true },
    });
    expect(applied.statusCode, applied.body).toBeLessThan(300);

    const doc = (await loadDoc(ctx.db, note.id))!;
    const after = snapshot(doc);
    expect(after.perBlock.b1).toBe(base.perBlock.b1);
    for (const id of ["hC", "hD", "hE"]) {
      expect(after.perBlock[id], id).toBe(before.perBlock[id]);
      expect(after.sections[id], id).toBe(before.sections[id]);
    }
    // The heading elements after the differing section were rewritten by the restore, so equality here rests on the ignore rule and not on nothing having been written.
    for (const id of ["hC", "hD", "hE"]) expect(after.headingAttrs[id], id).toEqual(expect.arrayContaining([...KNOWLEDGE_PROP_NAMES]));
    const containers = topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT));
    const canon = (id: string) => canonicalizeElements([containers.find((c) => c.getAttribute("id") === id)!]);
    expect(fingerprintOf(canon("hC"))).toBe(fingerprintOf(canonicalizeElements([topLevelBlocks(changed.getXmlFragment(YDOC_FRAGMENT)).find((c) => c.getAttribute("id") === "hC")!])));
    await ctx.destroy();
  });

  it("a bulk write-back whose heading line parses to the same content is unchanged: nothing is applied, no AI record, no knowledge attribute written", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
    const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
    await seedDoc(ctx.db, note.id, buildPreUpgradeDoc(preUpgradeBlocks()));
    const dl = await downloadNote(ctx.app, bulk.token, note.id);
    const edited = editBody(dl.text, (b) => b.replace(/^# D$/m, "#   D"));
    expect(edited).not.toBe(dl.text);

    const put = await bulkPut(ctx.app, bulk.token, edited);
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ applied: 0 });
    expect((put.json() as { same: number }).same).toBeGreaterThanOrEqual(1);
    expect(await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id))).toHaveLength(0);
    const after = (await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, note.id)).doc;
    const hD = topLevelBlocks(after.getXmlFragment(YDOC_FRAGMENT)).find((c) => c.getAttribute("id") === "hD")!.get(0) as Y.XmlElement;
    expect(Object.keys(hD.getAttributes()).filter((k) => k.startsWith("knowledge"))).toEqual([]);
    await ctx.destroy();
  });
});
