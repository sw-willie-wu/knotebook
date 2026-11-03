/**
 * bulk transfer spec 2026-11-02 §9.4-4、§9.5 第 6 步：mount fork **一次**、照決策套用、取 diff（plan PR-2 T7）。
 * **持 fork lease、零 DB**；與 scratch 規劃（`sync-plan.ts`）先後、不巢狀。
 *
 * 順序：讓出一次（T14：mount 是一整段同步，不接在規劃尾段後面）→ mount → 無條件讓出一次（同 PR-1）→ ① 所有非 `same` 的插入與改寫（文件順序）：改寫在第一個倖存者之前
 * `insertBlocks(parsed)` 再 `removeBlocks(倖存者)`；倖存者全不見與插入區照 `place`（`P` 之後、`N` 之前、文件開頭）
 * ② 刪除區：`decide` 已定的錨點直接用；`deferred` 在**此刻**的 mounted doc 裡找第一個倖存者的前一顆（after）或最後一個
 * 倖存者的後一顆（before）——本次插入的 block 可當鄰居、排除本次要移除的 block（rev 4 m-8）；找不到、或 `replaceWithEmpty`
 * → 收集起來，最後一次移除改成換成一顆空段落，這些區都以它為 anchor（before）③ `diffSince` → close。
 * 每區之後按時間預算讓出。找鄰居在 `diffSince`／合併之前，所以不會出現「內容已寫、紀錄撞 `anchor_chk` 才 500」。
 * **現況 0 顆頂層**（空筆記〔gate r1 I5〕，或人把整篇清空〔審查 Important 2〕）：mount 會正規化出一顆空 paragraph——①的第一個
 * 「文件開頭」插入把它換掉（只換一次），其餘區依序接在前一區後面；空筆記只有一個插入區，結果等於 `replace_all`：`beforeBlocks: []`、
 * 紀錄形＝插入列，那顆空段落不留。（T8–T11 審查 M18：原本的空筆記特例分支與這條一般路徑結果相同，已刪。）
 * 寫入前防守：每個非 same、非刪除區插入的 block 都必須在頂層，否則在 `diffSince` 之前 throw（什麼都沒合併）。
 * `survivorsExpect`＝每個非 `same` 區的倖存者在 `cur` 的指紋，加上判 `same` 所依據的外來 block（gate r2 m-12）；
 * `anchorIds`＝用到的、合併前就存在的錨點（`place` 的 ref、刪除區的錨點；本次插入的不算）。
 */
import type { Block } from "@blocknote/core";
import type * as Y from "yjs";
import type { noteAiEdits } from "../db/schema.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import { EditorSession } from "../notes/editing/session.js";
import { chainKeyOf, type Anchor } from "./decide.js";
import type { SyncPlan } from "./sync-plan.js";
import { YIELD_AFTER_MS, yieldToLoop } from "./yield.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 session.ts）
export type AnyBlock = Block<any, any, any>;

export interface Applied {
  diff: Uint8Array;
  /** 每區一筆（與 `plan.regions` 同序）；`same` 區三欄都空。 */
  perRegion: Array<{ beforeBlocks: AnyBlock[]; afterIds: string[]; anchor: Anchor | null }>;
  survivorsExpect: Array<{ id: string; fp: string }>;
  anchorIds: string[];
}

/**
 * 紀錄列（§13）：每個 `applied`／`conflict` 區一列（**`same` 區不記**，gate r1 m23），文件順序；`op: "file_sync"`、`sectionId: null`；
 * 刪除區帶 `anchor`、`after_block_ids: []`，其餘 `anchor: null`（`note_ai_edits_anchor_chk` 的 file_sync 分支）。
 * `afterFingerprints[ri]`＝`mergeDiff` 以 `afterGroups = perRegion.map(p => p.afterIds)` 同一次走完算出的合併後指紋。
 * `recordable`＝`apply.ts` 的 `recordableAfter`（`fingerprint_chk` 防護）；⚠ 它的退化形（`after_block_ids: []`、指紋 null）對
 * file_sync 的非刪除列會撞 `anchor_chk`——理論上到不了（同 `recordableAfter` 的註解），這裡誠實記下。
 */
