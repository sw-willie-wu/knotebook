import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteDto, NoteTagDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { NoteTagRow } from "./NoteTagRow";

const loaded = vi.hoisted(() => ({ count: 0 }));
vi.mock("./TagPillMenu", () => {
  loaded.count += 1;
  return { default: () => null };
});

const aws: NoteTagDto = { id: "t1", name: "AWS", color: "blue" };

function renderRow(tags: NoteTagDto[], canEdit: boolean) {
  const note = { id: "n1", groupId: null, tags } as unknown as NoteDto;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([note]) } as unknown as Response)),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NoteTagRow note={note} canEdit={canEdit} />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The module factory runs on first import only, so the count is cumulative and the "not loaded" case must stay first.
describe("NoteTagRow menu preload", () => {
  it("does not load the pill menu for a note without tags", async () => {
    renderRow([], true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loaded.count).toBe(0);
  });

  it("loads the pill menu once the note has a tag and can be edited", async () => {
    renderRow([aws], true);
    await waitFor(() => expect(loaded.count).toBe(1));
    expect(screen.getByRole("group")).toBeInTheDocument();
  });
});
