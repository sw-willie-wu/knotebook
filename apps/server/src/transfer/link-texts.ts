/**
 * 第三輪探索測試 F1：沒有自訂文字的 wikilink（顯示目標的現行標題）在檔案寫回時不得被凍結成自訂文字。
 *
 * 下載時，這種連結匯出成 `[目標當時的標題](/notes/<id>)`；寫回時 markdown → wikilink 的規則（`wikilinkPropsFromLink`）只認
 * 「文字＝目標**現在的**標題（或網址本身）」才不存 label。目標在下載後改名，而 agent 改了含那個連結的那一段 → 舊標題被存成 label，
 * 之後目標再改名也不跟著變。修法：下載時記下每個「沒有自訂文字」的連結匯出時用的文字（加鹽 HMAC，只存雜湊——同基底的行雜湊，
 * §21 D2），存在基底段表的 `links`（jsonb，不需 migration）；寫回時檔案裡連結的文字若是這個連結下載時匯出的那個，就照「沒有自訂文字」存。
 *
 * - 匯出的文字＝`wikilinkVisibleText(props, titles.get(id))`，與 `toNoteMarkdown`（`wikilinksToLinks`）同一個算法。
 * - 只記 `label` 為空的連結：有自訂文字的連結匯出的是它自己的文字，寫回時照舊規則存（沒改就仍是那個自訂文字）。
 * - 下載時沒有 `links` 的基底（這版之前下載的副本）：照舊規則。
 */
import { mapInlineArrays, wikilinkVisibleText, type WikilinkProps } from "@knotebook/shared";
import type { TransferSegment } from "../db/schema.js";
import { hmacOf } from "./base-hash.js";

const LINK_HASH_BYTES = 8;

/** `HMAC(K, salt ‖ "wikilink\0" ‖ 小寫 id ‖ "\0" ‖ 文字)` 前 8 bytes 的 hex。`\0` 分隔，id 與文字不會互相滲透。 */
export function linkTextHash(key: Buffer, salt: Buffer, targetId: string, text: string): string {
  return hmacOf(key, salt, `wikilink\0${targetId.toLowerCase()}\0${text}`).subarray(0, LINK_HASH_BYTES).toString("hex");
}

/** `blocks`（含子 block、表格格子）裡每個沒有自訂文字的 wikilink：`[小寫目標 id, 匯出時顯示的文字]`。不改寫輸入。 */
export function labelFreeLinkTexts(blocks: readonly unknown[], titles: ReadonlyMap<string, string>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  mapInlineArrays([...blocks], inline => {
    for (const node of inline) {
      const n = node as { type?: unknown; props?: Partial<WikilinkProps> };
      if (n?.type !== "wikilink") continue;
      const props = n.props ?? {};
      if (typeof props.label === "string" && props.label !== "") continue;
      const id = String(props.targetNoteId ?? "").toLowerCase();
      out.push([id, wikilinkVisibleText(props, titles.get(id))]);
    }
    return inline;
  });
  return out;
}

/**
 * 寫回時：基底段表所有段的 `links` 併成一個集合（同一個目標在整篇裡匯出的是同一個標題，所以不分段比——agent 把連結搬到別段也認得），
 * 回傳 `(目標, 文字)` 判斷式；沒有任何 `links`（沒有這種連結，或這版之前下載的基底）→ undefined（照舊規則）。
 */
export function exportedLinkTextOf(segments: readonly TransferSegment[], key: Buffer, salt: Buffer): ((targetId: string, text: string) => boolean) | undefined {
  const set = new Set<string>();
  for (const s of segments) for (const h of s.links ?? []) set.add(h);
  if (set.size === 0) return undefined;
  return (targetId, text) => set.has(linkTextHash(key, salt, targetId, text));
}

/**
 * 寫回時（`planSync` 每區 parse 之後）：parse 出的 wikilink 若帶 label、而 `(目標, label)` 是下載時某個沒有自訂文字的連結匯出的
 * 文字（`exported`）→ 清掉 label（＝沒有自訂文字、跟著目標的標題），`snapshotTitle` 換成目標現在的標題（`titleOf` 查得到時；同
 * 「文字＝現行標題」那條規則存的值）。label 原本就空的不動。回傳新陣列（copy-on-write）與清掉的個數。
 * `onCleared`（#387，選配）：每清掉一個就回報 `(小寫目標 id, 原本的文字)`；批次寫回（`planSync`）不給。
 */
export function keepLabelFree<B>(
  blocks: B[],
  exported: (targetId: string, text: string) => boolean,
  titleOf: (id: string) => string | undefined,
  onCleared?: (targetId: string, text: string) => void,
): [B[], number] {
  let cleared = 0;
  const out = mapInlineArrays(blocks, inline => {
    let changed = false;
    const next = inline.map(node => {
      const n = node as { type?: unknown; props?: Partial<WikilinkProps> };
      if (n?.type !== "wikilink") return node;
      const props = n.props ?? {};
      const label = typeof props.label === "string" ? props.label : "";
      const id = String(props.targetNoteId ?? "");
      if (label === "" || !exported(id, label)) return node;
      changed = true;
      cleared++;
      onCleared?.(id.toLowerCase(), label);
      return { ...n, props: { ...props, label: "", snapshotTitle: titleOf(id) ?? props.snapshotTitle ?? label } };
    });
    return changed ? next : inline;
  });
  return [out, cleared];
}
