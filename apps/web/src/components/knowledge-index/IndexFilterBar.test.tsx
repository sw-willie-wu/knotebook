import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import "@/i18n/knowledge-strings";
import "@/i18n/knowledge-index-strings";
import { chooseOption, displayedLabel, optionLabels } from "@/test/ui-select";
import { pressTrigger } from "@/test/menu-trigger";
import type { IndexFilters } from "@/api/knowledge";
import { IndexFilterBar } from "./IndexFilterBar";
import { tag } from "./test-support";

const T1 = tag("11111111-1111-4111-8111-111111111111", "ops", "blue");
const T2 = tag("22222222-2222-4222-8222-222222222222", "design", "green");
const NONE: IndexFilters = { groupBy: "folder", tagIds: [], status: null, evidence: null };

function bar(filters: IndexFilters = NONE, tagOptions = [T1, T2]) {
  const onChange = vi.fn();
  const view = render(<IndexFilterBar filters={filters} tagOptions={tagOptions} onChange={onChange} />);
  return { onChange, ...view };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("IndexFilterBar", () => {
  it("the group-by and tag controls are absent when tagOptions is empty", () => {
    bar(NONE, []);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Tags/ })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Basis" })).toBeInTheDocument();
  });

  it("group-by is a radio group named Group by whose current value follows the filters; choosing the other one calls onChange", () => {
    const { onChange } = bar();
    const group = screen.getByRole("radiogroup", { name: "Group by" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Folder" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Tag" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Tag" }));
    expect(onChange).toHaveBeenCalledWith({ ...NONE, groupBy: "tag" });
  });

  it("group-by moves with the arrow keys like a radio group", () => {
    const { onChange } = bar();
    fireEvent.keyDown(screen.getByRole("radio", { name: "Folder" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith({ ...NONE, groupBy: "tag" });
  });

  it("ticking two tags calls onChange with both and keeps the menu open", async () => {
    const view = bar();
    pressTrigger(screen.getByRole("button", { name: "Tags" }));
    const first = await screen.findByRole("menuitemcheckbox", { name: "ops" });
    fireEvent.click(first);
    expect(view.onChange).toHaveBeenLastCalledWith({ ...NONE, tagIds: [T1.id] });
    // The parent owns the state; feed the new filters back in.
    view.rerender(<IndexFilterBar filters={{ ...NONE, tagIds: [T1.id] }} tagOptions={[T1, T2]} onChange={view.onChange} />);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "design" }));
    expect(view.onChange).toHaveBeenLastCalledWith({ ...NONE, tagIds: [T1.id, T2.id] });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("the tag button shows how many tags are chosen, and unticking removes only that tag", async () => {
    const both = { ...NONE, tagIds: [T1.id, T2.id] };
    const { onChange } = bar(both);
    pressTrigger(screen.getByRole("button", { name: "Tags (2)" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "ops" })).toBeChecked();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "ops" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...NONE, tagIds: [T2.id] });
  });

  it("status and basis selects list All and the options in the knowledge wording", async () => {
    bar();
    expect(await optionLabels(screen.getByRole("combobox", { name: "Status" }))).toEqual([
      "Status: All",
      "Status: Not verified",
      "Status: Needs review",
      "Status: Outdated",
    ]);
    expect(await optionLabels(screen.getByRole("combobox", { name: "Basis" }))).toEqual([
      "Basis: All",
      "Basis: Tested",
      "Basis: Documentation",
      "Basis: Inferred",
      "Basis: Unconfirmed",
    ]);
  });

  it("choosing a status or basis calls onChange with it, and All sets it back to null", async () => {
    const { onChange, rerender } = bar();
    await chooseOption(screen.getByRole("combobox", { name: "Status" }), "Status: Outdated");
    expect(onChange).toHaveBeenLastCalledWith({ ...NONE, status: "outdated" });
    const withStatus = { ...NONE, status: "outdated" as const };
    rerender(<IndexFilterBar filters={withStatus} tagOptions={[T1, T2]} onChange={onChange} />);
    expect(displayedLabel(screen.getByRole("combobox", { name: "Status" }))).toBe("Status: Outdated");
    await chooseOption(screen.getByRole("combobox", { name: "Status" }), "Status: All");
    expect(onChange).toHaveBeenLastCalledWith(NONE);
    await chooseOption(screen.getByRole("combobox", { name: "Basis" }), "Basis: Tested");
    expect(onChange).toHaveBeenLastCalledWith({ ...withStatus, evidence: "tested" });
  });

  it("Clear filters appears only with a filter set and clears tags, status and basis but keeps grouping", () => {
    const { onChange, rerender } = bar({ ...NONE, groupBy: "tag" });
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    rerender(<IndexFilterBar filters={{ groupBy: "tag", tagIds: [T1.id], status: "outdated", evidence: "docs" }} tagOptions={[T1, T2]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onChange).toHaveBeenCalledWith({ groupBy: "tag", tagIds: [], status: null, evidence: null });
  });

  it("the Chinese wording uses the full-width colon", async () => {
    await i18n.changeLanguage("zh-TW");
    bar();
    expect(displayedLabel(screen.getByRole("combobox", { name: "狀態" }))).toBe("狀態：全部");
  });
});
