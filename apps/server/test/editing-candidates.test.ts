import { describe, expect, it } from "vitest";
import { buildCollabTestApp } from "./helpers.js";
import { visibleNoteTitles } from "../src/notes/editing/candidates.js";

describe("visibleNoteTitles", () => {
  it("含自有與被分享的筆記，不含別人未分享的筆記", async () => {
    const ctx = await buildCollabTestApp();
    const me = await ctx.createUser({ email: "me@example.com", password: "correct-horse-battery" });
    const other = await ctx.createUser({ email: "o@example.com", password: "correct-horse-battery" });
    const mine = await ctx.createNote(me.id, "Mine");
    const shared = await ctx.createNote(other.id, "Shared"); await ctx.share(shared.id, me.id, "viewer");
    await ctx.createNote(other.id, "Secret");
    const titles = (await visibleNoteTitles(ctx.db, me.id)).map(t => t.title).sort();
    expect(titles).toEqual(["Mine", "Shared"]);
    expect((await visibleNoteTitles(ctx.db, me.id)).map(t => t.id)).toContain(mine.id);
  });
});
