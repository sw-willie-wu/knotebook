import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { KnowledgeIndexDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SidebarDrawerContext } from "@/lib/sidebar-drawer";
import { PhoneListContext } from "@/lib/phone-list";
import { stubLayoutTier } from "@/test/layout-tier";
import { indexDto, indexEntry, indexNote } from "@/components/knowledge-index/test-support";
import KnowledgeIndexPage, { IndexBody } from "./KnowledgeIndexPage";

const NOTE = indexNote({ id: "11111111-1111-4111-8111-111111111111", title: "Decisions", path: "/n/alice/decisions" });
const withOne = (over: Partial<KnowledgeIndexDto> = {}) =>
  indexDto({ notes: [NOTE], entries: [indexEntry({ noteId: NOTE.id, knowledgeId: "k_aaaaaaaa", when: "Touching uploads", conclusion: "Do not resume" })], ...over });

function respond(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

function stubIndex(handler: (url: string) => Response) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(handler(String(input)));
    }),
  );
  return urls;
}

function renderAt(path: string, { backToList = vi.fn(), setOpen = vi.fn() } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SidebarDrawerContext.Provider value={{ setOpen }}>
        <PhoneListContext.Provider value={{ backToList }}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/knowledge/me" element={<KnowledgeIndexPage />} />
              <Route path="/knowledge/g/:groupId" element={<KnowledgeIndexPage />} />
              <Route path="/knowledge/f/:folderId" element={<KnowledgeIndexPage />} />
            </Routes>
          </MemoryRouter>
        </PhoneListContext.Provider>
      </SidebarDrawerContext.Provider>
    </QueryClientProvider>,
  );
  return { ...view, backToList, setOpen };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  stubLayoutTier("docked");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("KnowledgeIndexPage", () => {
  it("the personal index titles itself My notes · Index and lists the rows", async () => {
    const urls = stubIndex(() => respond(200, withOne()));
    renderAt("/knowledge/me");
    expect(await screen.findByRole("heading", { level: 1, name: "My notes · Index" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Touching uploads/ })).toHaveAttribute("href", "/n/alice/decisions#b-b_k_aaaaaaaa");
    expect(urls).toEqual(["/api/knowledge/index/me"]);
    expect(screen.getByText("Built from the knowledge info in these notes. Read-only. 1 piece of knowledge")).toBeInTheDocument();
  });

  it("a folder index shows its path under the title and a group index its group name", async () => {
    stubIndex(() =>
      respond(200, withOne({ scope: { kind: "folder", groupId: "g1", groupName: "R&D", folderId: "f2", folderPath: ["Projects", "roadeye"] } })),
    );
    const folder = renderAt("/knowledge/f/f2");
    expect(await screen.findByRole("heading", { level: 1, name: "roadeye · Index" })).toBeInTheDocument();
    expect(screen.getByText("R&D / Projects / roadeye")).toBeInTheDocument();
    folder.unmount();

    stubIndex(() => respond(200, withOne({ scope: { kind: "group", groupId: "g1", groupName: "R&D", folderId: null, folderPath: [] } })));
    renderAt("/knowledge/g/g1");
    expect(await screen.findByRole("heading", { level: 1, name: "R&D · Index" })).toBeInTheDocument();
  });

  it("404 shows Index not found, with no hint of which case it was", async () => {
    stubIndex(() => respond(404, { error: { code: "not_found", message: "No folder or group with that id." } }));
    renderAt("/knowledge/f/nope");
    expect(await screen.findByText("Index not found")).toBeInTheDocument();
    expect(screen.getByText("The folder or group doesn't exist, or you can't open its index.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("another error shows a message and Try again refetches", async () => {
    let calls = 0;
    stubIndex(() => {
      calls += 1;
      return calls === 1 ? respond(500, { error: { code: "internal", message: "boom" } }) : respond(200, withOne());
    });
    renderAt("/knowledge/me");
    const retry = await screen.findByRole("button", { name: "Try again" });
    retry.click();
    expect(await screen.findByRole("link", { name: /Touching uploads/ })).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it("shows a loading line first", () => {
    stubIndex(() => respond(200, withOne()));
    renderAt("/knowledge/me");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("backfillPending shows the notice; truncated shows the hint with 5000", async () => {
    stubIndex(() => respond(200, withOne({ backfillPending: true, truncated: true })));
    renderAt("/knowledge/me");
    expect(await screen.findByText("Older notes are still being indexed, so some knowledge may be missing for a few minutes.")).toBeInTheDocument();
    expect(screen.getByText("Showing the first 5000. Open the index of a subfolder or add a filter to see the rest.")).toBeInTheDocument();
  });

  it("the header has the sidebar button below xl and the back button only on a phone", async () => {
    stubIndex(() => respond(200, withOne()));
    const wide = renderAt("/knowledge/me");
    await screen.findByRole("link", { name: /Touching uploads/ });
    expect(screen.getByRole("button", { name: "Open sidebar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to notes" })).toBeNull();
    wide.unmount();

    stubLayoutTier("phone");
    const phone = renderAt("/knowledge/me");
    await screen.findByRole("link", { name: /Touching uploads/ });
    screen.getByRole("button", { name: "Back to notes" }).click();
    expect(phone.backToList).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Open sidebar" })).toBeNull();
  });

  it("renders no favorite star and no edit control", async () => {
    stubIndex(() => respond(200, withOne()));
    renderAt("/knowledge/me");
    await screen.findByRole("link", { name: /Touching uploads/ });
    expect(screen.queryByRole("button", { name: /favorite/i })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
  });

  it("an empty scope shows the explanation and no rows", async () => {
    stubIndex(() => respond(200, indexDto()));
    renderAt("/knowledge/me");
    expect(await screen.findByText("No knowledge here yet")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("link")).toBeNull());
  });
});

describe("IndexBody", () => {
  it("no entries without filters shows the empty explanation; with filters it shows No knowledge matches", () => {
    const { rerender } = render(
      <MemoryRouter>
        <IndexBody dto={indexDto()} filtersActive={false} groupBy="folder" scopeTitle="My notes" />
      </MemoryRouter>,
    );
    expect(screen.getByText("No knowledge here yet")).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <IndexBody dto={indexDto()} filtersActive groupBy="folder" scopeTitle="My notes" />
      </MemoryRouter>,
    );
    expect(screen.getByText("No knowledge matches these filters.")).toBeInTheDocument();
    expect(screen.queryByText("No knowledge here yet")).toBeNull();
  });

  it("titles the sections and shows the count of each", () => {
    const dto = withOne({ folders: [{ id: "f1", name: "sub", parentId: null }], notes: [NOTE, indexNote({ id: "22222222-2222-4222-8222-222222222222", title: "Inner", folderId: "f1" })] });
    dto.entries.push(indexEntry({ noteId: "22222222-2222-4222-8222-222222222222", knowledgeId: "k_bbbbbbbb", when: "x" }));
    render(
      <MemoryRouter>
        <IndexBody dto={dto} filtersActive={false} groupBy="folder" scopeTitle="My notes" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 2, name: /My notes/ })).toHaveTextContent("1");
    expect(screen.getByRole("heading", { level: 2, name: /sub/ })).toBeInTheDocument();
  });
});
