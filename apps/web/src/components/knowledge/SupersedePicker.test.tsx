import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import "@/i18n/knowledge-strings";
import { SupersedePicker } from "./SupersedePicker";
import type { KnowledgeRefCandidate, KnowledgeRefSource } from "./ref-source";

const candidate = (ref: string, noteId: string | null): KnowledgeRefCandidate => ({
  ref,
  noteId,
  noteTitle: noteId === null ? null : "Other",
  blockId: `b_${ref}`,
  heading: `H ${ref}`,
  conclusion: "",
  href: null,
});

const source = (items: KnowledgeRefCandidate[]): KnowledgeRefSource => ({
  search: () => Promise.resolve(items),
  resolve: () => Promise.resolve(null),
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("SupersedePicker", () => {
  it("Enter picks the highlighted row, and the highlight returns into range when the remote rows disappear", async () => {
    const onChange = vi.fn();
    const remoteRows = [candidate("n#r1", "n"), candidate("n#r2", "n"), candidate("n#r3", "n")];
    render(
      <>
        <span id="lbl">Replaced by</span>
        <SupersedePicker id="p" labelledBy="lbl" value="" source={source([candidate("k_local", null)])} remote={source(remoteRows)} onChange={onChange} />
      </>,
    );
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "x" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(4), { timeout: 2000 });
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[3]!.id);
    // An input-method composition drops the remote rows; the highlight was on the last of them.
    act(() => {
      fireEvent.compositionStart(input);
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(input).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[0]!.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("k_local");
  });
});
