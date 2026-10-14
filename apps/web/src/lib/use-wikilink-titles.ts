import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import { sameNoteId } from "./note-id";
import type { DiffBlock } from "./version-diff";

function visitInline(inline: unknown, out: Set<string>): void {
  if (!Array.isArray(inline)) return;
  for (const n of inline as Array<{ type?: unknown; props?: { targetNoteId?: unknown } }>) {
    if (n?.type === "wikilink" && typeof n.props?.targetNoteId === "string") out.add(n.props.targetNoteId);
  }
}

/** a∪b 裡出現的 wikilink 目標 id（inline、表格兩種 cell 形、children）。 */
export function wikilinkIdsIn(blocks: readonly DiffBlock[] | null | undefined, out: Set<string>): void {
  for (const b of blocks ?? []) {
    const content = b.content as { type?: unknown; rows?: Array<{ cells?: unknown[] }> } | unknown[] | undefined;
    if (Array.isArray(content)) visitInline(content, out);
    else if (content && typeof content === "object" && content.type === "tableContent") {
      for (const row of content.rows ?? []) for (const cell of row.cells ?? []) visitInline(Array.isArray(cell) ? cell : (cell as { content?: unknown })?.content, out);
    }
    wikilinkIdsIn(b.children, out);
  }
}

const noop = () => () => {};

/**
 * #269 §13.2：diff 預覽的 `titleOf`。被動訂閱 `["notes"]` 快取（不發請求；沒有 QueryClientProvider 時為空），只投影 a∪b 的 id，
 * 以排序後的 `[id, title]` 序列化字串當值相等的鍵——清單重抓但相關標題沒變時回同一個函式，`renderDiff` 的 useMemo 不重算、
 * `DiffEditor` 不重建（VersionPreview 的「不跳頂」要求）；冷快取到貨時鍵變一次、預覽重繪一次。
 * id 比對用 `sameNoteId`（舊文件的 `targetNoteId` 可能存大寫）；回傳函式以文件裡的原字串查。
 */
export function useWikilinkTitleOf(a: readonly DiffBlock[] | null | undefined, b: readonly DiffBlock[] | null | undefined): (id: string) => string | undefined {
  const client = useContext(QueryClientContext);
  const subscribe = useCallback((cb: () => void) => (client ? client.getQueryCache().subscribe(cb) : noop()), [client]);
  const notes = useSyncExternalStore(subscribe, () => client?.getQueryData<NoteDto[]>(["notes"]));
  const ids = useMemo(() => {
    const s = new Set<string>();
    wikilinkIdsIn(a, s);
    wikilinkIdsIn(b, s);
    return [...s].sort();
  }, [a, b]);
  const key = useMemo(() => JSON.stringify(ids.map((id) => [id, notes?.find((n) => sameNoteId(n.id, id))?.title ?? null])), [ids, notes]);
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, title] of JSON.parse(key) as Array<[string, string | null]>) if (title !== null) map.set(id, title);
    return (id: string) => map.get(id);
  }, [key]);
}
