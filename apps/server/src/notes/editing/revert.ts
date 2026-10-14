// 撤回：stale 判準＝§5 revertable（live doc 在 transact 內再核對一次）；anchor 三規則（delete_section 沒有指紋可比，
// 錨點旁被改過也判得回——docs 明講）；撤回列 before_blocks＝被撤掉的 AI block、after_block_ids＝插回的原 id；
// 撤回列永不可撤回；撤回後同 apply.ts 更新 note_links。
// ⚠ `revert_of` 是 ON DELETE CASCADE，與裁切（RETENTION）交互：撤回**最舊那一筆**時，插入撤回列後
// 原列剛好被裁掉，撤回列跟著 CASCADE 消失（總數 99 不是 100）；同一個機制也讓一次普通寫入的裁切
// 連帶刪掉一列還在窗口內的撤回紀錄（原列被裁 → 撤回列 CASCADE）。所以「保留 100 筆」實為「最多 100 筆」。
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import type { Block, PartialBlock } from "@blocknote/core";
import * as Y from "yjs";
import { YDOC_FRAGMENT, sectionize, topLevelContainers, type NoteEditDto } from "@knotebook/shared";
import type { CollabServer } from "../../collab/server.js";
import type { Db } from "../../db/index.js";
import { apiTokens, noteAiEdits, users } from "../../db/schema.js";
import { agentLabelOf } from "../../auth/agent-label.js";
import { FingerprintMismatch, RETENTION, mergeDiff, recordableAfter, updateNoteLinks, type ApplyDeps, type MergeOutput } from "./apply.js";
import { fingerprintForIds } from "./fingerprint.js";
import { loadNoteDoc } from "./read.js";
import { EditorSession, type DirectCtx } from "./session.js";

