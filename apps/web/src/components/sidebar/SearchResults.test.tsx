import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { canonicalNotePath, type GroupDto, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider, useActiveNote } from "@/lib/active-note";
import { adminRole, EDITOR_PERMS, groupDto, OWNER_PERMS } from "@/test/fixtures";
import { SearchResults, highlightTitle } from "./SearchResults";
import { FOLDER_LIST_EMPTY, folderDto } from "@/test/folder-fixtures";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

function fakeResponse(ok: boolean, status: number, body?: unknown): Response {
  return {
    ok,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as unknown as Response;
}

function note(id: string, title: string, over: Partial<NoteDto> = {}): NoteDto {
  return {
    id,
    title,
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: `slug-${id}`,
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "owner-one",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
    ...over,
  };
}

const GROUP_A: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" }, adminRole());

const ALPHA_PLAN = note("n1", "Alpha Plan");
const ALPHA_GROUP = note("n2", "Alpha Group", {
  ownerId: null,
  ownerHandle: null,
  role: "editor",
  groupId: GROUP_A.id,
  group: { id: GROUP_A.id, name: GROUP_A.name },
  permissions: EDITOR_PERMS,
});
const ALPHA_SHARED = note("n3", "alpha shared", {
  ownerId: "u9",
  role: "editor",
  ownerHandle: "owner-nine",
  permissions: EDITOR_PERMS,
});
const BETA = note("n4", "Beta");
const FIXTURE = [ALPHA_PLAN, ALPHA_GROUP, ALPHA_SHARED, BETA];

function stubFetch(notes: NoteDto[] | "pending" | "error", groups: GroupDto[] = [GROUP_A]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        if (notes === "pending") return new Promise(() => {});
        if (notes === "error") return Promise.resolve(fakeResponse(false, 500, { error: "internal" }));
        return Promise.resolve(fakeResponse(true, 200, notes));
      }
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse(true, 200, groups));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function SetActive({ id }: { id: string }) {
  const { setActiveNoteId } = useActiveNote();
  useEffect(() => {
    setActiveNoteId(id);
  }, [id, setActiveNoteId]);
  return null;
}

