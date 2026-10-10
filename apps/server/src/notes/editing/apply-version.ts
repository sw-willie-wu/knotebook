/**
 * 套用版本（spec 2026-10-09-note-versions-design.md §7）。語意是「套用」不是「還原」（D6）：快照內容以 `replace_all` 帶 block JSON
 * （**id 保留**，r1 實跑）寫進活文件，經同一條 `NoteWriteQueue`（呼叫端 `NoteWriteService.applyVersion`）、**不寫 `note_ai_edits`**、
 * `DirectCtx.source = "version-apply"`。順序：讀版本列（404／version_mismatch）→ 快照轉 blocks（同步、不 mount、不取 lease）→
 * [fork → isDirty（409）→ beginApply → prepare → merge（expectFingerprint＝fork 的 whole；beforeDisconnect 寫基底）→ links]
 * ×（指紋不符重試一次，重試也重跑 isDirty）→ finally endApply。**不 record**（§7-2c）。
 */
import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, createHeadlessNoteSchema } from "@knotebook/shared";
import { clearVersionBase, setVersionBase, type VersionService } from "../../collab/versions.js";
import { noteVersions } from "../../db/schema.js";
import { FingerprintMismatch, forkAndCheck, mergeDiff, prepareEdit, updateNoteLinks, type ApplyDeps, type MergeOutput } from "./apply.js";
import type { DirectCtx } from "./session.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 apply.ts）
type AnyPartialBlock = PartialBlock<any, any, any>;

export type ApplyVersionFailureCode = "not_found" | "version_mismatch" | "version_unsaved_changes";
export interface ApplyVersionInput {
  noteId: string;
  seq: number;
  /** 已轉小寫（路由在 UUID_RE 之後轉）。 */
  versionId: string;
  userId: string;
  discardUnsaved: boolean;
}
export type ApplyVersionDeps = ApplyDeps & { versions: VersionService };

/**
 * §7-2b：快照 → blocks。`BlockNoteEditor.create` 不 mount、不取 lease（r2 實跑：runtime 建立時已 installGlobals，未 mount 的
 * editor 讀得到完整 blocks、wikilink 保留）。⚠ 建 editor 與讀 blocks 必須在**同一個同步區段**：EditingRuntime 換掉全域 window／
 * document 只會發生在某個 lease 的 release 裡，而那只可能在 await 之後——本函式沒有 await。
 * ⚠ 這條「同一個同步區段」**沒有測試守得到**（Task 8 突變 M5：兩步之間插 `await`、呼叫端改 await，`versions-apply.test.ts`
 * 照樣全綠——沒有並行的 lease 在 release；`version-blocks.test.ts` 會紅，但只因回傳變成 Promise，不是因為區段被切開），只能靠審查；
 * `version-blocks.test.ts` 第一案只驗「runtime 重建過全域之後照樣讀得到」。
 */
export function blocksFromSnapshot(baseUrl: string, ydoc: Uint8Array): AnyPartialBlock[] {
  const snapshot = new Y.Doc();
  Y.applyUpdate(snapshot, ydoc);
  const editor = BlockNoteEditor.create({ schema: createHeadlessNoteSchema(baseUrl) });
  return yXmlFragmentToBlocks(editor, snapshot.getXmlFragment(YDOC_FRAGMENT)) as AnyPartialBlock[];
}

/**
 * §7-2d：merge 的 transact 成功之後、disconnect 之前。1 列 → endApply(seq, fp)；0 列或 fp 算不出來 → 基底清空、endApply(reset)。
 * 與清除（prune）的競態：基底可能指向剛被刪掉的那一版——`setVersionBase` 的 UPDATE 帶 `WHERE EXISTS`，0 列就走這裡的 reset，
 * 不另加鎖（Task 5／7 審查裁定）。
 */
async function writeBaseAfterApply(deps: ApplyVersionDeps, input: ApplyVersionInput, out: MergeOutput): Promise<void> {
  if (deps.testHooks?.beforeVersionBase) await deps.testHooks.beforeVersionBase();
  const fp = out.versionFingerprint;
  if (fp !== null && (await setVersionBase(deps.db, input.noteId, input.seq, fp))) {
    deps.versions.endApply(input.noteId, { seq: input.seq, fingerprint: fp });
    return;
  }
  deps.log.warn({ noteId: input.noteId, seq: input.seq, fingerprintFailed: fp === null }, "套用後基底無法指向該版（版本已被刪或指紋算不出來），基底改為無");
  await clearVersionBase(deps.db, input.noteId);
  deps.versions.endApply(input.noteId, { reset: true });
}

export async function applyVersionEdit(deps: ApplyVersionDeps, input: ApplyVersionInput): Promise<{ ok: true } | { ok: false; code: ApplyVersionFailureCode }> {
  const [row] = await deps.db
    .select({ id: noteVersions.id, ydoc: noteVersions.ydoc })
    .from(noteVersions)
    .where(and(eq(noteVersions.noteId, input.noteId), eq(noteVersions.seq, input.seq)))
    .limit(1);
  if (!row) return { ok: false, code: "not_found" };
  if (row.id !== input.versionId) return { ok: false, code: "version_mismatch" }; // 跨分頁搬移後的保護（§6.4）
  const blocks = blocksFromSnapshot(deps.editing.baseUrl, row.ydoc);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const f = await forkAndCheck(deps, input.noteId);
    // §6.4／§7-2c：fork 之後 isDirty（未初始化或算不出來都視為 dirty）；重試也重跑，discardUnsaved:false 時插進來的修改在這裡就 409。
    if (!input.discardUnsaved && (await deps.versions.isDirty(input.noteId, f.fork, f.fork))) return { ok: false, code: "version_unsaved_changes" };
    deps.versions.beginApply(input.noteId);
    try {
      const prepared = await prepareEdit(
        deps,
        { noteId: input.noteId, userId: input.userId, tokenId: null, agentLabel: null, op: "replace_all", candidates: [], blocks, unbound: 0 },
        f.fork,
        f.sv,
        { op: "replace_all", isEmptyDoc: f.isEmptyDoc, section: undefined },
      );
      if ("error" in prepared) throw new Error(`套用版本時 prepare 失敗：${prepared.error}`);
      if (deps.testHooks?.beforeMerge) await deps.testHooks.beforeMerge();
      const ctx: DirectCtx = { source: "version-apply", userId: input.userId, tokenId: null, agentLabel: null, applied: false };
      const merged = await mergeDiff(
        deps,
        input.noteId,
        ctx,
        // 【r4 實跑】沒人改時 fork 與活文件的 whole 恆等；別人在既有區塊打字、新插入區塊、改屬性、改 mark 都會不符。
        { targetIds: null, expectFingerprint: f.whole, anchorId: null, diff: prepared.diff, afterIds: prepared.afterIds },
        { beforeDisconnect: out => writeBaseAfterApply(deps, input, out) },
      );
      await updateNoteLinks(deps, { sourceNoteId: input.noteId, userId: input.userId, forkDoc: f.fork, clock: merged.clock });
      return { ok: true };
    } catch (err) {
      if (err instanceof FingerprintMismatch) continue;
      throw err;
    } finally {
      deps.versions.endApply(input.noteId); // 任何一步失敗都清 applying（§7-2e）；成功路徑這是 no-op
    }
  }
  return { ok: false, code: "version_unsaved_changes" };
}