type Anchor = { block_id: string; position: "before" | "after" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 apply.ts／session.ts）
type AnyBlock = Block<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
type AnyPartialBlock = PartialBlock<any, any, any>;

/** 頂層 block id 的快照——`editRevertable` 的兩個呼叫端都經由這顆取得，形狀才不會一邊墊空字串、
 *  一邊留 null。`listEdits` 每次列出只算一次（N 列共用），`revertEdit` 每次撤回算一次。 */
const topLevelIds = (fragment: Y.XmlFragment): (string | null)[] => topLevelContainers(fragment).map(c => c.getAttribute("id") ?? null);

/** `editRevertable` 要的那幾格，兩個呼叫端各自從自己的列組出來（欄位名不同、語意相同）。 */
type RevertableRow = {
  op: string;
  afterBlockIds: string[];
  afterFingerprint: string | null;
  anchorId: string | null;
  /** `delete_section` 列的 `before_blocks` 的 id；其他 op 用不到，兩邊都餵空陣列。 */
  beforeIds: string[];
};

/**
 * 一列修改「現在還可以撤回嗎」的**唯一**判準——`listEdits`（顯示）與 `revertEdit` 的預檢（放行）
 * 共用同一顆，兩邊分岔就會出現「清單說可以、按下去 409」或更糟的反向。**兩個分支都在這裡面**：
 * 非刪除那支曾經在兩處各寫一次（一處是另一處的精確否定），正是刪除那支被抽出來所要防的形。
 *
 * 非 `delete_section`（`replace_all`／`replace_section`／`insert_after`／`append`）：
 * 寫進去的 block 還在、而且內容沒被動過——`after_block_ids` 非空且對這些 id 重算的指紋等於
 * `after_fingerprint`。人改過或刪掉那幾顆就撤不回了。
 *
 * `delete_section`（沒有 after 指紋可比，只能靠錨點與 before）：
 * 1. **錨點還在頂層**——沒有它就沒有插回去的位置（錨點**旁邊**被改過仍然判得回，docs 明講）。
 * 2. **`before_blocks` 的 id 都還不在頂層**＝這次刪除還沒有被還原過。撤回端點**沒有
 *    `if_match`**，所以冪等必須自己守：`revertEdit` 的紀錄交易排在合併**之後**，中途失敗
 *    （DB 故障、連線中斷——計畫把「紀錄插入失敗」列為正式的已知失敗形）＝內容已還原、
 *    撤回列沒寫、原列沒標，而還原**不會**讓錨點消失，所以少了這一條該列會維持可撤回，
 *    重試就把 `before_blocks` **再插一次**。BlockNote 沿用給定的 id，文件因此出現兩顆同 id
 *    的頂層 block，而段落定址、`fingerprintForIds`、`after_block_ids`、`getBlock` 全都建立在
 *    「頂層 id 唯一」之上——且回的是 201，呼叫端拿不到任何訊號。寫入路徑免疫，因為重試要重帶
 *    `if_match`，第二次必然不符。
 *    ⚠ 這條的正確性建立在**同筆記寫入串行**之上（預檢在合併之前讀 live doc）：兩發併發撤回會
 *    各自看到未還原的文件。串行由 `queue.ts` 保證，那邊的不變量註解與單元測試指回這裡。
 *
 * 人在瀏覽器按 Ctrl-Z 把刪掉的那段救回來也會命中第 2 條（Yjs undo 沿用原 id）——那本來就
 * 等於「這次刪除已經被還原」，判成不可撤回是對的。
 */
const editRevertable = (row: RevertableRow, fragment: Y.XmlFragment, topIds: readonly (string | null)[]): boolean =>
  row.op === "delete_section"
    ? row.anchorId !== null && topIds.includes(row.anchorId) && !row.beforeIds.some(id => topIds.includes(id))
    : row.afterBlockIds.length > 0 && fingerprintForIds(fragment, row.afterBlockIds) === row.afterFingerprint;

// 現值運算式不在這裡複製一份——`auth/agent-label.ts` 的 `agentLabelOf` 是 spec §8 指名的唯一實作，
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
    id: noteAiEdits.id, op: noteAiEdits.op, sectionId: noteAiEdits.sectionId, tokenId: noteAiEdits.tokenId,
    agentLabelSnapshot: noteAiEdits.agentLabel, afterBlockIds: noteAiEdits.afterBlockIds, afterFingerprint: noteAiEdits.afterFingerprint,
    anchor: noteAiEdits.anchor, revertOf: noteAiEdits.revertOf, revertedAt: noteAiEdits.revertedAt, createdAt: noteAiEdits.createdAt,
    handle: users.handle, tokenName: apiTokens.name, tokenLabel: apiTokens.agentLabel,
    // `editRevertable` 的 delete_section 第 2 條要 `before_blocks` 的 **id**，但整欄是完整 block 快照。
    // 在 SQL 端就抽成 `text[]`，回應線上只走 id：既拿得到判準要的東西，又不違反上面那條
    // 「不要整欄撈 before_blocks」。`case` 讓非 delete_section 的列連 detoast 都不做（pg 的
    // CASE 是惰性求值），所以最壞情況只有 delete_section 那幾列付這個成本。
    beforeBlockIds: sql<string[]>`case when ${noteAiEdits.op} = 'delete_section' then coalesce((select array_agg(b->>'id') from jsonb_array_elements(${noteAiEdits.beforeBlocks}) as b), '{}'::text[]) else '{}'::text[] end`,
  })
    .from(noteAiEdits).innerJoin(users, eq(users.id, noteAiEdits.userId)).leftJoin(apiTokens, eq(apiTokens.id, noteAiEdits.tokenId))
    .where(eq(noteAiEdits.noteId, noteId)).orderBy(desc(noteAiEdits.createdAt), desc(noteAiEdits.id));
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
    return { id: e.id, op: e.op as NoteEditDto["op"], sectionId: e.sectionId, heading, byHandle: e.handle, agentLabel, createdAt: e.createdAt.toISOString(), revertedAt: e.revertedAt?.toISOString() ?? null, revertOf: e.revertOf, revertable };
  });
}

