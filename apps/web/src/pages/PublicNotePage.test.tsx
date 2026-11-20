import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import * as Y from "yjs";
import { EMPTY_YDOC_UPDATE_B64, YDOC_FRAGMENT } from "@knotebook/shared";
import i18n from "@/i18n";
import { stubLayoutTier } from "@/test/layout-tier";
import { OUTLINE_PINNED_STORAGE_KEY } from "@/components/outline/outline-pin";
import { ARTICLE_COLUMN_MAX, articleColumn } from "@/components/ui/article-column";
import { ThemeProvider } from "@/theme";
import { PublicNoteErrorBoundary } from "@/components/PublicNoteShell";
import PublicNotePage from "./PublicNotePage";

// Follows NotePage.test.tsx's minimal stand-in convention: BlockNote needs a whole set of DOM / Range APIs jsdom lacks, so this only
// verifies that the page hands the right doc/publicRef to the read-only editor - the contract of the options themselves (fragment name,
// resolveFileUrl mapping, ...) is guarded in collab/editor-options.test.ts.
// data-ref is serialized as kind:value - not just the kind (that would not catch "passed the wrong note's ref").
// The stand-in also hands the "editor" to onEditor like the real one: with a document that has a single H2, the heading outline has something to list.
const FAKE_EDITOR = vi.hoisted(() => ({
  document: [{ id: "h-intro", type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Intro" }] }],
  onChange: () => () => {},
}));
vi.mock("@/components/PublicNoteEditor", async () => {
  const { useEffect } = await import("react");
  return {
    PublicNoteEditor: ({
      doc,
      publicRef,
      links,
      onEditor,
    }: {
      doc: Y.Doc;
      publicRef: import("@/lib/public-note-ref").PublicNoteRef;
      links: unknown[];
      onEditor?: (editor: typeof FAKE_EDITOR | null) => void;
    }) => {
      useEffect(() => {
        onEditor?.(FAKE_EDITOR);
        return () => onEditor?.(null);
      }, [onEditor]);
      return (
        <div
          data-testid="public-note-editor"
          data-ref={publicRef.kind === "token" ? `token:${publicRef.token}` : `path:${publicRef.handle}/${publicRef.slug}`}
          data-fragment-length={String(doc.getXmlFragment(YDOC_FRAGMENT).length)}
          data-links={JSON.stringify(links)}
        />
      );
    },
  };
});
vi.mock("@/present/lazy", () => ({ LazyPresentation: () => <div data-testid="presentation-stub" /> }));
const outlineProps = vi.hoisted(() => [] as Array<import("@/components/outline/NoteOutline").NoteOutlineProps>);
vi.mock("@/components/outline/NoteOutline", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/outline/NoteOutline")>();
  return {
    ...original,
    NoteOutline: (props: import("@/components/outline/NoteOutline").NoteOutlineProps) => {
      outlineProps.push(props);
      return <div data-testid="outline-stub" />;
    },
  };
});
// The bubble stub is a button that calls onOpen when pressed.
const phoneStubs = vi.hoisted(() => ({
  bubble: [] as Array<import("@/components/outline/OutlineScrollBubble").OutlineScrollBubbleProps>,
  sheet: [] as Array<import("@/components/outline/OutlineSheet").OutlineSheetProps>,
}));
vi.mock("@/components/outline/OutlineScrollBubble", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/outline/OutlineScrollBubble")>();
  return {
    ...original,
    OutlineScrollBubble: (props: import("@/components/outline/OutlineScrollBubble").OutlineScrollBubbleProps) => {
      phoneStubs.bubble.push(props);
      return <button type="button" data-testid="bubble-stub" onClick={(e) => props.onOpen(e.currentTarget)} />;
    },
  };
});
vi.mock("@/components/outline/OutlineSheet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/outline/OutlineSheet")>()),
  OutlineSheet: (props: import("@/components/outline/OutlineSheet").OutlineSheetProps) => {
    phoneStubs.sheet.push(props);
    return <div data-testid="sheet-stub" data-open={String(props.open)} />;
  },
}));
// jsdom has no layout: the test sets the container width.
const outlineBox = vi.hoisted(() => ({ value: { width: 1072, height: 700, firstLineTop: null } }));
vi.mock("@/components/outline/use-outline-box", () => ({
  useOutlineBox: (scrollEl: HTMLElement | null, columnEl: HTMLElement | null) => (scrollEl !== null && columnEl !== null ? outlineBox.value : null),
}));