function renderResults(query: string, activeId?: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ActiveNoteProvider>
          {activeId !== undefined && <SetActive id={activeId} />}
          <SearchResults query={query} />
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 以 `^標題` 取結果列連結（可及名稱是「標題 位置」）。 */
function rowLink(title: string): HTMLElement {
  return screen.getByRole("link", { name: new RegExp("^" + escapeRe(title)) });
}

describe("SearchResults", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("SR1：扁平結果、server 順序、位置行與結果數", async () => {
    stubFetch(FIXTURE);
    renderResults("alpha");
    await screen.findByRole("link", { name: /^Alpha Plan/ });
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items.map((li) => li.querySelector("div:nth-child(1)")?.textContent)).toEqual([
      "Alpha Plan",
      "Alpha Group",
      "alpha shared",
    ]);
    expect(items.map((li) => li.querySelector("div:nth-child(2)")?.textContent)).toEqual([
      "My notes",
      "Groups › Workshop A",
      "Shared with me · Editor",
    ]);
    expect(screen.getByRole("status")).toHaveTextContent("3 results");
  });

  it("SR1：只剩一筆時是 1 result", async () => {
    stubFetch(FIXTURE);
    renderResults("beta");
    await screen.findByRole("link", { name: /^Beta/ });
    expect(screen.getByRole("status").textContent).toMatch(/\b1 result$/);
  });

  it("SR1：zh-TW 的結果數", async () => {
    await i18n.changeLanguage("zh-TW");
    stubFetch(FIXTURE);
    renderResults("alpha");
    await screen.findByRole("link", { name: /^Alpha Plan/ });
    expect(screen.getByRole("status")).toHaveTextContent("搜尋結果 · 3 篇");
  });

  it("SR2：高亮只標第一個命中、保留原大小寫、標題文字完整", async () => {
    stubFetch([note("s1", "Has A Slug")]);
    renderResults("a sl");
    const link = await screen.findByRole("link", { name: /^Has A Slug/ });
    const marks = link.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent("A Sl");
    expect(marks[0]).toHaveClass("bg-search-highlight");
    expect(link.querySelector("div")?.textContent).toBe("Has A Slug");
  });

  it("SR3：toLowerCase 後長度改變的標題照樣列出、不標 mark、標題完整", async () => {
    stubFetch([note("s1", "İstanbul notes")]);
    renderResults("notes");
    const link = await screen.findByRole("link", { name: /^İstanbul notes/ });
    expect(link.querySelector("mark")).toBeNull();
    expect(link.querySelector("div")?.textContent).toBe("İstanbul notes");
  });

  it("SR4：查詢字串一律字面比對（括號不丟錯、點不當萬用字元）", async () => {
    stubFetch([note("s1", "x (y)"), note("s2", "axb")]);
    const first = renderResults("(");
    await screen.findByRole("link", { name: /^x \(y\)/ });
    expect(screen.queryByRole("link", { name: /^axb/ })).not.toBeInTheDocument();
    first.unmount();

    renderResults("a.b");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("0 results"));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("No notes match your search.")).toBeInTheDocument();
  });

  it("SR5：無命中——0 results、提示可見、沒有 listitem", async () => {
    stubFetch(FIXTURE);
    renderResults("zzz");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("0 results"));
    expect(screen.getByText("No notes match your search.")).toBeVisible();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("SR6：不放 ⋮、href 為 canonicalNotePath、可及名稱含位置、aria-current 與樂觀 active", async () => {
    stubFetch(FIXTURE);
    renderResults("alpha", ALPHA_PLAN.id);
    await screen.findByRole("link", { name: /^Alpha Plan/ });
    expect(screen.queryAllByRole("button", { name: /^Note actions for/ })).toHaveLength(0);
    expect(rowLink("Alpha Plan")).toHaveAttribute("href", canonicalNotePath(ALPHA_PLAN));
    expect(rowLink("Alpha Group")).toHaveAttribute("href", canonicalNotePath(ALPHA_GROUP));
    expect(screen.getByRole("link", { name: "Alpha Group Groups › Workshop A" })).toBeInTheDocument();

    await waitFor(() => expect(rowLink("Alpha Plan")).toHaveAttribute("aria-current", "page"));
    expect(rowLink("Alpha Group")).not.toHaveAttribute("aria-current");
    expect(rowLink("alpha shared")).not.toHaveAttribute("aria-current");

    fireEvent.click(rowLink("alpha shared"));
    await waitFor(() => expect(rowLink("alpha shared")).toHaveAttribute("aria-current", "page"));
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("SR7：notes pending → Loading…；500 → role=alert", async () => {
    stubFetch("pending");
    const first = renderResults("a");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-search")).toHaveClass("flex-1");
    first.unmount();
    vi.unstubAllGlobals();

    stubFetch("error");
    renderResults("a");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-search")).toHaveClass("flex-1");
  });

  it("SR8：長標題——標題與位置元素 truncate、連結 min-w-0", async () => {
    stubFetch([note("s1", "L".repeat(120))]);
    renderResults("l");
    const link = await screen.findByRole("link");
    expect(link).toHaveClass("min-w-0");
    const lines = link.querySelectorAll("div");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toHaveClass("truncate");
    expect(within(link).getByText("My notes")).toHaveClass("truncate");
  });
});

describe("SearchResults × 資料夾路徑", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("SR-F1 搜到 p2 → 第二行「My notes › A › A1」，title 同字", async () => {
    const p2 = note("p2", "Deep note", { folderId: "A1" });
    const folders = [folderDto({ id: "A", name: "A" }), folderDto({ id: "A1", name: "A1", parentId: "A" })];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify({ folders }), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes") return Promise.resolve(fakeResponse(true, 200, [p2]));
        if (url === "/api/groups") return Promise.resolve(fakeResponse(true, 200, []));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderResults("deep");
    await waitFor(() => expect(screen.getByTitle("My notes › A › A1")).toHaveTextContent("My notes › A › A1"));
  });
});

describe("highlightTitle", () => {
  it("找不到、或小寫化改變長度 → 回原字串", () => {
    expect(highlightTitle("Beta", "zz")).toBe("Beta");
    expect(highlightTitle("İstanbul", "stan")).toBe("İstanbul");
  });

  it("兩處命中只標第一個、保留原大小寫", () => {
    const { container } = render(<>{highlightTitle("Alpha alpha", "alpha")}</>);
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent("Alpha");
    expect(marks[0].previousSibling).toBeNull();
    expect(container.textContent).toBe("Alpha alpha");
    expect(marks[0].nextSibling?.textContent).toBe(" alpha");
  });
});