export type RevertResult = { ok: true; editId: string; fingerprint: string; outline: MergeOutput["outline"] } | { ok: false; code: "not_found" | "already_reverted" | "stale" };

export async function revertEdit(deps: ApplyDeps, input: { noteId: string; editId: string; userId: string; tokenId: string | null; agentLabel: string | null }): Promise<RevertResult> {
  const [row] = await deps.db.select().from(noteAiEdits).where(and(eq(noteAiEdits.id, input.editId), eq(noteAiEdits.noteId, input.noteId)));
  if (!row) return { ok: false, code: "not_found" };
  if (row.op === "revert" || row.revertedAt !== null) return { ok: false, code: "already_reverted" };
  const { doc: fork } = await loadNoteDoc({ db: deps.db, collab: deps.collab }, input.noteId);
  const sv = Y.encodeStateVector(fork);
  const fragment = fork.getXmlFragment(YDOC_FRAGMENT);
  const anchor = row.anchor as Anchor | null;
  const isDelete = row.op === "delete_section";
  // 與 `listEdits` **同一顆述詞**（`editRevertable`，兩個分支都在裡面）：清單顯示什麼，這裡就放行什麼。
  // `delete_section` 第 2 條（`before_blocks` 已經在頂層＝這次刪除已被還原）就是撤回端點的冪等守衛，
  // 見該函式的註解。`beforeIds` 只有 delete 分支會讀，其他 op 餵空陣列——與 `listEdits` 的 SQL
  // （非 delete_section 的列回 `'{}'`）形狀一致，也避免白白把整份 before_blocks 快照 map 一遍。
  const staleNow = !editRevertable(
    {
      op: row.op, afterBlockIds: row.afterBlockIds, afterFingerprint: row.afterFingerprint,
      anchorId: anchor?.block_id ?? null, beforeIds: isDelete ? (row.beforeBlocks as AnyBlock[]).map(b => b.id) : [],
    },
    fragment, topLevelIds(fragment),
  );
  if (staleNow) return { ok: false, code: "stale" };

  const prepared = await prepareRevert(deps, row, fork, sv, anchor);
  const { diff, reinsertedIds, removedSnapshot } = prepared;

  const ctx: DirectCtx = { source: "ai-edit", userId: input.userId, tokenId: input.tokenId, agentLabel: input.agentLabel, applied: false };
  let merged: MergeOutput;
  try {
    merged = await mergeDiff(deps, input.noteId, ctx, {
      targetIds: isDelete ? null : row.afterBlockIds, expectFingerprint: isDelete ? null : row.afterFingerprint,
      anchorId: isDelete ? anchor!.block_id : null, diff, afterIds: reinsertedIds,
    });
  } catch (err) {
    if (err instanceof FingerprintMismatch) return { ok: false, code: "stale" };
    throw err;
  }
  if (deps.testHooks?.beforeRevertRecord) await deps.testHooks.beforeRevertRecord();
  const editId = await deps.db.transaction(async tx => {
    const [ins] = await tx.insert(noteAiEdits).values({
      noteId: input.noteId, userId: input.userId, tokenId: input.tokenId, agentLabel: input.agentLabel, op: "revert", sectionId: row.sectionId,
      beforeBlocks: removedSnapshot, anchor: null, revertOf: row.id,
      ...recordableAfter(deps, input.noteId, reinsertedIds, merged.afterFingerprint), // CHECK 防護，見 apply.ts
    }).returning({ id: noteAiEdits.id });
    await tx.update(noteAiEdits).set({ revertedAt: new Date() }).where(eq(noteAiEdits.id, row.id));
    // 裁切與 `insertEditRecord` 同規則，但**不能重用它**：撤回要「插入撤回列 ＋ 標原列 reverted_at
    // ＋ 裁切」在**同一個交易**內，`insertEditRecord` 只做插入＋裁切。兩處的 orderBy／limit 必須一致。
    const keep = await tx.select({ id: noteAiEdits.id }).from(noteAiEdits).where(eq(noteAiEdits.noteId, input.noteId)).orderBy(desc(noteAiEdits.createdAt), desc(noteAiEdits.id)).limit(RETENTION);
    await tx.delete(noteAiEdits).where(and(eq(noteAiEdits.noteId, input.noteId), notInArray(noteAiEdits.id, keep.map(k => k.id))));
    return ins!.id;
  });
  await updateNoteLinks(deps, { sourceNoteId: input.noteId, userId: input.userId, forkDoc: fork, clock: merged.clock });
  return { ok: true, editId, fingerprint: merged.fingerprint, outline: merged.outline };
}

