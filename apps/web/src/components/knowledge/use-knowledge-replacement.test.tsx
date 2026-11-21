import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";
import { KnowledgeRefSourceContext, type KnowledgeRefSource } from "./ref-source";
import { useKnowledgeReplacement } from "./use-knowledge-replacement";
import { knowledgeEntries } from "./test-support";

const NOTE = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";

function entriesWith(supersededBy: string, status = "outdated") {
  return knowledgeEntries([
    { id: "k_00000001", blockId: "a", title: "Old", props: { knowledgeStatus: status, knowledgeSupersededBy: supersededBy } },
    { id: "k_00000002", blockId: "b", title: "New" },
  ]);
}

describe("useKnowledgeReplacement", () => {
  it("resolves a same-note reference at once and jumps to the heading", () => {
    const entries = entriesWith("k_00000002");
    const jump = vi.fn();
    const { result } = renderHook(() => useKnowledgeReplacement(entries[0]!, entries, NOTE, jump));
    expect(result.current).toMatchObject({ state: "found", title: "New" });
    result.current!.open!();
    expect(jump).toHaveBeenCalledWith("b");
  });

  it("is missing when the same-note target no longer exists, and null for knowledge that is not outdated", () => {
    const missing = entriesWith("k_0000000f");
    expect(renderHook(() => useKnowledgeReplacement(missing[0]!, missing, NOTE)).result.current).toMatchObject({ state: "missing" });
    const current = entriesWith("k_00000002", "");
    expect(renderHook(() => useKnowledgeReplacement(current[0]!, current, NOTE)).result.current).toBeNull();
  });

  it("another note's reference stays untitled and unlinked without a ref source", () => {
    const entries = entriesWith(`${OTHER}#k_0000000f`);
    const { result } = renderHook(() => useKnowledgeReplacement(entries[0]!, entries, NOTE));
    expect(result.current).toEqual({ state: "otherNote", title: null, open: null });
  });

  it("links to another note's knowledge once the ref source resolves it", async () => {
    const entries = entriesWith(`${OTHER}#k_0000000f`);
    const source: KnowledgeRefSource = {
      search: () => Promise.resolve([]),
      resolve: () => Promise.resolve({ ref: `${OTHER}#k_0000000f`, noteId: OTHER, noteTitle: "Other note", blockId: "z", heading: "Elsewhere", conclusion: "", href: `/n/${OTHER}#b-z` }),
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter>
        <KnowledgeRefSourceContext.Provider value={source}>{children}</KnowledgeRefSourceContext.Provider>
      </MemoryRouter>
    );
    const { result } = renderHook(() => useKnowledgeReplacement(entries[0]!, entries, NOTE), { wrapper });
    await waitFor(() => expect(result.current?.title).toBe("Elsewhere"));
    expect(result.current!.open).toBeTypeOf("function");
  });
});
