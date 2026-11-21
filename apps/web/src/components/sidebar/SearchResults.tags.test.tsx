import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { GroupDto, NoteDto, NoteTagDto } from "@knotebook/shared";
import i18n from "@/i18n";
// The status line reads these strings; they are registered by the lazy tag chunks, which a test that hands in tokens directly never loads first.
import "@/i18n/tags-strings";
import { ActiveNoteProvider } from "@/lib/active-note";
import { adminRole, EDITOR_PERMS, groupDto, OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { SearchResults } from "./SearchResults";
import type { SearchTagToken } from "./search-tags";
import { tokenFromTag } from "./search-tags-logic";

const GROUP: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Product team" }, adminRole());
const GROUP_SPACE = { kind: "group", groupId: GROUP.id, groupName: GROUP.name } as const;
const PERSONAL = { kind: "personal" } as const;

const tag = (id: string, name: string, color: NoteTagDto["color"] = "blue"): NoteTagDto => ({ id, name, color });
const MEETINGS = tag("11111111-1111-4111-8111-111111111111", "Meetings", "yellow");
const DECISIONS = tag("22222222-2222-4222-8222-222222222222", "Decisions", "purple");
const SPECS = tag("33333333-3333-4333-8333-333333333333", "Specs", "blue");
const WORK = tag("44444444-4444-4444-8444-444444444444", "Work", "green");

function note(id: string, title: string, over: Partial<NoteDto> = {}): NoteDto {
  return {
    id, title, ownerId: "u1", role: "owner", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    slug: `slug-${id}`, slugIsCustom: false, prevSlug: null, ownerHandle: "alice", lastEdited: null, group: null, groupId: null,
    folderId: null, permissions: OWNER_PERMS, ...over,
  };
}
const groupNote = (id: string, title: string, tags: NoteTagDto[]) =>
  note(id, title, { ownerId: null, ownerHandle: null, role: "editor", groupId: GROUP.id, group: { id: GROUP.id, name: GROUP.name }, permissions: EDITOR_PERMS, tags });

const NOTES: NoteDto[] = [
  groupNote("n1", "Weekly sync", [MEETINGS, DECISIONS]),
  groupNote("n2", "Planning meeting", [MEETINGS]),
  groupNote("n3", "Pricing decision", [MEETINGS, DECISIONS, SPECS]),
  groupNote("n4", "Spec draft", [SPECS]),
  note("n5", "Work log", { tags: [WORK] }),
  note("n6", "Plain note"),
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const invalidTags = () => json({ error: { code: "invalid_tags", message: "The tags are not valid." } }, 400);

let searchUrls: string[] = [];
let notesCalls = 0;

function stubFetch(opts: { notes: () => NoteDto[]; search?: (url: string) => Response; notesDelayMs?: (call: number) => number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/search?")) {
        searchUrls.push(url);
        return Promise.resolve(opts.search?.(url) ?? json({ hits: [], nextCursor: null }));
      }
      if (url === "/api/notes") {
        notesCalls += 1;
        const delay = opts.notesDelayMs?.(notesCalls) ?? 0;
        if (delay > 0) return new Promise<Response>((resolve) => setTimeout(() => resolve(json(opts.notes())), delay));
        return Promise.resolve(json(opts.notes()));
      }
      if (url === "/api/groups") return Promise.resolve(json([GROUP]));
      if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
      if (url.startsWith("/api/groups/") && url.endsWith("/tags")) return Promise.resolve(json([]));
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

let latestTokens: readonly SearchTagToken[] = [];

function Harness({ query, initial }: { query: string; initial: SearchTagToken[] }) {
  const [tokens, setTokens] = useState(initial);
  latestTokens = tokens;
  return <SearchResults query={query} tagTokens={tokens} onTagTokensChange={setTokens} />;
}

function renderResults(query: string, initial: SearchTagToken[]) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <Harness query={query} initial={initial} />
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const BOTH = [tokenFromTag(MEETINGS, GROUP_SPACE), tokenFromTag(DECISIONS, GROUP_SPACE)];

describe("SearchResults with tag tokens", () => {
  beforeEach(async () => {
    searchUrls = [];
    notesCalls = 0;
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("tokens without a keyword list that space's notes with all tokens, with the status line, and send no request", async () => {
    stubFetch({ notes: () => NOTES });
    renderResults("", BOTH);
    await screen.findByRole("link", { name: /^Weekly sync/ });
    expect(screen.getByRole("link", { name: /^Pricing decision/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Planning meeting/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Work log/ })).toBeNull();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Product team · Meetings+Decisions · 2 notes"));
    expect(searchUrls).toEqual([]);
  });

  it("a one-letter keyword filters title matches by the tokens and still shows the too-short hint", async () => {
    stubFetch({ notes: () => NOTES });
    renderResults("w", [tokenFromTag(MEETINGS, GROUP_SPACE)]);
    await screen.findByRole("link", { name: /^Weekly sync/ });
    expect(screen.queryByRole("link", { name: /^Work log/ })).toBeNull();
    expect(screen.getByText("Type one more character to search note text too.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Product team · Meetings · 1 result"));
    expect(searchUrls).toEqual([]);
  });

  it("a two-letter keyword sends tags=<ids> with match=body, and only token-space notes can be listed", async () => {
    stubFetch({
      notes: () => NOTES,
      search: () => json({ hits: [{ note: NOTES[0], matchedOn: "body", matches: [{ sectionId: "_top", heading: "", snippet: "the sync notes" }] }, { note: NOTES[4], matchedOn: "body", matches: [{ sectionId: "_top", heading: "", snippet: "sync elsewhere" }] }], nextCursor: null }),
    });
    renderResults("sync", BOTH);
    await waitFor(() => expect(searchUrls).toHaveLength(1), { timeout: 3000 });
    const params = new URL(searchUrls[0]!, "http://x").searchParams;
    expect(params.get("tags")).toBe(`${MEETINGS.id},${DECISIONS.id}`);
    expect(params.get("match")).toBe("body");
    expect(params.get("q")).toBe("sync");
    const matches = await screen.findAllByTestId("body-match");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toHaveTextContent("the sync notes");
  });

  it("without tokens the request has no tags parameter", async () => {
    stubFetch({ notes: () => NOTES });
    renderResults("sync", []);
    await waitFor(() => expect(searchUrls).toHaveLength(1), { timeout: 3000 });
    expect(new URL(searchUrls[0]!, "http://x").searchParams.has("tags")).toBe(false);
  });

  it("Add: lists the same space's other tags, and clicking one adds a token", async () => {
    stubFetch({ notes: () => NOTES });
    renderResults("", [tokenFromTag(MEETINGS, GROUP_SPACE)]);
    await screen.findByRole("link", { name: /^Weekly sync/ });
    expect(await screen.findByText("Add:")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Work" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Meetings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Specs" }));
    expect(latestTokens.map((token) => token.name)).toEqual(["Meetings", "Specs"]);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Product team · Meetings+Specs · 1 note"));
  });

  it("result rows show the note's dots", async () => {
    stubFetch({ notes: () => NOTES });
    renderResults("", [tokenFromTag(MEETINGS, GROUP_SPACE)]);
    const row = await screen.findByRole("link", { name: /^Weekly sync/ });
    expect(within(row).getByRole("img", { name: "Tags: Meetings, Decisions" })).toBeInTheDocument();
  });

  it("the status line in zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    stubFetch({ notes: () => NOTES });
    renderResults("", BOTH);
    await screen.findByRole("link", { name: /^Weekly sync/ });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Product team · Meetings＋Decisions · 2 篇"));
  });

  it("a token whose tag has left every visible note is dropped, and a personal token never lists group notes", async () => {
    stubFetch({ notes: () => NOTES });
    const gone = tokenFromTag(tag("99999999-9999-4999-8999-999999999999", "Gone"), PERSONAL);
    renderResults("", [gone]);
    await waitFor(() => expect(latestTokens).toEqual([]));
  });

  it("invalid_tags refreshes the note list, drops the vanished token, searches again once and does not loop", async () => {
    let notes = NOTES;
    stubFetch({
      notes: () => notes,
      search: (url) => {
        const tags = new URL(url, "http://x").searchParams.get("tags") ?? "";
        if (!tags.includes(DECISIONS.id)) return json({ hits: [], nextCursor: null });
        // Someone else merged Decisions away: from now on the list no longer carries it.
        notes = NOTES.map((n) => ({ ...n, tags: (n.tags ?? []).filter((t) => t.id !== DECISIONS.id) }));
        return invalidTags();
      },
    });
    renderResults("sync", BOTH);
    await waitFor(() => expect(searchUrls).toHaveLength(1), { timeout: 3000 });
    await waitFor(() => expect(latestTokens.map((token) => token.name)).toEqual(["Meetings"]), { timeout: 3000 });
    await waitFor(() => expect(searchUrls).toHaveLength(2), { timeout: 3000 });
    expect(new URL(searchUrls[1]!, "http://x").searchParams.get("tags")).toBe(MEETINGS.id);
    expect(notesCalls).toBeGreaterThanOrEqual(2);
    // Recovered: no error text, and nothing keeps retrying afterwards.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(searchUrls).toHaveLength(2);
    expect(screen.queryByText("Couldn't search note text.")).toBeNull();
  });

  it("while the lists are refreshed after invalid_tags the failure is not shown; if the tags are still there afterwards it is", async () => {
    stubFetch({
      notes: () => NOTES,
      search: () => invalidTags(),
      notesDelayMs: (call) => (call >= 2 ? 700 : 0),
    });
    renderResults("sync", [tokenFromTag(MEETINGS, GROUP_SPACE)]);
    await waitFor(() => expect(notesCalls).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    // The refresh is in flight: neither the error nor the searching hint of a settled failure.
    expect(searchUrls).toHaveLength(1);
    expect(screen.queryByText("Couldn't search note text.")).toBeNull();
    expect(await screen.findByText("Couldn't search note text.", {}, { timeout: 3000 })).toBeInTheDocument();
  });
});
