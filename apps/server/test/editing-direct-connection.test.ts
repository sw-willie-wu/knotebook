import { describe, expect, it } from "vitest";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { withDirectConnection, type DirectCtx } from "../src/notes/editing/session.js";
import { buildCollabTestApp } from "./helpers.js";

describe("withDirectConnection", () => {
  it("開連 → transact → finally disconnect；fn 內 throw 也 disconnect 且錯誤原樣冒出；沒人在線時文件不留在記憶體", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: "correct-horse-battery" });
    const note = await ctx.createNote(u.id);
    const ctxObj: DirectCtx = { source: "ai-edit", userId: u.id, tokenId: null, agentLabel: null, applied: false };
    const seen = await withDirectConnection(ctx.collab.hocuspocus, note.id, ctxObj, doc => doc.getXmlFragment(YDOC_FRAGMENT).length);
    expect(seen).toBe(0);
    await new Promise(r => setImmediate(r));
    expect(ctx.collab.hocuspocus.documents.size).toBe(0);
    await expect(
      withDirectConnection(ctx.collab.hocuspocus, note.id, ctxObj, () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await new Promise(r => setImmediate(r));
    expect(ctx.collab.hocuspocus.documents.size).toBe(0); // finally 有 disconnect，沒漏
    expect(ctxObj.applied).toBe(false);
  });
});