/** 同 `apply.ts` 的 `prepareEdit`：編輯器只活到取出 diff 為止，之後才合併／記錄／更新索引。
 *  **持有 lease 期間不得再取得 lease**（Global Constraints）。撤回沒有 parse 步驟，所以不會失敗，
 *  回傳型別無錯誤分支。 */
async function prepareRevert(
  deps: ApplyDeps,
  row: typeof noteAiEdits.$inferSelect,
  fork: Y.Doc,
  sv: Uint8Array,
  anchor: Anchor | null
): Promise<{ diff: Uint8Array; reinsertedIds: string[]; removedSnapshot: AnyBlock[] }> {
  const s = await EditorSession.open(deps.editing, fork);
  try {
    const ed = s.editor;
    const before = row.beforeBlocks as AnyPartialBlock[];
    const removedSnapshot: AnyBlock[] = row.afterBlockIds.map(id => ed.getBlock(id)).filter((b): b is AnyBlock => b !== undefined); // 移除前先快照
    let reinsertedIds: string[] = [];
    const wouldBeEmpty = (removing: string[]) => ed.document.every(b => removing.includes(b.id));
    switch (row.op) {
      case "replace_all": case "replace_section": {
        if (before.length === 0 && wouldBeEmpty(row.afterBlockIds)) ed.replaceBlocks(row.afterBlockIds, [{ type: "paragraph" }]); // 永不為空；id 不記
        else reinsertedIds = ed.replaceBlocks(row.afterBlockIds, before).insertedBlocks.map(b => b.id);
        break;
      }
      case "insert_after": case "append": {
        // ⚠ 存活突變：把這裡改成無條件 `ed.removeBlocks(row.afterBlockIds)`（拿掉「會變空就補一顆
        // 空 paragraph」），**沒有測試會因此變紅**——因為編輯器的正規化會自己補一顆回來，
        // 只能靠審查看程式碼，這裡誠實記下。保留的理由：「頂層永不為空」是這條路徑自己要守的
        // 不變量，寄託在正規化回寫上是這個 repo 踩過的雷（#100 的正規化回寫被當成新編輯）。
        if (wouldBeEmpty(row.afterBlockIds)) ed.replaceBlocks(row.afterBlockIds, [{ type: "paragraph" }]); else ed.removeBlocks(row.afterBlockIds);
        break;
      }
      case "delete_section": {
        reinsertedIds = ed.insertBlocks(before, anchor!.block_id, anchor!.position).map(b => b.id);
        const a = ed.getBlock(anchor!.block_id);
        const isEmptyParagraph = a !== undefined && a.type === "paragraph" && (!Array.isArray(a.content) || a.content.length === 0) && (!Array.isArray(a.children) || a.children.length === 0);
        if (anchor!.position === "before" && isEmptyParagraph) ed.removeBlocks([anchor!.block_id]); // 規則③
        break;
      }
    }
    return { diff: s.diffSince(sv), reinsertedIds, removedSnapshot };
  } finally {
    s.close(); // ← 編輯器到此為止（合併／記錄／索引都不持有 lease）
  }
}