vi.mock("@/components/media-zoom/ImageZoomLayer", async () => {
  const { useMediaZoom } = await import("@/components/media-zoom/context");
  return {
    ImageZoomLayer: ({ container, editable }: { container: HTMLElement | null; editable: boolean }) => (
      <div
        data-testid="image-zoom-layer"
        data-has-zoom={String(useMediaZoom() !== null)}
        data-editable={String(editable)}
        data-in-column={String(container?.dataset.testid === "article-column")}
      />
    ),
  };
});

const TOKEN = "abcDEF123_-".repeat(4).slice(0, 43);

function ydocBase64(build: (fragment: Y.XmlFragment) => void): string {
  const doc = new Y.Doc();
  doc.transact(() => build(doc.getXmlFragment(YDOC_FRAGMENT)));
  const bytes = Y.encodeStateAsUpdate(doc);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

interface PublicNoteBody {
  title: string;
  ydoc: string;
  links?: Array<{ id: string; title: string; path: string }>;
  /** #297: deliberately widened to string so a test can send a value the server does not know. */
  width?: string;
}

/** Answers public endpoints only; anything else (especially /api/auth/me) throws, because an anonymous page must not call authenticated APIs. */
function mockFetch(handler: (url: string) => { status: number; body: unknown } | null) {
  const calls: string[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);
    const matched = method === "GET" ? handler(url) : null;
    if (!matched) throw new Error(`unexpected fetch: ${method} ${url}`);
    return Promise.resolve({
      ok: matched.status >= 200 && matched.status < 300,
      status: matched.status,
      json: () => Promise.resolve(matched.body),
    } as unknown as Response);
  });
  return { fn, calls };
}

