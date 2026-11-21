import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import "@/i18n/knowledge-strings";
import "@/i18n/knowledge-index-strings";
import { IndexRow } from "./IndexRow";
import type { IndexRowModel } from "./sections";
import { indexEntry, indexNote } from "./test-support";

const NOTE = indexNote({ id: "11111111-1111-4111-8111-111111111111", title: "Decisions", path: "/n/alice/decisions" });

function row(over: Partial<IndexRowModel["entry"]> = {}, extra: Partial<IndexRowModel> = {}): IndexRowModel {
  return {
    entry: indexEntry({ noteId: NOTE.id, knowledgeId: "k_aaaaaaaa", blockId: "b-1", heading: "D1", ...over }),
    note: NOTE,
    nested: [],
    replacement: null,
    ...extra,
  };
}

function view(model: IndexRowModel) {
  return render(
    <MemoryRouter>
      <ul>
        <IndexRow row={model} />
      </ul>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("IndexRow", () => {
  it("the row is one link to the note path with #b-<blockId>, showing the glyph, when → conclusion and note › heading", () => {
    view(row({ when: "Touching uploads", conclusion: "Do not resume" }));
    const link = screen.getByRole("link", { name: /Touching uploads/ });
    expect(link).toHaveAttribute("href", "/n/alice/decisions#b-b-1");
    expect(within(link).getByRole("img", { name: "Knowledge info: Verified" })).toBeInTheDocument();
    expect(link).toHaveTextContent("Touching uploads");
    expect(link).toHaveTextContent("Do not resume");
    expect(link).toHaveTextContent("Decisions › D1");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("when only, conclusion only, and neither (the heading, or Untitled heading) render without a dangling arrow", () => {
    const { container, unmount } = view(row({ when: "Only when" }));
    expect(container.textContent).not.toContain("→");
    unmount();
    const second = view(row({ conclusion: "Only conclusion" }));
    expect(second.container.textContent).not.toContain("→");
    expect(second.container.textContent).toContain("Only conclusion");
    second.unmount();
    const both = view(row({ when: "W", conclusion: "C" }));
    expect(both.container.textContent).toContain("W");
    expect(both.container.textContent).toContain("→");
    both.unmount();
    const neither = view(row({ heading: "Plain heading" }));
    expect(screen.getByRole("link")).toHaveTextContent("Plain heading");
    neither.unmount();
    view(row({ heading: "" }));
    expect(screen.getByRole("link")).toHaveTextContent("Untitled heading");
  });

  it("needs review rows have the amber flag classes; outdated rows are faded and show replaced by with a link to the replacement", () => {
    const flagged = view(row({ icon: "needsReview", status: "unverified", when: "w" }));
    expect(flagged.container.querySelector("[data-kb-index-row]")).toHaveAttribute("data-kind", "needsReview");
    expect(flagged.container.querySelector("[data-kb-index-row]")?.className).toContain("bg-[#fffaf0]");
    flagged.unmount();

    const target = { noteId: "n2", knowledgeId: "k_bbbbbbbb", blockId: "b-9", heading: "D3", noteTitle: "Other", path: "/n/alice/other" };
    const old = view(row({ icon: "outdated", status: "outdated", when: "w", supersededBy: "n2#k_bbbbbbbb" }, { replacement: { state: "found", target } }));
    const card = old.container.querySelector("[data-kb-index-row]")!;
    expect(card.className).toContain("opacity-60");
    const replaced = screen.getByRole("link", { name: "→ replaced by D3" });
    expect(replaced).toHaveAttribute("href", "/n/alice/other#b-b-9");
    expect(screen.getAllByRole("link")).toHaveLength(2);
    old.unmount();

    const other = view(row({ icon: "outdated", status: "outdated", when: "w" }, { replacement: { state: "otherNote" } }));
    expect(other.container).toHaveTextContent("→ replaced by knowledge in another note");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    other.unmount();
    view(row({ icon: "outdated", status: "outdated", when: "w" }, { replacement: { state: "missing" } }));
    expect(screen.getByText("→ replaced by knowledge that no longer exists")).toBeInTheDocument();
  });

  it("a parent row shows the summary line, adding the outdated count only when there is one", () => {
    const first = view(row({ summary: { total: 3, verified: 1, noVerifiedDate: 1, needsReview: 1, outdated: 0 } }));
    expect(first.container).toHaveTextContent("3 below: 1 verified, 1 not verified, 1 need review");
    expect(first.container.textContent).not.toContain("outdated");
    first.unmount();
    const second = view(row({ summary: { total: 3, verified: 0, noVerifiedDate: 1, needsReview: 1, outdated: 1 } }));
    expect(second.container).toHaveTextContent("3 below: 0 verified, 1 not verified, 1 need review, 1 outdated");
    second.unmount();
  });

  it("the glyph is role=img inside the link, not a button", () => {
    view(row({ when: "w", icon: "needsReview", status: "unverified" }));
    const link = screen.getByRole("link");
    expect(within(link).getByRole("img", { name: "Knowledge info: Needs review" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("nested rows render inside a list under their parent", () => {
    const child = row({ knowledgeId: "k_cccccccc", blockId: "b-2", heading: "D1.1", parentKnowledgeId: "k_aaaaaaaa" });
    view(row({ when: "w" }, { nested: [child] }));
    const lists = screen.getAllByRole("list");
    expect(lists).toHaveLength(2);
    expect(within(lists[1]!).getByRole("link")).toHaveAttribute("href", "/n/alice/decisions#b-b-2");
  });

  it("a note without a title shows Untitled in the location", () => {
    view({ ...row({ when: "w" }), note: { ...NOTE, title: "" } });
    expect(screen.getByRole("link")).toHaveTextContent("Untitled › D1");
  });
});
