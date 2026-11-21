import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { summarizeKnowledgeDescendants, type KnowledgeEntry } from "@knotebook/shared";
import i18n from "@/i18n";
import "@/i18n/knowledge-strings";
import { KnowledgeCard, type KnowledgeCardProps } from "./KnowledgeCard";
import { knowledgeEntries, type KnowledgeFixture } from "./test-support";

function card(overrides: Partial<KnowledgeCardProps> & { entry: KnowledgeEntry }) {
  const props: KnowledgeCardProps = {
    parent: null,
    outdatedAncestor: null,
    summary: null,
    replacement: null,
    variant: "hover",
    canEdit: false,
    onEdit: vi.fn(),
    onJump: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<KnowledgeCard {...props} />) };
}

const one = (props: Record<string, string> = {}, extra: Partial<KnowledgeFixture> = {}) =>
  knowledgeEntries([{ id: "k_00000001", blockId: "a", title: "Alpha", props, ...extra }])[0]!;

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("KnowledgeCard", () => {
  it("shows when to read and conclusion, then basis, then last verified, with Unconfirmed and Not verified for empty values", () => {
    const { container } = card({ entry: one() });
    const labels = [...container.querySelectorAll("dt")].map((n) => n.textContent);
    expect(labels).toEqual(["When to read", "Conclusion", "Basis", "Last verified"]);
    const values = [...container.querySelectorAll("dd")].map((n) => n.textContent);
    expect(values).toEqual(["when alice", "conclusion bob", "Unconfirmed", "Not verified"]);
  });

  it("shows the basis and the date when they are set, and a dash for an empty when or conclusion", () => {
    const { container } = card({ entry: one({ knowledgeEvidence: "tested", knowledgeVerified: "2026-10-30", knowledgeWhen: "", knowledgeConclusion: "" }) });
    const values = [...container.querySelectorAll("dd")].map((n) => n.textContent);
    expect(values).toEqual(["—", "—", "Tested", "2026-10-30"]);
  });

  it("needs review shows the amber banner with the last verified date, or the no-date wording", () => {
    const view = card({ entry: one({ knowledgeStatus: "unverified", knowledgeVerified: "2026-10-30" }) });
    expect(screen.getByText("Needs review · last verified 2026-10-30, worth checking again")).toBeInTheDocument();
    expect(view.container.querySelector("[data-kb-knowledge-banner='amber']")).not.toBeNull();
    view.unmount();
    card({ entry: one({ knowledgeStatus: "unverified" }) });
    expect(screen.getByText("Needs review · worth checking again")).toBeInTheDocument();
  });

  it("an outdated knowledge shows the red banner whose title link jumps to the replacement; another note's replacement shows the fallback text unlinked", () => {
    const open = vi.fn();
    const entry = one({ knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000002" });
    const view = card({ entry, replacement: { state: "found", title: "Beta", open } });
    const banner = view.container.querySelector("[data-kb-knowledge-banner='red']")!;
    expect(banner.textContent).toBe("Outdated → replaced by Beta");
    fireEvent.click(within(banner as HTMLElement).getByRole("button", { name: "Beta" }));
    expect(open).toHaveBeenCalledTimes(1);
    view.unmount();

    const other = card({ entry, replacement: { state: "otherNote", title: null, open: null } });
    const text = other.container.querySelector("[data-kb-knowledge-banner='red']")!;
    expect(text.textContent).toBe("Outdated → replaced by knowledge in another note");
    expect(within(text as HTMLElement).queryByRole("button")).toBeNull();
    other.unmount();

    const missing = card({ entry, replacement: { state: "missing", title: null, open: null } });
    expect(missing.container.textContent).toContain("replaced by knowledge that no longer exists");
  });

  it.each(["Use <br/> here", "<0>x</0> and <ref>y</ref>", "a < b > c"])("a replacement titled %j is shown as plain text inside the link", async (title) => {
    const entry = one({ knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000002" });
    for (const lang of ["en", "zh-TW"]) {
      await i18n.changeLanguage(lang);
      const open = vi.fn();
      const view = card({ entry, replacement: { state: "found", title, open } });
      const banner = view.container.querySelector("[data-kb-knowledge-banner='red']")!;
      const links = banner.querySelectorAll("button");
      expect(links).toHaveLength(1);
      expect(links[0]!.textContent).toContain(title);
      expect(banner.querySelector("br")).toBeNull();
      view.unmount();
    }
    await i18n.changeLanguage("en");
  });

  it("an ancestor titled with markup is shown as plain text inside the inherited banner's link", () => {
    const [parent, child] = knowledgeEntries([
      { id: "k_00000001", blockId: "p", title: "<0>x</0><br/>", props: { knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000009" } },
      { id: "k_00000002", blockId: "c", title: "Child", level: 2 },
    ]) as [KnowledgeEntry, KnowledgeEntry];
    const { container } = card({ entry: child, parent, outdatedAncestor: parent });
    const banner = container.querySelector("[data-kb-knowledge-banner='red']")!;
    expect(banner.querySelector("br")).toBeNull();
    expect(banner.querySelector("button")!.textContent).toBe("<0>x</0><br/>");
  });

  it("a knowledge under an outdated parent shows the inherited banner linking to the parent", () => {
    const [parent, child] = knowledgeEntries([
      { id: "k_00000001", blockId: "p", title: "Parent", props: { knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000009" } },
      { id: "k_00000002", blockId: "c", title: "Child", level: 2 },
    ]) as [KnowledgeEntry, KnowledgeEntry];
    const { props, container } = card({ entry: child, parent, outdatedAncestor: parent });
    const banner = container.querySelector("[data-kb-knowledge-banner='red']")!;
    expect(banner.textContent).toBe("Outdated: Parent above is outdated");
    fireEvent.click(within(banner as HTMLElement).getByRole("button", { name: "Parent" }));
    expect(props.onJump).toHaveBeenCalledWith("p");
  });

  it("a nested knowledge shows a Part of link in the top row that jumps to the parent heading", () => {
    const [parent, child] = knowledgeEntries([
      { id: "k_00000001", blockId: "p", title: "Parent" },
      { id: "k_00000002", blockId: "c", title: "Child", level: 2 },
    ]) as [KnowledgeEntry, KnowledgeEntry];
    const { props } = card({ entry: child, parent });
    fireEvent.click(screen.getByRole("button", { name: "Part of: Parent" }));
    expect(props.onJump).toHaveBeenCalledWith("p");
  });

  it("a parent shows the summary line last, adding the outdated count only when there is one", () => {
    const entries = knowledgeEntries([
      { id: "k_00000001", blockId: "p", title: "Parent" },
      { id: "k_00000002", blockId: "a", level: 2, props: { knowledgeVerified: "2026-10-01" } },
      { id: "k_00000003", blockId: "b", level: 2 },
      { id: "k_00000004", blockId: "c", level: 2, props: { knowledgeStatus: "unverified" } },
    ]);
    const view = card({ entry: entries[0]!, summary: summarizeKnowledgeDescendants(entries, "p") });
    const summary = view.container.querySelector("p")!;
    expect(summary.textContent).toBe("3 below: 1 verified, 1 not verified, 1 need review");
    expect(view.container.querySelector("[data-kb-knowledge-card]")!.lastElementChild).toBe(summary);
    view.unmount();

    const withOutdated = knowledgeEntries([
      { id: "k_00000001", blockId: "p", title: "Parent" },
      { id: "k_00000002", blockId: "a", level: 2, props: { knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000009" } },
    ]);
    const second = card({ entry: withOutdated[0]!, summary: summarizeKnowledgeDescendants(withOutdated, "p") });
    expect(second.container.querySelector("p")!.textContent).toBe("1 below: 0 verified, 0 not verified, 0 need review, 1 outdated");
  });

  it("Edit with a pencil icon sits at the top right only when canEdit", () => {
    const view = card({ entry: one(), canEdit: false });
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    view.unmount();
    const { props } = card({ entry: one(), canEdit: true });
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit.querySelector("svg[data-icon='pencil']")).not.toBeNull();
    fireEvent.click(edit);
    expect(props.onEdit).toHaveBeenCalledTimes(1);
  });

  it("the sheet variant puts a 44px Edit button and the footer in the action row", () => {
    card({ entry: one(), variant: "sheet", canEdit: true, footer: <button type="button">Mark as verified</button> });
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit).toHaveClass("h-11");
    expect(edit.previousElementSibling).toHaveTextContent("Mark as verified");
  });

  it("zh-TW uses the Chinese labels", async () => {
    await i18n.changeLanguage("zh-TW");
    const { container } = card({ entry: one({ knowledgeStatus: "unverified" }) });
    expect([...container.querySelectorAll("dt")].map((n) => n.textContent)).toEqual(["何時讀", "結論", "依據", "最後驗證日"]);
    expect(container.textContent).toContain("待驗證・建議重新確認");
    await i18n.changeLanguage("en");
  });
});
