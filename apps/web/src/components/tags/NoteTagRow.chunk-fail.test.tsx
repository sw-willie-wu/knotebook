import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteDto, NoteTagDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { NoteTagRow } from "./NoteTagRow";

vi.mock("./TagPillMenu", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

const aws: NoteTagDto = { id: "t1", name: "AWS", color: "blue" };
const note = { id: "n1", groupId: null, tags: [aws] } as unknown as NoteDto;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = url === "/api/notes" ? [note] : url === "/api/notes/n1/tags/t1" && method === "DELETE" ? { tags: [] } : [];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NoteTagRow when the pill menu chunk cannot be loaded", () => {
  it("falls back to a plain pill that can still be removed", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <NoteTagRow note={note} canEdit />
      </QueryClientProvider>,
    );
    const remove = await screen.findByRole("button", { name: "Remove tag AWS" });
    expect(screen.queryByRole("button", { name: "Tag AWS" })).toBeNull();
    remove.click();
    await waitFor(() =>
      expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([u, i]) => u === "/api/notes/n1/tags/t1" && i?.method === "DELETE")).toBe(true),
    );
  });
});
