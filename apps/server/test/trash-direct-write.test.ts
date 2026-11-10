// #181（M-B）：直連寫入的重確認統一在 `withDirectConnection`——閘門開著或筆記已在垃圾桶就丟
// `NoteGoneError`，而且在開直連之前就擋（不把文件載回記憶體）。真 hooks（`createCollabHooks`；預設 noop hooks 不開閘門，見 `test/helpers.ts` 的 `noopCollabHooks`）。
// DW3 驗那個重確認依賴的前提：直連持有文件時移入的 unload 輪詢會等，移入在寫入落盤之後才 commit。
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Document } from "@hocuspocus/server";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import { NoteGoneError, directTarget, withDirectConnection, type DirectCtx } from "../src/notes/editing/session.js";
import { loadDoc } from "./copy-helpers.js";
import { sleep } from "./group-helpers.js";
import { buildCollabTestApp, type CollabTestCtx } from "./helpers.js";
import { markRestored, markTrashed, trashCols } from "./trash-helpers.js";

const PASSWORD = "correct-horse-battery";

function buildApp(): Promise<CollabTestCtx> {
  return buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log) });
}

async function setup(email: string) {
  const ctx = await buildApp();
  const u = await ctx.createUser({ email, password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const aiCtx: DirectCtx = { source: "ai-edit", userId: u.id, tokenId: null, agentLabel: null, applied: false };
  const open = vi.spyOn(ctx.collab.hocuspocus, "openDirectConnection");
  return { ctx, u, note, aiCtx, open };
}

/** `note_states` 該篇的現值（沒有列 → undefined）。 */
async function stateOf(pool: Pool, noteId: string): Promise<{ ydoc: string; version: number } | undefined> {
  const { rows } = await pool.query<{ ydoc: string; version: number }>(
    `select encode(ydoc, 'hex') as ydoc, version from note_states where note_id = $1`,
    [noteId],
  );
  return rows[0];
}

/** 會改動文件的 fn：重確認沒擋住時，disconnect 會把這筆落盤。 */
const write = (doc: Document): string => {
  doc.getMap("dw").set("k", "v");
  return "written";
};

describe("#181 直連寫入的重確認", () => {
  it("DW1：閘門已開 → NoteGoneError，note_states 不變、未開直連", async () => {
    const { ctx, note, aiCtx, open } = await setup("dw1@example.com");
    const before = await stateOf(ctx.db.$client, note.id);

    await ctx.collab.markDeleting(note.id);
    await expect(withDirectConnection(directTarget(ctx.collab, ctx.db), note.id, aiCtx, write)).rejects.toBeInstanceOf(NoteGoneError);

    expect(open).not.toHaveBeenCalled();
    expect(await stateOf(ctx.db.$client, note.id)).toEqual(before);
  });

  it("DW2：已在垃圾桶 → NoteGoneError，note_states 不變、未開直連；還原後照常寫入", async () => {
    const { ctx, u, note, aiCtx, open } = await setup("dw2@example.com");
    const before = await stateOf(ctx.db.$client, note.id);

    await markTrashed(ctx.db.$client, note.id, u.id);
    await expect(withDirectConnection(directTarget(ctx.collab, ctx.db), note.id, aiCtx, write)).rejects.toBeInstanceOf(NoteGoneError);

    expect(open).not.toHaveBeenCalled();
    expect(await stateOf(ctx.db.$client, note.id)).toEqual(before);

    // 對照：spy 確實掛在生產用的那顆 hocuspocus 上（否則上面的「未呼叫」恆真）。
    await markRestored(ctx.db.$client, note.id);
    await expect(withDirectConnection(directTarget(ctx.collab, ctx.db), note.id, aiCtx, write)).resolves.toBe("written");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("DW3：直連持有文件期間發起移入 → 移入等到這次寫入落盤之後才 commit（M-B 前提）", async () => {
    const { ctx, note, aiCtx } = await setup("dw3@example.com");
    const session = await ctx.loginAs("dw3@example.com", PASSWORD);
    const TEXT = "DW3 直連持有中寫入的字";
    let del: Promise<Response> | undefined;
    let seenDuring: Awaited<ReturnType<typeof trashCols>>;

    const out = await withDirectConnection(
      directTarget(ctx.collab, ctx.db),
      note.id,
      aiCtx,
      doc => {
        doc.getText("dw3").insert(0, TEXT);
        return "written";
      },
      {
        beforeDisconnect: async () => {
          del = session.fetch(`/api/notes/${note.id}`, { method: "DELETE" });
          await sleep(800);
          seenDuring = await trashCols(ctx.db.$client, note.id);
        },
      },
    );

    // 前提本身：直連持有期間移入沒有 commit——unload 輪詢在等這份文件。
    expect(seenDuring!.deleted_at).toBeNull();
    expect(out).toBe("written");
    expect((await del!).status).toBe(204);
    expect((await trashCols(ctx.db.$client, note.id))?.deleted_at).not.toBeNull();
    expect((await loadDoc(ctx.db, note.id))!.getText("dw3").toString()).toBe(TEXT);
  });
});
