import { vi } from "vitest";
import { listKnowledgeInBlocks, type KnowledgeBlockLike, type KnowledgeEntry } from "@knotebook/shared";

export interface KnowledgeFixture {
  id: string;
  blockId: string;
  level?: number;
  title?: string;
  props?: Record<string, string>;
}

export function knowledgeBlocks(items: KnowledgeFixture[], plain: Array<{ blockId: string; title: string }> = []): KnowledgeBlockLike[] {
  return [
    ...items.map((i) => ({
      id: i.blockId,
      type: "heading",
      props: { level: i.level ?? 1, knowledgeId: i.id, knowledgeWhen: "when alice", knowledgeConclusion: "conclusion bob", ...i.props },
      content: i.title ?? `Heading ${i.blockId}`,
    })),
    ...plain.map((p) => ({ id: p.blockId, type: "heading", props: { level: 1 }, content: p.title })),
  ];
}

export function knowledgeEntries(items: KnowledgeFixture[]): KnowledgeEntry[] {
  return listKnowledgeInBlocks(knowledgeBlocks(items));
}

/** DOM shaped like BlockNote's top-level blocks: `.bn-block-outer[data-id] > .bn-block > .bn-block-content > .bn-inline-content`. */
export function blocksHtml(ids: Array<{ blockId: string; title: string }>): string {
  return ids
    .map(
      (b) =>
        `<div class="bn-block-outer" data-id="${b.blockId}"><div class="bn-block"><div class="bn-block-content" data-content-type="heading"><h2 class="bn-inline-content">${b.title}</h2></div></div></div>`,
    )
    .join("");
}

/** jsdom lays nothing out: the column is 800 wide and every heading's text ends 200px in. */
export function stubLayout(): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.matches("[data-testid='col'], .kb-diff")) return new DOMRect(0, 0, 800, 2000);
    if (this.matches(".bn-inline-content")) return new DOMRect(0, 0, 600, 30);
    return new DOMRect(0, 0, 0, 0);
  });
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(() => [new DOMRect(0, 0, 200, 30)] as unknown as DOMRectList);
}

export function stubMedia(matching: string[]): void {
  window.matchMedia = ((query: string) => ({
    matches: matching.includes(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
