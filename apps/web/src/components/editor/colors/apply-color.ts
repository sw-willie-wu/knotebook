import type { BlockNoteEditor } from "@blocknote/core";
import { canonicalColor } from "@knotebook/shared";
import { ensureCustomColor } from "@/lib/custom-colors";
import { sectionProp, type ColorSection, type ColorTarget } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組走 repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;

/**
 * 把顏色套到選取的行內文字或指定的 block。block 目標回 true 表示已寫入；值不是合法顏色、block 已不存在、
 * 或該種 block 沒有這個 prop 時回 false。行內目標回 true 只表示已對目前選取送出套色（不檢查選取是否接受樣式）。不在這裡 focus。
 * 規則種類依實際套用的位置登記：行內只登記行內規則，block 只登記 block 規則。
 */
export function applyColor(editor: AnyEditor, section: ColorSection, target: ColorTarget, value: string): boolean {
  const canon = canonicalColor(value);
  if (canon === null) return false;
  const prop = sectionProp(section);
  if (target.kind === "block") {
    const block = editor.getBlock(target.blockId);
    // 該種 block 沒有這個 prop（例如 codeBlock 沒有 backgroundColor）時 updateBlock 不會寫入，這裡也不登記規則。
    if (!block || !(prop in block.props)) return false;
  }
  if (canon.startsWith("#")) ensureCustomColor(target.kind === "inline" ? "inline" : "block", prop, canon);
  if (target.kind === "inline") {
    if (canon === "default") editor.removeStyles({ [prop]: canon });
    else editor.addStyles({ [prop]: canon });
    return true;
  }
  editor.updateBlock(target.blockId, { props: { [prop]: canon } });
  return true;
}
