// 撤回：stale 判準＝revertable（live doc 在 transact 內再核對一次）；anchor 三規則（delete_section 沒有指紋可比，
// 錨點旁被改過也判得回——docs 明講）；撤回列 before_blocks＝被撤掉的 AI block、after_block_ids＝插回的原 id；
// 撤回列永不可撤回；撤回後同 apply.ts 更新 note_links。
// ⚠ `revert_of` 是 ON DELETE CASCADE，與裁切（RETENTION）交互：撤回**最舊那一筆**時，插入撤回列後
// 原列剛好被裁掉，撤回列跟著 CASCADE 消失（總數 99 不是 100）；同一個機制也讓一次普通寫入的裁切
// 連帶刪掉一列還在窗口內的撤回紀錄（原列被裁 → 撤回列 CASCADE）。所以「保留 100 筆」實為「最多 100 筆」。
import { and, desc, eq, isNull, ne, notInArray, sql } from "drizzle-orm";
import { YDOC_FRAGMENT, sectionize, type NoteEditDto } from "@knotebook/shared";
import type { CollabServer } from "../../collab/server.js";
import type { Db } from "../../db/index.js";
import { apiTokens, noteAiEdits, users } from "../../db/schema.js";
import { agentLabelOf } from "../../auth/agent-label.js";
import { readAvatarRefs } from "../../avatars/read.js";
import { DOC_MERGE_ATTEMPTS, RETENTION, StaleBase, mergeAtBase, recordableAfter, updateNoteLinks, type ApplyDeps, type MergeOutput } from "./apply.js";
import { DOC_TOO_COMPLEX } from "./doc-jobs.js";
import { ParserBusyError } from "./parse-core.js";
import { loadNoteDoc, loadNoteState } from "./read.js";
import { editRevertable, topLevelIds, type Anchor, type RevertRow } from "./revert-core.js";
import type { DirectCtx } from "./session.js";

export { isDeleteShape } from "./revert-core.js";


// 現值運算式不在這裡複製一份——`auth/agent-label.ts` 的 `agentLabelOf` 是唯一實作，
// 派生表釘在 test/unit/agent-label.test.ts。這裡用的是**純述詞**版而不是路由端的 `currentAgentLabel`：
// 這一發 JOIN 一次撈最多 100 列，逐列再查一次 DB 就是 N+1。

