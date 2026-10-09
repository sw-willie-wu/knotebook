/**
 * #229 簡報切頁（spec §4）：純函式，不碰 DOM、不碰 Y.Doc。
 *
 * 相對層級（D2、E1、F3）：頂層 heading 中最小的 level＝L1（章，橫向），大於 L1 的最小 level＝L2
 * （節，縱向；可能不存在）；更深的標題留在頁內。divider 另開一章（divider 本身不放進 blocks）。
 * 只看頂層 block，子 block 跟父 block 走。封面章永遠在、ID 恆為 `_title`（§4.1）。
 * 空頁（kind 不是 heading／cover 且所有 block 都是空白段落）略過；章首被略過時章 ID 跟著換。
 */
export const COVER_ID = "_title";

export type SlideKind = "cover" | "heading" | "divider";

/** noteToSlides 只讀到的欄位（BlockNote 的 `Block` 結構上相容）。 */
export interface SlideBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: readonly unknown[];
}

export interface Slide<B extends SlideBlock = SlideBlock> {
  id: string;
  kind: SlideKind;
  /** heading 張：blocks[0] 是該標題本身。 */
  blocks: B[];
}

export interface Section<B extends SlideBlock = SlideBlock> {
  /** ＝slides[0].id（略過空頁之後）。 */
  id: string;
  slides: Slide<B>[];
}

function headingLevel(block: SlideBlock): number | null {
  if (block.type !== "heading") return null;
  const level = block.props?.level;
  return typeof level === "number" ? level : null;
}

/** 空白 block：paragraph、沒有子 block、inline content 為空或只有空白文字（link／wikilink 等一律不算空）。 */
export function isBlankBlock(block: SlideBlock): boolean {
  if (block.type !== "paragraph") return false;
  if ((block.children?.length ?? 0) > 0) return false;
  const content = block.content;
  if (!Array.isArray(content)) return true;
  return content.every(
    (item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string" &&
      (item as { text: string }).text.trim() === "",
  );
}

function isSkippable<B extends SlideBlock>(slide: Slide<B>): boolean {
  return slide.kind === "divider" && slide.blocks.every(isBlankBlock);
}

export function noteToSlides<B extends SlideBlock>(_title: string, blocks: readonly B[]): Section<B>[] {
  const levels = blocks.map(headingLevel).filter((level): level is number => level !== null);
  const l1 = levels.length > 0 ? Math.min(...levels) : null;
  const deeper = l1 === null ? [] : levels.filter((level) => level > l1);
  const l2 = deeper.length > 0 ? Math.min(...deeper) : null;

  const cover: Slide<B> = { id: COVER_ID, kind: "cover", blocks: [] };
  const raw: Slide<B>[][] = [[cover]];
  let section = raw[0];
  let slide = cover;

  for (const block of blocks) {
    const level = headingLevel(block);
    if (level !== null && level === l1) {
      slide = { id: block.id, kind: "heading", blocks: [block] };
      section = [slide];
      raw.push(section);
    } else if (block.type === "divider") {
      slide = { id: block.id, kind: "divider", blocks: [] };
      section = [slide];
      raw.push(section);
    } else if (level !== null && level === l2) {
      slide = { id: block.id, kind: "heading", blocks: [block] };
      section.push(slide);
    } else {
      slide.blocks.push(block);
    }
  }

  const sections: Section<B>[] = [];
  for (const slides of raw) {
    const kept = slides.filter((candidate) => !isSkippable(candidate));
    if (kept.length > 0) sections.push({ id: kept[0].id, slides: kept });
  }
  return sections;
}
