import { COVER_ID } from "./slides";

/** §7.2 只需要章與張的 id 結構（`Section` 與 deck DOM 的結構都符合）。 */
export interface SlideStructure {
  id: string;
  slides: readonly { id: string }[];
}

export function locateSlide(sections: readonly SlideStructure[], id: string): { h: number; v: number } | null {
  for (let h = 0; h < sections.length; h++) {
    const v = sections[h].slides.findIndex((slide) => slide.id === id);
    if (v !== -1) return { h, v };
  }
  return null;
}

/**
 * 更新後的新位置（spec §7.2）：①目前那張仍在 → 它；②舊結構中緊接在它之前的那一張（同章上一張；
 * 章首則上一章最後一張）仍在 → 它；③舊結構中它所屬那章的第一張仍在 → 它；④封面。
 * 回傳新結構裡的 (h, v) 與那一張的 id（不回傳舊數字——突變「回傳舊 (h,v)」由結構前移／後移兩案擋）。
 */
export function repositionAfterUpdate(
  oldSections: readonly SlideStructure[],
  oldCurrentId: string,
  newSections: readonly SlideStructure[],
): { h: number; v: number; id: string } {
  const at = (id: string) => {
    const pos = locateSlide(newSections, id);
    return pos ? { ...pos, id } : null;
  };

  const current = at(oldCurrentId);
  if (current) return current;

  const old = locateSlide(oldSections, oldCurrentId);
  if (old) {
    const previous =
      old.v > 0
        ? oldSections[old.h].slides[old.v - 1]
        : old.h > 0
          ? oldSections[old.h - 1].slides[oldSections[old.h - 1].slides.length - 1]
          : undefined;
    if (previous) {
      const hit = at(previous.id);
      if (hit) return hit;
    }
    const first = at(oldSections[old.h].slides[0].id);
    if (first) return first;
  }
  return { h: 0, v: 0, id: COVER_ID };
}
