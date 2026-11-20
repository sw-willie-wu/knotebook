import { describe, expect, it } from "vitest";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { createExportEditor, renderDeck } from "./render";

const KNOWLEDGE_PROPS = {
  knowledgeId: "k_5a5a5a5a",
  knowledgeWhen: "alice-when-7f3e",
  knowledgeConclusion: "bob-conclusion-91c2",
  knowledgeEvidence: "tested",
  knowledgeVerified: "2031-04-05",
  knowledgeStatus: "outdated",
  knowledgeSupersededBy: "k_6b6b6b6b",
};

describe("presentation slides", () => {
  it("render a note with knowledge info without any knowledge value or data-knowledge attribute", () => {
    const editor = createExportEditor();
    const doc = blocksToYDoc(
      editor,
      [
        { id: "h1", type: "heading", props: { level: 1, ...KNOWLEDGE_PROPS }, content: "Alpha" },
        { id: "p1", type: "paragraph", content: "body" },
        { id: "h2", type: "heading", props: { level: 2, textColor: "red", ...KNOWLEDGE_PROPS }, content: "Beta" },
      ] as never,
      YDOC_FRAGMENT,
    );
    const sections = renderDeck({ editor, doc, title: "T", titlePlaceholder: "Untitled", ctx: { resolveMedia: (u) => u, wikilinks: { kind: "public" } } });
    const html = sections
      .flatMap((s) => s.slides)
      .map((s) => {
        const host = document.createElement("div");
        host.append(s.content!.fragment);
        return host.innerHTML;
      })
      .join("\n");
    expect(html).toContain("Alpha");
    expect(html).toContain("Beta");
    expect(html).not.toMatch(/knowledge/i);
    for (const v of Object.values(KNOWLEDGE_PROPS)) expect(html).not.toContain(v);
  });

  it("the export editor itself already emits no knowledge, before the sanitizer runs", () => {
    const editor = createExportEditor();
    const html = editor.blocksToHTMLLossy([{ id: "h1", type: "heading", props: { level: 1, ...KNOWLEDGE_PROPS }, content: [{ type: "text", text: "Alpha", styles: {} }], children: [] }] as never);
    expect(html).toContain("Alpha");
    expect(html).not.toMatch(/knowledge/i);
  });
});