export function fileSyncRows(p: {
  noteId: string;
  userId: string;
  tokenId: string | null;
  agentLabel: string | null;
  decisions: SyncPlan["decisions"];
  perRegion: Applied["perRegion"];
  afterFingerprints: ReadonlyArray<string | null>;
  recordable?: (afterIds: string[], afterFingerprint: string | null) => { afterBlockIds: string[]; afterFingerprint: string | null };
}): { rows: Array<typeof noteAiEdits.$inferInsert>; regionIdx: number[] } {
  const rows: Array<typeof noteAiEdits.$inferInsert> = [];
  const regionIdx: number[] = [];
  p.decisions.forEach((d, ri) => {
    if (d.mark === "same") return;
    const pr = p.perRegion[ri]!;
    const after = p.recordable ? p.recordable(pr.afterIds, p.afterFingerprints[ri] ?? null) : { afterBlockIds: pr.afterIds, afterFingerprint: p.afterFingerprints[ri] ?? null };
    rows.push({
      noteId: p.noteId,
      userId: p.userId,
      tokenId: p.tokenId,
      agentLabel: p.agentLabel,
      op: "file_sync",
      sectionId: null,
      beforeBlocks: pr.beforeBlocks,
      anchor: d.kind === "delete" ? pr.anchor : null,
      ...after,
    });
    regionIdx.push(ri);
  });
  return { rows, regionIdx };
}