function renderPage(entry = `/p/${TOKEN}`) {
  // Deliberately NOT disabling retry on the test side (a shape that would mask): the page's own `retry: false` must carry weight - once it
  // is removed, the 404/429 cases would retry three times and the error screen would appear only after the fourth failure.
  // The guard is counting: both the 404 and 429 cases assert that the public endpoint was hit exactly once after the error screen appears
  // (4 calls with retries). It does not rely on a waitFor timeout: react-query's default backoff of 1+2+4 = ~7 s fits within the global
  // asyncUtilTimeout (test/setup.ts). The route tree carries both forms (same structure as App.tsx): the form is decided in-page by useParams.
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/p/:token" element={<PublicNotePage />} />
            <Route path="/p/:handle/:slug" element={<PublicNotePage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PublicNotePage (#72 /p/:token + #122 /p/:handle/:slug no-login read-only page)", () => {
  it("200: title + read-only badge + Knotebook linking back to /, the doc is decoded and handed to the read-only editor (the token is passed along too)", async () => {
    const body: PublicNoteBody = {
      title: "公開的筆記",
      ydoc: ydocBase64((fragment) => {
        const paragraph = new Y.XmlElement("paragraph");
        paragraph.insert(0, [new Y.XmlText("hello")]);
        fragment.insert(0, [paragraph]);
      }),
    };
    const { fn, calls } = mockFetch((url) =>
      url === `/api/public/notes/${TOKEN}` ? { status: 200, body } : null,
    );
    vi.stubGlobal("fetch", fn);

    renderPage();

    const editor = await screen.findByTestId("public-note-editor");
    expect(editor.dataset.ref).toBe(`token:${TOKEN}`);
    expect(editor.dataset.fragmentLength).toBe("1");
    expect(screen.getByTestId("public-note-editor")).toHaveAttribute("data-links", "[]");
    expect(screen.getByRole("heading", { name: "公開的筆記" })).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Knotebook/ })).toHaveAttribute("href", "/");
    expect(calls).toEqual([`GET /api/public/notes/${TOKEN}`]);
  });

  it("phone header: the presentation button is icon-only (accessible name unchanged), the read-only badge collapses into a dot (text only for screen readers)", async () => {
    const body: PublicNoteBody = { title: "公開的筆記", ydoc: EMPTY_YDOC_UPDATE_B64 };
    vi.stubGlobal("fetch", mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? { status: 200, body } : null)).fn);
    renderPage();
    const present = await screen.findByRole("button", { name: "Present" });
    expect(present).toHaveClass("pointer-coarse:after:-inset-y-1.5");
    const label = within(present).getByText("Present");
    expect(label).toHaveClass("max-sm:sr-only");
    const readonly = screen.getByText("Read-only");
    expect(readonly).toHaveClass("max-sm:sr-only");
    const badge = readonly.parentElement!;
    expect(badge).toHaveClass("sm:border");
    expect(badge).not.toHaveClass("border");
    const dot = badge.querySelector("[data-readonly-dot]");
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(dot).toHaveClass("sm:hidden");
  });

  it("#462: the article column has the zoom feature and a read-only image floating layer (the layer is attached to the article column)", async () => {
    const body: PublicNoteBody = { title: "公開的筆記", ydoc: EMPTY_YDOC_UPDATE_B64 };
    vi.stubGlobal("fetch", mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? { status: 200, body } : null)).fn);
    renderPage();
    const layer = await screen.findByTestId("image-zoom-layer");
    expect(layer).toHaveAttribute("data-has-zoom", "true");
    expect(layer).toHaveAttribute("data-editable", "false");
    await waitFor(() => expect(layer).toHaveAttribute("data-in-column", "true"));
    expect(screen.getByTestId("article-column")).toContainElement(layer);
  });

  it("the public page has no favorites star and does not hit the favorites list (#334)", async () => {
    const body: PublicNoteBody = { title: "公開的筆記", ydoc: ydocBase64(() => {}) };
    const { fn, calls } = mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? { status: 200, body } : null));
    vi.stubGlobal("fetch", fn);

    renderPage();

    await screen.findByTestId("public-note-editor");
    expect(screen.queryByRole("button", { name: "Favorite" })).toBeNull();
    expect(calls.some((c) => c.includes("/api/favorites"))).toBe(false);
  });

  it("alias form /p/<handle>/<slug> (#122): hits the by-path endpoint, the path-form ref is handed to the editor, zero auth fetch", async () => {
    const body: PublicNoteBody = {
      title: "別名的筆記",
      ydoc: ydocBase64((fragment) => {
        const paragraph = new Y.XmlElement("paragraph");
        paragraph.insert(0, [new Y.XmlText("hi")]);
        fragment.insert(0, [paragraph]);
      }),
    };
    const { fn, calls } = mockFetch((url) =>
      url === "/api/public/notes/alice/my-doc" ? { status: 200, body } : null,
    );
    vi.stubGlobal("fetch", fn);

    const queryClient = renderPage("/p/alice/my-doc");

    const editor = await screen.findByTestId("public-note-editor");
    expect(editor.dataset.ref).toBe("path:alice/my-doc"); // a misjudged token form would show up here
    expect(screen.getByRole("heading", { name: "別名的筆記" })).toBeInTheDocument();
    expect(calls).toEqual(["GET /api/public/notes/alice/my-doc"]);
    // The cache really lands under the by-path key: if the queryKey were hardcoded to the token form, the URL and the screen would all be
    // right and only the cache slot wrong - every alias page would share one slot and switching pages would first render the previous
    // note. A fetch assertion cannot see this; the key must be checked directly.
    expect(queryClient.getQueryState(["public-note-by-path", "alice", "my-doc"])?.status).toBe("success");
  });

  it("alias form 404 (old link after rename / alias cleanup) -> the same invalid card; hit exactly once (retry:false carries weight in the alias form too)", async () => {
    const { fn, calls } = mockFetch((url) =>
      url === "/api/public/notes/alice/gone" ? { status: 404, body: { error: { code: "not_found" } } } : null,
    );
    vi.stubGlobal("fetch", fn);
    renderPage("/p/alice/gone");
    // Verbatim (same as the token 404 case): collapsing into the generic branch would render errors.fallback, not this text.
    expect(await screen.findByRole("alert")).toHaveTextContent("This link doesn't exist or is no longer active.");
    expect(screen.queryByTestId("public-note-editor")).not.toBeInTheDocument();
    expect(calls).toEqual(["GET /api/public/notes/alice/gone"]);
  });

  it("empty document payload (AAA=) -> renders an empty document normally, no throw, no error card", async () => {
    const { fn } = mockFetch((url) =>
      url === `/api/public/notes/${TOKEN}`
        ? { status: 200, body: { title: "空筆記", ydoc: EMPTY_YDOC_UPDATE_B64 } satisfies PublicNoteBody }
        : null,
    );
    vi.stubGlobal("fetch", fn);

    renderPage();

    const editor = await screen.findByTestId("public-note-editor");
    expect(editor.dataset.fragmentLength).toBe("0");
    expect(screen.queryByText("This link doesn't exist or is no longer active.")).not.toBeInTheDocument();
  });

  it("unreadable state (the server sends an empty ydoc string) -> the load-error card, not an empty note", async () => {
    const { fn } = mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? { status: 200, body: { title: "Broken", ydoc: "" } satisfies PublicNoteBody } : null));
    vi.stubGlobal("fetch", fn);
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[`/p/${TOKEN}`]}>
            <Routes>
              <Route path="/p/:token" element={<PublicNoteErrorBoundary reload={vi.fn()}><PublicNotePage /></PublicNoteErrorBoundary>} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText(i18n.t("public.loadError"))).toBeInTheDocument();
    expect(screen.queryByTestId("public-note-editor")).not.toBeInTheDocument();
  });

  it("404 (revoked / wrong token) -> invalid card, the editor is not mounted; hit exactly once (the page's retry: false carries weight - 404 is a common legitimate outcome, and a retry only eats throttle quota)", async () => {
    const { fn, calls } = mockFetch((url) =>
      url === `/api/public/notes/${TOKEN}`
        ? { status: 404, body: { error: { code: "not_found", message: "This link doesn't exist or no longer works." } } }
        : null,
    );
    vi.stubGlobal("fetch", fn);

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("This link doesn't exist or is no longer active.")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("public-note-editor")).not.toBeInTheDocument();
    expect(calls).toEqual([`GET /api/public/notes/${TOKEN}`]);
  });

  it("non-404 failure (429 throttle) -> shows the errors.<code> text, not the invalid card (the link may still be alive, so the user must not be wrongly told 'invalid')", async () => {
    const { fn, calls } = mockFetch((url) =>
      url === `/api/public/notes/${TOKEN}`
        ? { status: 429, body: { error: { code: "too_many_requests", message: "請求過於頻繁" } } }
        : null,
    );
    vi.stubGlobal("fetch", fn);

    renderPage();

    // Assert the errors.too_many_requests text verbatim (not errors.fallback): a regression collapsing the non-404 branch to always
    // fallback must fail here.
    await waitFor(() => expect(screen.getByText("Too many requests. Please slow down.")).toBeInTheDocument());
    // The page's `retry: false` guard (see the renderPage comment): retrying three times after a throttle only makes things worse.
    expect(calls).toEqual([`GET /api/public/notes/${TOKEN}`]);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("This link doesn't exist or is no longer active.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("public-note-editor")).not.toBeInTheDocument();
  });

  // Two presentation rules for a background refetch (react-query refetches on focus / reconnect by default): a non-404 failure must not
  // flip half-viewed content into an error card; a 404 must flip it into the invalid card (instant propagation of revocation).
  const CONTENT_BODY: PublicNoteBody = {
    title: "公開的筆記",
    ydoc: ydocBase64((fragment) => {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText("hello")]);
      fragment.insert(0, [paragraph]);
    }),
  };

  it("background refetch non-404 failure (500) -> existing content keeps rendering, no flip to the error card (a transient network failure that heals on the next success)", async () => {
    let respond: { status: number; body: unknown } = { status: 200, body: CONTENT_BODY };
    const { fn } = mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? respond : null));
    vi.stubGlobal("fetch", fn);

    const queryClient = renderPage();
    await screen.findByTestId("public-note-editor");

    respond = { status: 500, body: { error: { code: "internal", message: "boom" } } };
    await act(async () => {
      await queryClient.refetchQueries();
    });

    // First wait until the query really enters the error state, then assert the DOM - otherwise "content still there" might be a false
    // green from a flip that has not happened yet (the state update lags one beat in the 404 case).
    await waitFor(() => expect(queryClient.getQueryState(["public-note", TOKEN])?.status).toBe("error"));
    expect(screen.getByTestId("public-note-editor")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("background refetch hits 404 (link revoked) -> flips to the invalid card (the viewer must know the link died, not keep an old snapshot)", async () => {
    let respond: { status: number; body: unknown } = { status: 200, body: CONTENT_BODY };
    const { fn } = mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? respond : null));
    vi.stubGlobal("fetch", fn);

    const queryClient = renderPage();
    await screen.findByTestId("public-note-editor");

    respond = { status: 404, body: { error: { code: "not_found", message: "This link doesn't exist or no longer works." } } };
    await act(async () => {
      await queryClient.refetchQueries();
    });

    await waitFor(() =>
      expect(screen.getByText("This link doesn't exist or is no longer active.")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("public-note-editor")).not.toBeInTheDocument();
  });

  it("#269: the payload's links are handed to the read-only editor; an old server (no links) is treated as []", async () => {
    const links = [{ id: "11111111-1111-4111-8111-111111111111", title: "T", path: "/p/a/b" }];
    const { fn } = mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? { status: 200, body: { title: "N", ydoc: EMPTY_YDOC_UPDATE_B64, links } } : null));
    vi.stubGlobal("fetch", fn);
    renderPage();
    expect(await screen.findByTestId("public-note-editor")).toHaveAttribute("data-links", JSON.stringify(links));
  });

  describe("#297 public page width (the payload's width)", () => {
    const STANDARD_MAX = "max-w-[clamp(42.5rem,85%,66rem)]";
    async function columnFor(body: PublicNoteBody): Promise<HTMLElement> {
      const { fn } = mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? { status: 200, body } : null));
      vi.stubGlobal("fetch", fn);
      renderPage();
      await screen.findByTestId("public-note-editor");
      return screen.getByTestId("article-column");
    }

    it("width: full -> full width, no standard max-w", async () => {
      const column = await columnFor({ title: "N", ydoc: EMPTY_YDOC_UPDATE_B64, width: "full" });
      expect(column).toHaveClass("mx-auto", "w-full", "max-w-none");
      expect(column).not.toHaveClass(STANDARD_MAX);
    });

    it("missing width (old server) -> standard", async () => {
      const column = await columnFor({ title: "N", ydoc: EMPTY_YDOC_UPDATE_B64 });
      expect(column).toHaveClass("mx-auto", "w-full", STANDARD_MAX);
    });

    it("unrecognized width -> standard", async () => {
      const column = await columnFor({ title: "N", ydoc: EMPTY_YDOC_UPDATE_B64, width: "bogus" });
      expect(column).toHaveClass("mx-auto", "w-full", STANDARD_MAX);
    });
  });

  describe("#465 right-side heading outline", () => {
    beforeEach(() => {
      window.localStorage.clear();
    });
    afterEach(() => {
      window.localStorage.clear();
    });

    async function renderWithHeadings(entry?: string, width?: string) {
      outlineProps.length = 0;
      const body: PublicNoteBody = { title: "N", ydoc: EMPTY_YDOC_UPDATE_B64, ...(width !== undefined ? { width } : {}) };
      const { fn } = mockFetch((url) => (url === `/api/public/notes/${TOKEN}` ? { status: 200, body } : null));
      vi.stubGlobal("fetch", fn);
      renderPage(entry);
      await screen.findByTestId("public-note-editor");
    }

    it("desktop: mounted after the header and before the scroll container (not inside it); receives the scroll container and headings, no bubble; with no preference it can be pinned but is not", async () => {
      stubLayoutTier("docked");
      await renderWithHeadings();
      const stub = await screen.findByTestId("outline-stub");
      const header = screen.getByRole("banner");
      const column = screen.getByTestId("article-column");
      const scroll = column.parentElement!;
      expect(scroll).toHaveClass("overflow-y-auto");
      expect(header.compareDocumentPosition(stub) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(stub.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(scroll.contains(stub)).toBe(false);
      const props = outlineProps[outlineProps.length - 1]!;
      expect(props.scrollEl).toBe(scroll);
      expect(props.headings).toEqual([{ id: "h-intro", level: 2, text: "Intro" }]);
      expect(props.bubbleShown).toBe(false);
      expect(props.pinned).toBe(false);
      expect(props.pinAvailable).toBe(true);
      await waitFor(() => expect(column).toHaveClass(...articleColumn("standard", { pinMotion: true }).split(" ")));
    });

    it("standard width + pinned preference -> the column appears at the pinned width right away with no transition that time; a transition only after one frame; the outline receives pinned", async () => {
      window.localStorage.setItem(OUTLINE_PINNED_STORAGE_KEY, "1");
      stubLayoutTier("docked");
      const records: MutationRecord[] = [];
      const observer = new MutationObserver((list) => records.push(...list));
      observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
      await renderWithHeadings(undefined, "standard");
      await screen.findByTestId("outline-stub");
      const column = screen.getByTestId("article-column");
      await waitFor(() => expect(column).toHaveClass(...articleColumn("standard-pinned", { pinMotion: true }).split(" ")));
      records.push(...observer.takeRecords());
      observer.disconnect();
      const values = [...records.filter((r) => r.target === column).map((r) => r.oldValue ?? ""), column.className];
      const pinnedMax = ARTICLE_COLUMN_MAX["standard-pinned"].split(" ")[0]!;
      const firstPinned = values.find((c) => c.split(" ").includes(pinnedMax));
      expect(firstPinned, values.join("\n")).toBeDefined();
      expect(firstPinned!.split(" ")).not.toContain("transition-[max-width,left]");
      const props = outlineProps[outlineProps.length - 1]!;
      expect(props.pinned).toBe(true);
      expect(props.pinAvailable).toBe(true);
    });

    it("the scroll container always reserves the scrollbar position (whether a scrollbar appears does not change the width, so whether it can be pinned does not flip back and forth near the threshold)", async () => {
      stubLayoutTier("docked");
      await renderWithHeadings();
      expect(screen.getByTestId("article-column").parentElement).toHaveClass("sm:[scrollbar-gutter:stable]");
    });

    it("full width + pinned preference -> the column is full width and cannot be pinned (only a thin line)", async () => {
      window.localStorage.setItem(OUTLINE_PINNED_STORAGE_KEY, "1");
      stubLayoutTier("docked");
      await renderWithHeadings(undefined, "full");
      await screen.findByTestId("outline-stub");
      const column = screen.getByTestId("article-column");
      expect(column).toHaveClass(...articleColumn("full").split(" "));
      expect(column).not.toHaveClass("left-0");
      for (const c of ARTICLE_COLUMN_MAX["standard-pinned"].split(" ")) expect(column).not.toHaveClass(c);
      const props = outlineProps[outlineProps.length - 1]!;
      expect(props.pinned).toBe(false);
      expect(props.pinAvailable).toBe(false);
      expect(window.localStorage.getItem(OUTLINE_PINNED_STORAGE_KEY)).toBe("1");
    });

    it("640-767: also phone-shaped (bubble, bottom panel), no thin line; from 768 up it is a thin line", async () => {
      stubLayoutTier("compact");
      phoneStubs.bubble = [];
      await renderWithHeadings();
      await screen.findByTestId("bubble-stub");
      expect(outlineProps).toHaveLength(0);
      expect(phoneStubs.bubble[phoneStubs.bubble.length - 1]!.scrollTarget).toBe(screen.getByTestId("article-column").parentElement!);
    });

    it("phone: no thin line; the position bubble is inside a zero-height anchor outside the scroll container and listens to the scroll container's scrolling, has a bottom panel; the page has no kebab", async () => {
      stubLayoutTier("phone");
      phoneStubs.bubble = [];
      phoneStubs.sheet = [];
      await renderWithHeadings();
      const bubble = await screen.findByTestId("bubble-stub");
      expect(screen.queryByTestId("outline-stub")).not.toBeInTheDocument();
      expect(outlineProps).toHaveLength(0);
      const scroll = screen.getByTestId("article-column").parentElement!;
      const props = phoneStubs.bubble[phoneStubs.bubble.length - 1]!;
      expect(props.placement).toBe("anchor");
      expect(props.scrollTarget).toBe(scroll);
      expect(props.headings).toEqual([{ id: "h-intro", level: 2, text: "Intro" }]);
      expect(scroll.contains(bubble)).toBe(false);
      expect(bubble.closest("[data-outline-anchor]")).not.toBeNull();
      expect(screen.getByTestId("sheet-stub")).toHaveAttribute("data-open", "false");
      expect(props.inputRoot ?? null).toBeNull();
      expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
      act(() => bubble.click());
      expect(screen.getByTestId("sheet-stub")).toHaveAttribute("data-open", "true");
      // When the panel closes, focus returns to the bubble that opened it (there is no trigger button, otherwise it would fall to body).
      const restore = phoneStubs.sheet[phoneStubs.sheet.length - 1]!.restoreFocus;
      expect(restore).toEqual(expect.any(Function));
      act(() => restore!());
      expect(document.activeElement).toBe(bubble);
    });

    it("desktop: no bubble and no bottom panel", async () => {
      stubLayoutTier("docked");
      phoneStubs.bubble = [];
      phoneStubs.sheet = [];
      await renderWithHeadings();
      await screen.findByTestId("outline-stub");
      expect(screen.queryByTestId("bubble-stub")).not.toBeInTheDocument();
      expect(phoneStubs.sheet).toHaveLength(0);
    });

    it("during presentation (?present): not mounted even on desktop", async () => {
      stubLayoutTier("docked");
      await renderWithHeadings(`/p/${TOKEN}?present`);
      expect(await screen.findByTestId("presentation-stub")).toBeInTheDocument();
      await act(async () => {});
      expect(screen.queryByTestId("outline-stub")).not.toBeInTheDocument();
      expect(outlineProps).toHaveLength(0);
    });
  });
});
