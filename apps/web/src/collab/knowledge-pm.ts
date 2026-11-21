import { knowledgeHeadingLevel, knowledgeHeadingText, type KnowledgeTopLevelItem } from "@knotebook/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Node type can't be imported: prosemirror-model isn't an apps/web dependency
type Any = any;

export interface PmKnowledgeScan {
  items: KnowledgeTopLevelItem[];
  /** Parallel to `items`: position of the heading node when it carries a knowledge id, otherwise -1. Positional, not keyed by block id: a dragged copy can share its source's block id. */
  headingPos: number[];
}

const isKnowledgeId = (value: unknown): boolean => typeof value === "string" && value !== "";

// The reading rule lives in shared (`knowledgeHeadingText`); this only maps ProseMirror inline nodes onto the block-tree shape it reads.
function headingText(heading: Any): string {
  const content: unknown[] = [];
  heading.forEach((child: Any) => {
    const name = child.type.name;
    if (name === "text") content.push({ type: "text", text: child.text });
    else if (name === "wikilink") content.push({ type: "wikilink", props: child.attrs });
    else if (name === "hardBreak") content.push({ type: "text", text: "\n" });
  });
  return knowledgeHeadingText(content);
}

/**
 * Text is only read for headings that carry a knowledge id: the entries never use another heading's text, and reading every heading would make each scan proportional to the whole note's prose.
 */
export function scanPmKnowledge(doc: Any, readText = true): PmKnowledgeScan {
  const items: KnowledgeTopLevelItem[] = [];
  const headingPos: number[] = [];
  const group = doc.firstChild;
  if (!group) return { items, headingPos };
  let pos = 1;
  group.forEach((container: Any) => {
    const id = container.attrs?.id;
    const first = container.type.name === "blockContainer" ? container.firstChild : null;
    if (typeof id === "string") {
      if (first && first.type.name === "heading") {
        const props = first.attrs as Record<string, unknown>;
        const known = isKnowledgeId(props.knowledgeId);
        items.push({ blockId: id, heading: { level: knowledgeHeadingLevel(props.level), text: known && readText ? headingText(first) : "", props } });
        headingPos.push(known ? pos + 1 : -1);
      } else {
        items.push({ blockId: id, heading: null });
        headingPos.push(-1);
      }
    }
    pos += container.nodeSize;
  });
  return { items, headingPos };
}

export function knowledgeItemsFromPmDoc(doc: Any): KnowledgeTopLevelItem[] {
  return scanPmKnowledge(doc).items;
}

/** One pass over the top-level blocks, stopping at the first knowledge heading; allocates nothing. */
export function pmDocHasKnowledge(doc: Any): boolean {
  const group = doc.firstChild;
  if (!group) return false;
  for (let i = 0; i < group.childCount; i += 1) {
    const first = group.child(i).firstChild;
    if (first && first.type.name === "heading" && isKnowledgeId(first.attrs.knowledgeId)) return true;
  }
  return false;
}

/** Whether this transaction can have put a knowledge id into the document: only steps that carry a slice, move content through a gap, or set an attribute can. */
export function transactionMayAddKnowledge(tr: Any): boolean {
  for (const step of tr.steps as Any[]) {
    // Lifting a block out of a list or column keeps it in the gap, not in the slice, so the slice says nothing about it.
    if ("gapFrom" in step) return true;
    if ("slice" in step) {
      let hit = false;
      step.slice.content.descendants((node: Any) => {
        if (hit) return false;
        if (node.type.name === "heading" && isKnowledgeId(node.attrs.knowledgeId)) hit = true;
        return !hit;
      });
      if (hit) return true;
    } else if ("attr" in step) {
      if (step.attr === "knowledgeId" && isKnowledgeId(step.value)) return true;
    }
  }
  return false;
}
