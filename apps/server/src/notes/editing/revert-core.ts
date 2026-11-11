/**
 * 撤回的純判準與編輯器那一段（不碰 DB、不開連線）：`revert.ts`（主執行緒的流程）與 `doc-jobs.ts`（worker 裡的轉換）共用。
 */
import type { Block, PartialBlock } from "@blocknote/core";
import type * as Y from "yjs";
import { topLevelContainers } from "@knotebook/shared";
import { fingerprintForIds } from "./fingerprint.js";
import type { EditingRuntime } from "./runtime.js";
import { EditorSession, replaceBlocksFresh } from "./session.js";

/** `placeholder`：bulk transfer 刪光時補的那顆空段落（`sync-apply.ts` 的 toEmpty）。 */
export type Anchor = { block_id: string; position: "before" | "after"; placeholder?: boolean };

/**
 * 「是不是刪除形」的**唯一一支**：`delete_section`，或 `file_sync` 且有 anchor（刪除區）。
 * 四處共用：`editRevertable` 的分支、`listEdits` 的 `before_blocks` id 投影（SQL `case` 是同一條件的 SQL 版）、`revertEdit` 的
 * `isDelete`（決定 `editRevertable` 的 `beforeIds` 與 `mergeDiff` 的 `anchorId`）、`prepareRevert` 的分派。
 */
export function isDeleteShape(row: { op: string; anchor: unknown }): boolean {
  return row.op === "delete_section" || (row.op === "file_sync" && row.anchor !== null && row.anchor !== undefined);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 apply.ts／session.ts）
type AnyBlock = Block<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
type AnyPartialBlock = PartialBlock<any, any, any>;

/** 撤回要的那一列（`note_ai_edits` 的幾格；worker 收得下的純資料）。 */
export interface RevertRow {
  op: string;
  afterBlockIds: string[];
  afterFingerprint: string | null;
  beforeBlocks: unknown[];
  anchor: Anchor | null;
}

/** 頂層 block id 的快照——`editRevertable` 的兩個呼叫端都經由這顆取得，形狀才不會一邊墊空字串、
 *  一邊留 null。`listEdits` 每次列出只算一次（N 列共用），`revertEdit` 每次撤回算一次。 */
export const topLevelIds = (fragment: Y.XmlFragment): (string | null)[] => topLevelContainers(fragment).map(c => c.getAttribute("id") ?? null);

/** `editRevertable` 要的那幾格，兩個呼叫端各自從自己的列組出來（欄位名不同、語意相同）。 */
export type RevertableRow = {
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
export const editRevertable = (row: RevertableRow, fragment: Y.XmlFragment, topIds: readonly (string | null)[]): boolean =>
  isDeleteShape({ op: row.op, anchor: row.anchorId })
    ? row.anchorId !== null && topIds.includes(row.anchorId) && !row.beforeIds.some(id => topIds.includes(id))
    : row.afterBlockIds.length > 0 && fingerprintForIds(fragment, row.afterBlockIds) === row.afterFingerprint;

/** 同 `apply.ts` 的 `prepareEdit`：編輯器只活到取出 diff 為止，之後才合併／記錄／更新索引。
 *  **持有 lease 期間不得再取得 lease**（Global Constraints）。撤回沒有 parse 步驟，所以不會失敗，
 *  回傳型別無錯誤分支。 */
export async function prepareRevertOnFork(
  runtime: EditingRuntime,
  row: RevertRow,
  fork: Y.Doc,
  sv: Uint8Array,
  othersShareAnchor = false,
): Promise<{ diff: Uint8Array; reinsertedIds: string[]; removedSnapshot: AnyBlock[] }> {
  const anchor = row.anchor;
  const s = await EditorSession.open(runtime, fork);
  try {
    const ed = s.editor;
    const before = row.beforeBlocks as AnyPartialBlock[];
    const removedSnapshot: AnyBlock[] = row.afterBlockIds.map(id => ed.getBlock(id)).filter((b): b is AnyBlock => b !== undefined); // 移除前先快照
    let reinsertedIds: string[] = [];
    const wouldBeEmpty = (removing: string[]) => ed.document.every(b => removing.includes(b.id));
    // 三種列形的撤回（`file_sync` 依列形共用這三支）：
    const revertReplace = () => {
      if (before.length === 0 && wouldBeEmpty(row.afterBlockIds)) ed.replaceBlocks(row.afterBlockIds, [{ type: "paragraph" }]); // 永不為空；id 不記
      else reinsertedIds = replaceBlocksFresh(ed, row.afterBlockIds, before).map(b => b.id); // #398：先插後刪（見 `replaceBlocksFresh`）
    };
    const revertInsert = () => {
      // ⚠ 存活突變：把這裡改成無條件 `ed.removeBlocks(row.afterBlockIds)`（拿掉「會變空就補一顆
      // 空 paragraph」），**沒有測試會因此變紅**——因為編輯器的正規化會自己補一顆回來，
      // 只能靠審查看程式碼，這裡誠實記下。保留的理由：「頂層永不為空」是這條路徑自己要守的
      // 不變量，寄託在正規化回寫上是這個 repo 踩過的雷（#100 的正規化回寫被當成新編輯）。
      if (wouldBeEmpty(row.afterBlockIds)) ed.replaceBlocks(row.afterBlockIds, [{ type: "paragraph" }]); else ed.removeBlocks(row.afterBlockIds);
    };
    const revertDelete = (removeAnchor: (isEmptyParagraph: boolean) => boolean) => {
      reinsertedIds = ed.insertBlocks(before, anchor!.block_id, anchor!.position).map(b => b.id);
      const a = ed.getBlock(anchor!.block_id);
      const isEmptyParagraph = a !== undefined && a.type === "paragraph" && (!Array.isArray(a.content) || a.content.length === 0) && (!Array.isArray(a.children) || a.children.length === 0);
      if (removeAnchor(isEmptyParagraph)) ed.removeBlocks([anchor!.block_id]); // 規則③
    };
    switch (row.op) {
      case "replace_all": case "replace_section": revertReplace(); break;
      case "insert_after": case "append": revertInsert(); break;
      case "delete_section": revertDelete(isEmpty => anchor!.position === "before" && isEmpty); break;
      case "file_sync": {
        // 刪除形：規則③ 三條件同時成立才刪 anchor——是佔位、仍是空段落、沒有其他未撤回的列共用它。
        // 不是佔位的 anchor 一律不刪（使用者自己寫的空段落被當成 N anchor）。
        if (isDeleteShape({ op: row.op, anchor })) revertDelete(isEmpty => anchor!.placeholder === true && isEmpty && !othersShareAnchor);
        else if (before.length > 0) revertReplace();
        else revertInsert();
        break;
      }
    }
    return { diff: s.diffSince(sv), reinsertedIds, removedSnapshot };
  } finally {
    s.close(); // ← 編輯器到此為止（合併／記錄／索引都不持有 lease）
  }
}
