import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { KnowledgeIndexDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SidebarDrawerContext } from "@/lib/sidebar-drawer";
import { PhoneListContext } from "@/lib/phone-list";
import { stubLayoutTier } from "@/test/layout-tier";
import { chooseOption } from "@/test/ui-select";
import { indexDto, indexEntry, indexNote, tag } from "@/components/knowledge-index/test-support";
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

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="loc">{location.pathname + location.search}</output>;
}

function renderAt(path: string, { backToList = vi.fn(), setOpen = vi.fn() } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SidebarDrawerContext.Provider value={{ setOpen }}>
        <PhoneListContext.Provider value={{ backToList }}>
          <MemoryRouter initialEntries={[path]}>
            <LocationProbe />
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
  it("a capped note gets a line naming it in its section; an uncapped one gets none", async () => {
    const other = indexNote({ id: "22222222-2222-4222-8222-222222222222", title: "Plain", path: "/n/alice/plain" });
    stubIndex(() =>
      respond(
        200,
        withOne({
          notes: [{ ...NOTE, capped: true }, other],
          entries: [
            indexEntry({ noteId: NOTE.id, knowledgeId: "k_aaaaaaaa", when: "Touching uploads" }),
            indexEntry({ noteId: other.id, knowledgeId: "k_bbbbbbbb", when: "Touching builds" }),
          ],
        }),
      ),
    );
    renderAt("/knowledge/me");
    expect(await screen.findByText("Decisions: only the first 2000 are listed for this note.")).toBeInTheDocument();
    expect(screen.queryByText(/Plain: only the first/)).toBeNull();
  });

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

const T1 = tag("11111111-1111-4111-8111-111111111111", "ops", "blue");
const T2 = tag("22222222-2222-4222-8222-222222222222", "design", "green");
const TAGGED = { ...NOTE, tags: [T1] };
const withTags = (over: Partial<KnowledgeIndexDto> = {}) => withOne({ notes: [TAGGED], tagOptions: [T1, T2], ...over });
const loc = () => screen.getByTestId("loc").textContent;

describe("KnowledgeIndexPage filters", () => {
  it("changing a filter replaces the URL query and refetches with the new query", async () => {
    const urls = stubIndex(() => respond(200, withTags()));
    renderAt("/knowledge/me");
    await screen.findByRole("link", { name: /Touching uploads/ });
    await chooseOption(screen.getByRole("combobox", { name: "Status" }), "Status: Outdated");
    await waitFor(() => expect(loc()).toBe("/knowledge/me?status=outdated"));
    await waitFor(() => expect(urls).toContain("/api/knowledge/index/me?status=outdated"));
    await chooseOption(screen.getByRole("combobox", { name: "Basis" }), "Basis: Tested");
    await waitFor(() => expect(loc()).toBe("/knowledge/me?status=outdated&evidence=tested"));
  });

  it("the filters in the URL are restored: they are in the request and in the controls", async () => {
    const urls = stubIndex(() => respond(200, withTags()));
    renderAt(`/knowledge/me?group=tag&tags=${T1.id}&status=needsReview&evidence=docs`);
    await screen.findByRole("link", { name: /Touching uploads/ });
    expect(urls).toEqual([`/api/knowledge/index/me?tags=${T1.id}&status=needsReview&evidence=docs`]);
    expect(screen.getByRole("radio", { name: "Tag" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Tags (1)" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveTextContent("Status: Needs review");
    expect(screen.getByRole("combobox", { name: "Basis" })).toHaveTextContent("Basis: Documentation");
  });

  it("values the page doesn't know are ignored without an error and without rewriting the URL", async () => {
    const urls = stubIndex(() => respond(200, withTags()));
    renderAt("/knowledge/me?status=bogus&evidence=%E2%98%83&tags=nope,,&group=sideways&extra=1");
    await screen.findByRole("link", { name: /Touching uploads/ });
    expect(urls).toEqual(["/api/knowledge/index/me"]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(loc()).toContain("status=bogus");
  });

  it("a tag id in the URL that isn't in tagOptions is dropped from the URL after the answer arrives", async () => {
    const gone = "99999999-9999-4999-8999-999999999999";
    const urls = stubIndex((url) => (url.includes(gone) ? respond(200, withTags({ entries: [], notes: [] })) : respond(200, withTags())));
    renderAt(`/knowledge/me?tags=${gone},${T1.id}&status=outdated`);
    await waitFor(() => expect(loc()).toBe(`/knowledge/me?tags=${T1.id}&status=outdated`));
    expect(await screen.findByRole("link", { name: /Touching uploads/ })).toBeInTheDocument();
    expect(urls).toEqual([`/api/knowledge/index/me?tags=${gone}%2C${T1.id}&status=outdated`, `/api/knowledge/index/me?tags=${T1.id}&status=outdated`]);
  });

  it("switching to tag grouping renders tag sections without refetching and writes group=tag", async () => {
    const urls = stubIndex(() => respond(200, withTags()));
    renderAt("/knowledge/me");
    await screen.findByRole("link", { name: /Touching uploads/ });
    fireEvent.click(screen.getByRole("radio", { name: "Tag" }));
    expect(await screen.findByRole("heading", { level: 2, name: /ops/ })).toBeInTheDocument();
    expect(loc()).toBe("/knowledge/me?group=tag");
    expect(urls).toEqual(["/api/knowledge/index/me"]);
  });

  it("group=tag in the URL with no tags in the scope falls back to folder grouping", async () => {
    stubIndex(() => respond(200, withOne()));
    renderAt("/knowledge/me?group=tag");
    expect(await screen.findByRole("heading", { level: 2, name: /My notes/ })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("no match with filters keeps the filter bar so they can be cleared; Clear filters empties the query", async () => {
    stubIndex((url) => (url.includes("status=outdated") ? respond(200, withTags({ entries: [], notes: [] })) : respond(200, withTags())));
    renderAt("/knowledge/me?group=tag&status=outdated");
    expect(await screen.findByText("No knowledge matches these filters.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(loc()).toBe("/knowledge/me?group=tag"));
    expect(await screen.findByRole("link", { name: /Touching uploads/ })).toBeInTheDocument();
  });

  it("an empty scope without filters shows no filter bar", async () => {
    stubIndex(() => respond(200, indexDto()));
    renderAt("/knowledge/me");
    await screen.findByText("No knowledge here yet");
    expect(screen.queryByRole("combobox")).toBeNull();
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
