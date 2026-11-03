import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { SearchResults } from "./SearchResults";

/**
 * #93 PR2 T5 S5／S9：內文區的 lazy chunk 什麼時候載入。lazy 是模組級單例、`vi.mock` 的 factory 只跑一次，
 * 所以本檔的案**有順序**：先驗「不載」的三種字，再驗「2 個字就先載 chunk、還沒發請求」，最後才驗會載的 `" ab "`。
 */
const flags = vi.hoisted(() => ({ bodySearchLoaded: false }));
vi.mock("@/components/sidebar/BodySearchLazy", async (importOriginal) => {
  flags.bodySearchLoaded = true;
  return await importOriginal();
});

const NOTE: NoteDto = {
  id: "n1", title: "Beta", ownerId: "u1", role: "owner", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "slug-n1", slugIsCustom: false, prevSlug: null, ownerHandle: "o", lastEdited: null, group: null, groupId: null, folderId: null,
  permissions: OWNER_PERMS,
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
let searchUrls: string[] = [];

beforeEach(async () => {
  await i18n.changeLanguage("en");
  searchUrls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/notes") return Promise.resolve(json([NOTE]));
      if (url === "/api/groups") return Promise.resolve(json([]));
      if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
      if (url.startsWith("/api/search?")) {
        searchUrls.push(url);
        return Promise.resolve(json({ hits: [], nextCursor: null }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderControlled(initial: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (q: string) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SearchResults query={q} />
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const r = render(tree(initial));
  return { ...r, setQuery: (q: string) => r.rerender(tree(q)) };
}
const settle = () => new Promise((r) => setTimeout(r, 400)); // 過了 300 ms 防抖

describe("S5／S9 內文區何時載入", () => {
  it("S5 只打空白：不發 /api/search、不載 chunk；標題 0 → noMatch", async () => {
    renderControlled("  ");
    expect(await screen.findByText("No notes match your search.")).toBeInTheDocument();
    await settle();
    expect(searchUrls).toEqual([]);
    expect(flags.bodySearchLoaded).toBe(false);
  });

  it("S5 一個字：提示句、不發、不載；標題 0 → noMatch", async () => {
    renderControlled("z");
    expect(await screen.findByText("Type one more character to search note text too.")).toBeInTheDocument();
    expect(screen.getByText("No notes match your search.")).toBeInTheDocument();
    await settle();
    expect(searchUrls).toEqual([]);
    expect(flags.bodySearchLoaded).toBe(false);
  });

  it("S5 201 字：提示句、不發、不載", async () => {
    renderControlled("b".repeat(201));
    expect(await screen.findByText("Too long to search note text; matching titles only.")).toBeInTheDocument();
    await settle();
    expect(searchUrls).toEqual([]);
    expect(flags.bodySearchLoaded).toBe(false);
  });

  it("S9 一到 2 個字就先載 chunk，即使 300 ms 還沒過、還沒發請求", async () => {
    const r = renderControlled("b");
    await screen.findByRole("link", { name: /^Beta/ }); // 清單到了（SearchResults 過了提前 return）
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); // 防抖的 setTimeout 不會自己到期
    act(() => r.setQuery("be"));
    // 不用 waitFor：RTL 的 asyncWrapper 會 await 一個 setTimeout(0)，被 fake 掉就卡住。改以 setImmediate（沒被 fake）讓出。
    for (let i = 0; i < 500 && !flags.bodySearchLoaded; i += 1) await new Promise((res) => setImmediate(res));
    expect(flags.bodySearchLoaded).toBe(true);
    expect(searchUrls).toEqual([]);
  });

  it("S5 \" ab \" 發的是 q=ab", async () => {
    renderControlled(" ab ");
    await waitFor(() => expect(searchUrls.length).toBe(1));
    expect(new URL(searchUrls[0]!, "http://x").searchParams.get("q")).toBe("ab");
  });
});