export async function listEdits(deps: { db: Db; collab?: CollabServer }, noteId: string): Promise<NoteEditDto[]> {
  // ⚠ **逐欄選取，不要 `select({ e: noteAiEdits, … })`**：整張表包含 `before_blocks`，那是每一次
  // 修改的**完整前置 block 快照**（`before_blocks` 無上限，最壞 100 × 筆記大小）。回應完全用不到它，
  // 整表撈就是每次列出都把最多 100 份完整筆記快照從 pg 拉過來、反序列化、然後丟掉。
  // 這裡列出的欄位＝`NoteEditDto` 與 `revertable`／`heading` 推導**實際需要**的全部；
  // 日後 DTO 加欄位要在這裡一起加（漏加是 typecheck 紅，不是靜默）。
  // ⚠ 存活突變：**沒有測試會因為改回整表撈而變紅**（行為等價，差的只是每次列出多拉最多 100 份
  // 完整筆記快照），只能靠審查看程式碼，這裡誠實記下。
  const rows = await deps.db.select({
    id: noteAiEdits.id, userId: noteAiEdits.userId, op: noteAiEdits.op, sectionId: noteAiEdits.sectionId, tokenId: noteAiEdits.tokenId,
    agentLabelSnapshot: noteAiEdits.agentLabel, afterBlockIds: noteAiEdits.afterBlockIds, afterFingerprint: noteAiEdits.afterFingerprint,
    anchor: noteAiEdits.anchor, revertOf: noteAiEdits.revertOf, revertedAt: noteAiEdits.revertedAt, createdAt: noteAiEdits.createdAt,
    handle: users.handle, tokenName: apiTokens.name, tokenLabel: apiTokens.agentLabel,
    // `editRevertable` 的 delete_section 第 2 條要 `before_blocks` 的 **id**，但整欄是完整 block 快照。
    // 在 SQL 端就抽成 `text[]`，回應線上只走 id：既拿得到判準要的東西，又不違反上面那條
    // 「不要整欄撈 before_blocks」。`case` 讓非 delete_section 的列連 detoast 都不做（pg 的
    // CASE 是惰性求值），所以最壞情況只有 delete_section 那幾列付這個成本。
    // 條件＝`isDeleteShape` 的 SQL 版（delete_section，或 file_sync 且有 anchor）。
    beforeBlockIds: sql<string[]>`case when ${noteAiEdits.op} = 'delete_section' or (${noteAiEdits.op} = 'file_sync' and ${noteAiEdits.anchor} is not null) then coalesce((select array_agg(b->>'id') from jsonb_array_elements(${noteAiEdits.beforeBlocks}) as b), '{}'::text[]) else '{}'::text[] end`,
  })
    .from(noteAiEdits).innerJoin(users, eq(users.id, noteAiEdits.userId)).leftJoin(apiTokens, eq(apiTokens.id, noteAiEdits.tokenId))
    .where(eq(noteAiEdits.noteId, noteId)).orderBy(desc(noteAiEdits.createdAt), desc(noteAiEdits.id));
  const avatars = await readAvatarRefs(deps.db, rows.map(e => e.userId));
  const { doc } = await loadNoteDoc(deps, noteId);
  const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
  const topIds = topLevelIds(fragment);
  const sections = sectionize(fragment);
  return rows.map(e => {
    const anchor = e.anchor as Anchor | null;
    // 顯示側與放行側（`revertEdit`）吃同一顆述詞、同一種 `topIds` 形狀。
    const revertable = e.op !== "revert" && e.revertedAt === null && editRevertable(
      { op: e.op, afterBlockIds: e.afterBlockIds, afterFingerprint: e.afterFingerprint, anchorId: anchor?.block_id ?? null, beforeIds: e.beforeBlockIds },
      fragment, topIds,
    );
    const probe = e.afterBlockIds[0] ?? anchor?.block_id;
    const heading = probe === undefined ? "" : sections.find(s => s.blockIds.includes(probe))?.heading ?? "";
    const agentLabel = e.tokenId !== null && e.tokenName !== null ? agentLabelOf({ agentLabel: e.tokenLabel, name: e.tokenName }) : e.agentLabelSnapshot;
    return { id: e.id, op: e.op as NoteEditDto["op"], sectionId: e.sectionId, heading, byHandle: e.handle, agentLabel, avatar: avatars.get(e.userId) ?? null, createdAt: e.createdAt.toISOString(), revertedAt: e.revertedAt?.toISOString() ?? null, revertOf: e.revertOf, revertable };
  });
}

export type RevertResult = { ok: true; editId: string; fingerprint: string; outline: MergeOutput["outline"] } | { ok: false; code: "not_found" | "already_reverted" | "stale" | "too_complex" };

