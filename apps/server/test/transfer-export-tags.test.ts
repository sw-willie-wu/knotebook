import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { transferBases } from "../src/db/schema.js";
import { deriveTransferKey, hmacOf } from "../src/transfer/base-hash.js";
import { tagsKeyOf } from "../src/transfer/note-tags-format.js";
import { buildCollabTestApp, testConfig } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { seedGroup, seedNote, seedShare, seedUser } from "./group-helpers.js";
import { downloadNote, issueBulkDirect, seedMd, seedNoteTags } from "./bulk-transfer-helpers.js";

async function scene() {
  const ctx = await buildCollabTestApp();
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId);
  return { ctx, u, pat, bulk };
}

describe("downloaded file tags", () => {
  it("a downloaded file has the note's tags in added order; a note without tags has tags: []", async () => {
    const s = await scene();
    const n = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "T" });
    const bare = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "Bare" });
    await seedMd(s.ctx.db, n.id, "para");
    await seedMd(s.ctx.db, bare.id, "para");
    await seedNoteTags(s.ctx.db, n.id, ["影像", "AWS", "roadeye"], s.u.id);
    const d = await downloadNote(s.ctx.app, s.bulk.token, n.id);
    expect(d.fm.tags).toBe('["影像", "AWS", "roadeye"]');
    expect(d.text.split("\n")[4]).toBe('tags: ["影像", "AWS", "roadeye"]');
    expect((await downloadNote(s.ctx.app, s.bulk.token, bare.id)).fm.tags).toBe("[]");
  });

  it("a fetched note's base stores the hash of the tags in the file", async () => {
    const s = await scene();
    const n = await seedNote(s.ctx.db, { ownerId: s.u.id });
    await seedMd(s.ctx.db, n.id, "para");
    await seedNoteTags(s.ctx.db, n.id, ["B", "a"], s.u.id);
    const d = await downloadNote(s.ctx.app, s.bulk.token, n.id);
    const [base] = await s.ctx.db.select().from(transferBases).where(eq(transferBases.key, d.fm.base!));
    const key = deriveTransferKey(testConfig.appSecret);
    expect(Buffer.from(base!.tagsSha!).equals(hmacOf(key, Buffer.from(base!.salt), tagsKeyOf(["a", "b"])))).toBe(true);
    expect(base!.appliedTagsSha).toBeNull();
  });

  it("a share viewer's download shows the owner's tags", async () => {
    const s = await scene();
    const owner = await seedUser(s.ctx.db);
    const n = await seedNote(s.ctx.db, { ownerId: owner.id });
    await seedMd(s.ctx.db, n.id, "para");
    await seedNoteTags(s.ctx.db, n.id, ["alpha"], owner.id);
    await seedShare(s.ctx.db, n.id, s.u.id, "viewer");
    expect((await downloadNote(s.ctx.app, s.bulk.token, n.id)).fm.tags).toBe('["alpha"]');
  });

  it("a group note shows the group's tags only for that note and never another note's", async () => {
    const s = await scene();
    const g = await seedGroup(s.ctx.db, "G", [{ userId: s.u.id, role: "member" }]);
    const a = await seedNote(s.ctx.db, { groupId: g.id }, { title: "A" });
    const b = await seedNote(s.ctx.db, { groupId: g.id }, { title: "B" });
    await seedMd(s.ctx.db, a.id, "para");
    await seedMd(s.ctx.db, b.id, "para");
    await seedNoteTags(s.ctx.db, a.id, ["only-a"], s.u.id);
    await seedNoteTags(s.ctx.db, b.id, ["only-b"], s.u.id);
    expect((await downloadNote(s.ctx.app, s.bulk.token, a.id)).fm.tags).toBe('["only-a"]');
    expect((await downloadNote(s.ctx.app, s.bulk.token, b.id)).fm.tags).toBe('["only-b"]');
  });

  it("a name with U+0085 and U+2028 is written escaped on one line", async () => {
    const s = await scene();
    const n = await seedNote(s.ctx.db, { ownerId: s.u.id });
    await seedMd(s.ctx.db, n.id, "para");
    await seedNoteTags(s.ctx.db, n.id, ["a\u0085b", "c\u2028d"], s.u.id);
    const d = await downloadNote(s.ctx.app, s.bulk.token, n.id);
    expect(d.fm.tags).toBe('["a\\u0085b", "c\\u2028d"]');
    expect(d.text).not.toMatch(/[\u0085\u2028]/);
  });
});
