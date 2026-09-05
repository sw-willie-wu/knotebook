// 硬規則：永遠算在未 mount 的 Yjs 結構上（mount 會正規化空文件）；同步 hash 才能在 transact 內重算。
// 指紋是樂觀併發的判準，不是安全邊界。after_fingerprint 依文件順序；id 缺或順序變＝null＝不符，
// 呼叫端一律當 409／stale——不得在不符時退回整篇指紋（會讓過期的段落更新誤放行）。
import { createHash } from "node:crypto";
import type * as Y from "yjs";
import { canonicalizeElements, canonicalizeSection, sectionize, topLevelContainers, type SectionInfo } from "@knotebook/shared";

export function fingerprintOf(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
export const EMPTY_SECTION_FINGERPRINT = fingerprintOf("");
export interface OutlineEntry extends SectionInfo {
  fingerprint: string;
}

export function outlineOf(fragment: Y.XmlFragment): { outline: OutlineEntry[]; whole: string } {
  const byId = new Map<string, Y.XmlElement>();
  for (const c of topLevelContainers(fragment)) {
    const id = c.getAttribute("id");
    if (typeof id !== "string" || id === "") throw new Error("outlineOf：頂層 blockContainer 缺 id 屬性（文件不是 BlockNote 結構）");
    byId.set(id, c);
  }
  const outline = sectionize(fragment).map(s => ({ ...s, fingerprint: fingerprintOf(canonicalizeElements(s.blockIds.map(id => byId.get(id)!))) }));
  return { outline, whole: fingerprintOf(outline.map(o => o.fingerprint).join("")) };
}

/** 空陣列 → EMPTY_SECTION_FINGERPRINT；任一 id 不在頂層或順序與文件順序不符 → null（＝不符）。 */
export function fingerprintForIds(fragment: Y.XmlFragment, ids: string[]): string | null {
  if (ids.length === 0) return EMPTY_SECTION_FINGERPRINT;
  const canonical = canonicalizeSection(fragment, ids);
  return canonical === null ? null : fingerprintOf(canonical);
}