export async function applySync(
  runtime: EditingRuntime,
  fork: Y.Doc,
  sv: Uint8Array,
  plan: SyncPlan,
  cur: { ids: string[]; fps: string[] },
  opts: { yieldFn?: () => Promise<void>; now?: () => number } = {},
): Promise<Applied> {
  const yieldFn = opts.yieldFn ?? yieldToLoop;
  const now = opts.now ?? (() => performance.now());
  const { regions, decisions, parsed } = plan;
  const perRegion: Applied["perRegion"] = regions.map(() => ({ beforeBlocks: [], afterIds: [], anchor: null }));
  const curFp = new Map(cur.ids.map((id, i) => [id, cur.fps[i]!]));
  const curSet = new Set(cur.ids);
  const expect = new Map<string, string>();
  const anchorIds = new Set<string>();
  for (const d of decisions) {
    const list = d.mark === "same" ? d.sameForeign : d.survivors;
    for (const id of list) expect.set(id, curFp.get(id)!);
  }

  // T14（總管裁示 3）：mount 之前先讓出一次——fork 的 mount 是一整段同步（2 vCPU 參考環境 2 000 顆約 230–380 ms，切不開），
  // 不讓出的話它會接在規劃的尾段（scratch unmount、decide）後面成一段更長的停頓。mount 之後那次讓出照舊。
  await yieldFn();
  const s = await EditorSession.open(runtime, fork);
  try {
    await yieldFn();
    let last = now();
    const budget = async () => {
      if (now() - last >= YIELD_AFTER_MS) {
        await yieldFn();
        last = now();
      }
    };
    const ed = s.editor;
    const snapshot = (ids: string[]): AnyBlock[] => ids.map(id => ed.getBlock(id)).filter((b): b is AnyBlock => b !== undefined);

    // 寫入前的防守（審查 Important 2）：每個非 same、非刪除區插入的 block 都必須在頂層——不在就 throw。throw 在 diffSince／
    // 合併之前，所以什麼都還沒寫進筆記（不會「內容已合併、紀錄撞 CHECK 才 500」）。
    const assertTopLevel = () => {
      const top = new Set(ed.document.map(b => b.id));
      for (let ri = 0; ri < regions.length; ri++) {
        const d = decisions[ri]!;
        if (d.mark === "same" || d.kind === "delete") continue;
        if (perRegion[ri]!.afterIds.length === 0 || perRegion[ri]!.afterIds.some(id => !top.has(id))) throw new Error("applySync：插入的 block 不在頂層（套用與決策不一致）");
      }
    };

    // ① 插入與改寫。同一個接點（同一顆 `P` 之後、或文件開頭）有多區時，後一區接在前一區最後一顆之後，保住文件順序
    // （不接的話後一區會插到前一區前面）。現況 0 顆（空筆記，或人把整篇清空；審查 Important 2、gate r1 I5）：mount 正規化出的
    // 那顆空段落只換掉一次（`normalized`），之後各區照這條接續規則接在前一區後面——空筆記只有一個插入區，所以就是「整個換掉」。
    let normalized: string | null = cur.ids.length === 0 ? (ed.document[0]?.id ?? null) : null;
    const chain = new Map<string, string>();
    for (let ri = 0; ri < regions.length; ri++) {
      const d = decisions[ri]!;
      if (d.mark === "same") {
        // R19（複審 F1）：判 same 的區沒寫入，但同一接點的後一區要接在它吸收到的外來 block 之後（否則會排到它們前面）。
        const sameKey = chainKeyOf(d.place);
        if (sameKey !== null && d.sameTail !== null) {
          chain.set(sameKey, d.sameTail);
          anchorIds.add(d.sameTail);
        }
        continue;
      }
      if (d.kind === "delete") continue;
      const blocks = parsed[ri]!;
      const p = d.place;
      let inserted: AnyBlock[];
      const key = chainKeyOf(p);
      if ("ref" in p) {
        if (curSet.has(p.ref) && !d.survivors.includes(p.ref)) anchorIds.add(p.ref);
        const prev = key === null ? undefined : chain.get(key);
        inserted = prev !== undefined ? ed.insertBlocks(blocks, prev, "after") : ed.insertBlocks(blocks, p.ref, p.where);
      } else {
        const prev = chain.get("start");
        if (prev !== undefined) inserted = ed.insertBlocks(blocks, prev, "after");
        else if (normalized !== null) {
          inserted = ed.replaceBlocks([normalized], blocks).insertedBlocks;
          normalized = null;
        } else inserted = ed.insertBlocks(blocks, ed.document[0]!.id, "before");
      }
      if (key !== null && inserted.length > 0) chain.set(key, inserted[inserted.length - 1]!.id);
      perRegion[ri]!.afterIds = inserted.map(b => b.id);
      if (d.kind === "rewrite" && d.survivors.length > 0) {
        perRegion[ri]!.beforeBlocks = snapshot(d.survivors);
        ed.removeBlocks(d.survivors);
      }
      await budget();
    }

    // ② 刪除
    const deleting = new Set<string>();
    for (const d of decisions) if (d.kind === "delete" && d.mark !== "same") for (const id of d.survivors) deleting.add(id);
    const toEmpty: number[] = [];
    // ①之後的頂層位置只算一次：②移除的都在 `deleting` 裡、掃描時本來就跳過，所以這份快照對整個②都有效（不逐區重讀 editor.document）。
    let topIds: string[] | null = null;
    let topPos: Map<string, number> | null = null;
    for (let ri = 0; ri < regions.length; ri++) {
      const d = decisions[ri]!;
      if (d.kind !== "delete" || d.mark === "same") continue;
      perRegion[ri]!.beforeBlocks = snapshot(d.survivors);
      let anchor: Anchor | null = typeof d.anchor === "object" ? d.anchor : null;
      if (d.anchor === "deferred") {
        topIds ??= ed.document.map(b => b.id);
        topPos ??= new Map(topIds.map((id, i) => [id, i]));
        const top = topIds;
        const first = topPos.get(d.survivors[0]!)!;
        const lastIdx = topPos.get(d.survivors[d.survivors.length - 1]!)!;
        for (let i = first - 1; i >= 0 && anchor === null; i--) if (!deleting.has(top[i]!)) anchor = { block_id: top[i]!, position: "after" };
        for (let i = lastIdx + 1; i < top.length && anchor === null; i++) if (!deleting.has(top[i]!)) anchor = { block_id: top[i]!, position: "before" };
        // 審查 m1：往外掃不到 → 倖存者區間內、不在移除之列的 block（同 decide 的同一條）。
        for (let i = first + 1; i < lastIdx && anchor === null; i++) if (!deleting.has(top[i]!)) anchor = { block_id: top[i]!, position: "before" };
      }
      if (anchor === null) {
        toEmpty.push(ri);
        continue;
      }
      if (curSet.has(anchor.block_id)) anchorIds.add(anchor.block_id);
      perRegion[ri]!.anchor = anchor;
      ed.removeBlocks(d.survivors);
      await budget();
    }
    if (toEmpty.length > 0) {
      // 最後一次移除換成一顆空段落（結果頂層永不為空，`apply.ts` delete_section 的形）；這些區都以它為 anchor（before）。
      // 總管追加 T11-1：記成佔位（`placeholder: true`）。空段落落在第一個被換掉的 block 的位置：文件順序第一個區的倖存者在它
      // 「之前」（before），其餘區在它「之後」（after）——撤回時才插得回原順序（3 區以上亂序撤回只近似，known-limitations）。
      const ids = toEmpty.flatMap(ri => decisions[ri]!.survivors);
      const empty = ed.replaceBlocks(ids, [{ type: "paragraph" }]).insertedBlocks[0]!;
      toEmpty.forEach((ri, i) => {
        perRegion[ri]!.anchor = { block_id: empty.id, position: i === 0 ? "before" : "after", placeholder: true };
      });
    }
    assertTopLevel();
    return { diff: s.diffSince(sv), perRegion, survivorsExpect: [...expect].map(([id, fp]) => ({ id, fp })), anchorIds: [...anchorIds] };
  } finally {
    s.close();
  }
}