export async function revertEdit(deps: ApplyDeps, input: { noteId: string; editId: string; userId: string; tokenId: string | null; agentLabel: string | null }): Promise<RevertResult> {
  const [row] = await deps.db.select().from(noteAiEdits).where(and(eq(noteAiEdits.id, input.editId), eq(noteAiEdits.noteId, input.noteId)));
  if (!row) return { ok: false, code: "not_found" };
  if (row.op === "revert" || row.revertedAt !== null) return { ok: false, code: "already_reverted" };
  const anchor = row.anchor as Anchor | null;
  // file_sync 刪除形的佔位空段落，只有在「同一篇沒有其他未撤回的列也用它當 anchor」時才刪——在取 lease 之前查好。
  const othersShareAnchor =
    row.op === "file_sync" && anchor?.placeholder === true
      ? (
          await deps.db
            .select({ id: noteAiEdits.id })
            .from(noteAiEdits)
            .where(and(eq(noteAiEdits.noteId, input.noteId), ne(noteAiEdits.id, row.id), isNull(noteAiEdits.revertedAt), sql`${noteAiEdits.anchor}->>'block_id' = ${anchor.block_id}`))
            .limit(1)
        ).length > 0
      : false;
  const revertRow: RevertRow = { op: row.op, afterBlockIds: row.afterBlockIds, afterFingerprint: row.afterFingerprint, beforeBlocks: row.beforeBlocks as unknown[], anchor };
  // stale 判準（與 `listEdits` 同一顆 `editRevertable`）與編輯器那一段在 worker 裡、對文件狀態做（`doc-jobs.ts`）；合併只在活文件仍是
  // 那份狀態時（`mergeAtBase`），否則對新的狀態從頭重判（至多 DOC_MERGE_ATTEMPTS 次，再不行 503）。
  let merged: MergeOutput | null = null;
  let reinsertedIds: string[] = [];
  let removedSnapshot: unknown[] = [];
  let linkTargets: string[] = [];
  for (let attempt = 0; attempt < DOC_MERGE_ATTEMPTS && merged === null; attempt++) {
    const { state, watch } = await loadNoteState(deps, input.noteId, { watch: true });
    let r: Exclude<Awaited<ReturnType<typeof deps.editing.runDoc<"revert">>>, typeof DOC_TOO_COMPLEX>;
    try {
      const extra = JSON.stringify(row.beforeBlocks ?? []).length;
      const out = await deps.editing.runDoc(input.userId, { kind: "revert", state, row: revertRow, othersShareAnchor }, { extraWeight: extra });
      // 撤回沒有解析：worker 逾時或用完記憶體只會是筆記本身太大或太複雜——重試沒用（不回 503＋Retry-After），內容與紀錄都沒動。
      if (out === DOC_TOO_COMPLEX) return { ok: false, code: "too_complex" };
      if (!out.ok) return { ok: false, code: "stale" };
      r = out;
      const ctx: DirectCtx = { source: "ai-edit", userId: input.userId, tokenId: input.tokenId, agentLabel: input.agentLabel, applied: false };
      try {
        merged = await mergeAtBase(deps, input.noteId, ctx, r.post, watch);
      } catch (err) {
        if (err instanceof StaleBase) continue;
        throw err;
      }
    } finally {
      watch?.stop();
    }
    reinsertedIds = r.reinsertedIds;
    removedSnapshot = r.removedSnapshot;
    linkTargets = r.post.linkTargets;
  }
  if (merged === null) throw new ParserBusyError();
  const done: MergeOutput = merged;
  if (deps.testHooks?.beforeRevertRecord) await deps.testHooks.beforeRevertRecord();
  const editId = await deps.db.transaction(async tx => {
    const [ins] = await tx.insert(noteAiEdits).values({
      noteId: input.noteId, userId: input.userId, tokenId: input.tokenId, agentLabel: input.agentLabel, op: "revert", sectionId: row.sectionId,
      beforeBlocks: removedSnapshot, anchor: null, revertOf: row.id,
      ...recordableAfter(deps, input.noteId, reinsertedIds, done.afterFingerprint), // CHECK 防護，見 apply.ts
    }).returning({ id: noteAiEdits.id });
    await tx.update(noteAiEdits).set({ revertedAt: new Date() }).where(eq(noteAiEdits.id, row.id));
    // 裁切與 `insertEditRecord` 同規則，但**不能重用它**：撤回要「插入撤回列 ＋ 標原列 reverted_at
    // ＋ 裁切」在**同一個交易**內，`insertEditRecord` 只做插入＋裁切。兩處的 orderBy／limit 必須一致。
    const keep = await tx.select({ id: noteAiEdits.id }).from(noteAiEdits).where(eq(noteAiEdits.noteId, input.noteId)).orderBy(desc(noteAiEdits.createdAt), desc(noteAiEdits.id)).limit(RETENTION);
    await tx.delete(noteAiEdits).where(and(eq(noteAiEdits.noteId, input.noteId), notInArray(noteAiEdits.id, keep.map(k => k.id))));
    return ins!.id;
  });
  await updateNoteLinks(deps, { sourceNoteId: input.noteId, userId: input.userId, targets: linkTargets, clock: done.clock });
  return { ok: true, editId, fingerprint: done.fingerprint, outline: done.outline };
}

