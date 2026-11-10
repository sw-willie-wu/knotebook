import { describe, expect, it } from "vitest";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import { buildCollabTestApp, type CollabTestCtx } from "./helpers.js";
import { markTrashed } from "./trash-helpers.js";

const PASSWORD = "correct-horse-battery";

/** #181：真 hooks，雖然這兩案只直接呼叫 `ctx.collab`。 */
function buildApp(): Promise<CollabTestCtx> {
  return buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log) });
}

describe("#181 共編刪除閘門與垃圾桶", () => {
  it("CG1：isDeleting 照實反映閘門（mark 前 false、mark 後 true、unmark 後 false）", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-cg1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);

    expect(ctx.collab.isDeleting(note.id)).toBe(false);
    await ctx.collab.markDeleting(note.id);
    expect(ctx.collab.isDeleting(note.id)).toBe(true);
    ctx.collab.unmarkDeleting(note.id);
    expect(ctx.collab.isDeleting(note.id)).toBe(false);
  });

  it("CG2：releaseDeletingGate 對垃圾桶筆記不收門；活筆記照收", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-cg2@example.com", password: PASSWORD });
    const trashed = await ctx.createNote(owner.id);
    const live = await ctx.createNote(owner.id);

    // 先到的那次 DELETE 成功移入；後到、交易內得 404 的那次 release 不得收掉閘門。
    const epoch = await ctx.collab.markDeleting(trashed.id);
    await markTrashed(ctx.db.$client, trashed.id, owner.id);
    await expect(ctx.collab.releaseDeletingGate(trashed.id, epoch)).resolves.toBe(false);
    expect(ctx.collab.isDeleting(trashed.id)).toBe(true);

    const liveEpoch = await ctx.collab.markDeleting(live.id);
    await expect(ctx.collab.releaseDeletingGate(live.id, liveEpoch)).resolves.toBe(true);
    expect(ctx.collab.isDeleting(live.id)).toBe(false);
  });
});
