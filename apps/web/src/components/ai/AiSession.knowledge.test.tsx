import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { REWRITE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { createTestEditor, renderAiHost, selectWholeBlocks, stubAiFetch, type AiCall, type AnyEditor } from "@/test/ai-host";
import { useAiSession, type AiSessionValue } from "./AiSession";

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };
const KNOWLEDGE = { knowledgeId: "k_00000001", knowledgeWhen: "when it matters", knowledgeConclusion: "keep it" };
const DOC = [
  { id: "h1", type: "heading", props: { level: 2, ...KNOWLEDGE }, content: "Title" },
  { id: "p1", type: "paragraph", content: "body text" },
  { id: "p2", type: "paragraph", content: "untouched" },
];

let session!: AiSessionValue;
function Probe() {
  session = useAiSession();
  return null;
}
let editor: AnyEditor;

async function run(): Promise<AiCall> {
  editor = createTestEditor(DOC);
  const ai = stubAiFetch({ actions: [REWRITE] });
  renderAiHost({ editor, children: <Probe /> });
  await waitFor(() => expect(session.actions).toHaveLength(1));
  selectWholeBlocks(editor, "h1", "p1");
  act(() => session.open());
  act(() => {
    session.start(REWRITE_ACTION_ID);
  });
  await waitFor(() => expect(ai.calls).toHaveLength(1));
  return ai.calls[0]!;
}

async function reply(call: AiCall, text: string): Promise<void> {
  await act(async () => {
    call.delta(text);
    call.done();
  });
  await waitFor(() => expect(session.state.phase).not.toBe("streaming"));
}

const heading = () => (editor.getBlock("h1") ?? editor.document.find((b) => b.type === "heading"))!.props as Record<string, string>;

describe("AI box with knowledge", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the selected knowledge heading with its comment", async () => {
    const call = await run();
    expect(call.body.text).toContain("## Title\n<!-- knotebook:knowledge\nid: k_00000001\n");
    expect(call.body.text).toContain("when: when it matters");
  });

  it("a reply that drops the comment but keeps the heading is applied with the knowledge kept", async () => {
    const call = await run();
    await reply(call, "## Title\n\nrewritten body");
    expect(session.state.phase).toBe("done");
    expect(JSON.stringify(editor.document)).toContain("rewritten body");
    expect(heading()).toMatchObject(KNOWLEDGE);
  });

  it("a reply with an invalid knowledge comment ends in the error state and changes nothing", async () => {
    const call = await run();
    await reply(call, "## Title\n<!-- knotebook:knowledge\nid: k_00000001\nevidence: bogus\n-->\n\nrewritten body");
    expect(session.state).toMatchObject({ phase: "error", code: "invalid_knowledge" });
    expect(JSON.stringify(editor.document)).not.toContain("rewritten body");
    expect(heading()).toMatchObject(KNOWLEDGE);
  });

  it("a reply with a raw data-knowledge attribute does not set knowledge", async () => {
    const call = await run();
    await reply(call, '<h2 data-knowledge-id="k_000000ff" data-knowledge-when="x">Other</h2>\n\nrewritten body');
    expect(JSON.stringify(editor.document)).toContain("rewritten body");
    expect(JSON.stringify(editor.document)).not.toContain("k_000000ff");
  });
});
