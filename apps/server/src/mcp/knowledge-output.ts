/** What `edit_note` and `create_note` report about knowledge info. Raw-shape fields only: the SDK silently drops a schema wrapped in `.refine`. */
import { z } from "zod";
import type { KnowledgeWriteReport } from "../notes/editing/knowledge-write.js";
import { MCP_PAGE_MAX, MCP_TEXT_MAX, escapedLength, truncateText } from "./limits.js";

export const KNOWLEDGE_OUTPUT_DESCRIBE =
  "Only present when your write kept, created, removed or renumbered knowledge info, or ignored a knowledge comment. " +
  "kept: headings you sent without a comment that kept the knowledge info of the heading they replaced. " +
  "created: knowledge ids that are new to the note after your write, whether you left the id out or wrote a new one. " +
  "removed: knowledge info that was in what you replaced or deleted and is no longer in the note. " +
  "renewed: knowledge whose id another heading in the note already had, so it got a new one; from is the id it had. " +
  "ignoredComments: knowledge comments that weren't right after a heading that can hold knowledge info. " +
  `Each list holds at most ${MCP_PAGE_MAX} entries; truncated is true when one was cut.`;

export const CREATE_KNOWLEDGE_OUTPUT_DESCRIBE = "Only present when your content had knowledge comments or a knowledge id was set; as in edit_note.";

const refSchema = z.object({
  id: z.string(),
  heading: z.string().max(MCP_TEXT_MAX),
  headingTruncated: z.literal(true).optional(),
});

export const knowledgeOutputSchema = z.object({
  kept: z.array(refSchema),
  created: z.array(refSchema),
  removed: z.array(refSchema),
  renewed: z.array(refSchema.extend({ from: z.string() })),
  ignoredComments: z.number(),
  truncated: z.boolean(),
});

export type KnowledgeForModel = z.infer<typeof knowledgeOutputSchema>;

/** Escaped size of one entry besides its heading and ids: the keys and the punctuation. */
const ENTRY_OVERHEAD = 50;
/**
 * A list can't be allowed all of `MCP_PAGE_MAX` entries at full heading length: four such lists next to a full outline page would pass the
 * wire limit (`test/mcp-size.test.ts`). Short headings, the usual case, never reach this.
 */
const LIST_BUDGET = 12_000;

function cut<T extends { id: string; heading: string }>(items: readonly T[], extra: (item: T) => Record<string, string>): { list: Array<Record<string, unknown>>; truncated: boolean } {
  const list: Array<Record<string, unknown>> = [];
  let budget = LIST_BUDGET;
  for (const item of items) {
    const heading = truncateText(item.heading);
    const cost = escapedLength(heading.text) + escapedLength(item.id) + escapedLength(Object.values(extra(item)).join("")) + ENTRY_OVERHEAD;
    if (list.length >= MCP_PAGE_MAX || cost > budget) return { list, truncated: true };
    budget -= cost;
    list.push({ id: item.id, heading: heading.text, ...(heading.truncated ? { headingTruncated: true as const } : {}), ...extra(item) });
  }
  return { list, truncated: false };
}

export function knowledgeForModel(report: KnowledgeWriteReport): KnowledgeForModel {
  const none = (): Record<string, string> => ({});
  const kept = cut(report.kept, none);
  const created = cut(report.created, none);
  const removed = cut(report.removed, none);
  const renewed = cut(report.renewed, r => ({ from: r.from }));
  return {
    kept: kept.list,
    created: created.list,
    removed: removed.list,
    renewed: renewed.list,
    ignoredComments: report.ignoredComments,
    truncated: kept.truncated || created.truncated || removed.truncated || renewed.truncated,
  } as KnowledgeForModel;
}
