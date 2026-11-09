import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { noteStateBytes } from "@/lib/note-size-guard";

/** 文件變動後多久重算一次大小（毫秒）：整份編碼的成本與筆記大小成正比，不在每個按鍵算。 */
export const NOTE_OVER_LIMIT_CHECK_MS = 3_000;

/**
 * 這篇筆記現在是不是超過大小上限（`NOTE_MAX_BYTES`）：`ready`（同步過這一篇）時算一次，之後文件一有變動就節流重算
 * （至多每 {@link NOTE_OVER_LIMIT_CHECK_MS} 一次）。上限未知或還沒同步 → false。呼叫端據此顯示不擋編輯的提示。
 *
 * 已經超過上限時，只有刪掉東西的變動才重算：只新增的變動不會讓它回到上限內，而超過上限時的量法要量回收過的複本（約一次原始編碼的
 * 5 倍，`noteStateBytes`），在超過上限的筆記上打字不必每 3 秒付一次。
 */
export function useNoteOverLimit(doc: Y.Doc | null, limitBytes: number | undefined, ready: boolean): boolean {
  const [over, setOver] = useState<{ doc: Y.Doc | null; limit: number | undefined; value: boolean }>({ doc: null, limit: undefined, value: false });

  useEffect(() => {
    if (doc === null || limitBytes === undefined || !ready) return;
    let isOver = false;
    /** 上次量完之後有沒有刪掉東西的交易。 */
    let deletedSince = false;
    const measure = () => {
      deletedSince = false;
      isOver = noteStateBytes(doc, limitBytes) > limitBytes;
      setOver({ doc, limit: limitBytes, value: isOver });
    };
    measure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onTransaction = (tr: Y.Transaction) => {
      if (tr.deleteSet.clients.size > 0) deletedSince = true;
    };
    const onUpdate = () => {
      if (timer !== undefined) return;
      if (isOver && !deletedSince) return; // 超過上限、只有新增：一定還是超過
      timer = setTimeout(() => {
        timer = undefined;
        measure();
      }, NOTE_OVER_LIMIT_CHECK_MS);
    };
    // afterTransaction 先於 update（Yjs 在交易收尾時先 emit afterTransaction，再 emit update）
    doc.on("afterTransaction", onTransaction);
    doc.on("update", onUpdate);
    return () => {
      doc.off("afterTransaction", onTransaction);
      doc.off("update", onUpdate);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [doc, limitBytes, ready]);

  return ready && over.doc === doc && over.limit === limitBytes && over.value;
}
