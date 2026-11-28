import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { createRef, forwardRef, useImperativeHandle, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { extractLinkTargets, YDOC_FRAGMENT } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { noteSchema } from "@/collab/schema";
import { insertWikilink } from "@/components/wikilink/spec";
import type { CollabState } from "./connection";
import { createLinkSync } from "./link-sync";

// `createLinkSync` on a 400 calls `toast()` and looks up i18n text (see `handleFailure` in link-sync.ts): replaced by a minimal stand-in so this file's unit tests don't depend on the real Radix toast store / i18next init timing (same toast mock technique as `NoteEditor.test.ts`).
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));
// `addResourceBundle`: the schema registers its lazy string pack on import.
const i18nMock = vi.hoisted(() => ({ t: vi.fn((key: string) => key), addResourceBundle: vi.fn() }));
vi.mock("@/i18n", () => ({ default: i18nMock }));

const NOTE_ID = "11111111-1111-1111-1111-111111111111";
const TARGET_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TARGET_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const LINKS_PATH = `/api/notes/${NOTE_ID}/links`;
/** Matches `DEBOUNCE_MS` in link-sync.ts (not exported; the same value here avoids a repeated magic number being mistyped). */
const DEBOUNCE_MS_FOR_TEST = 2_000;

function wikilinkElement(targetNoteId: string): Y.XmlElement {
  const el = new Y.XmlElement("wikilink");
  el.setAttribute("targetNoteId", targetNoteId);
  el.setAttribute("snapshotTitle", "t");
  return el;
}

/** Operates directly on the Y.Doc XmlFragment (not through the editor): replaces the fragment content with one paragraph holding the given wikilink nodes, simulating "after the user edited, the wikilink set becomes this". Wrapped in one `doc.transact` so only one `update` event fires, like one real edit. */
function setWikilinks(doc: Y.Doc, targetNoteIds: string[]): void {
  doc.transact(() => {
    const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
    fragment.delete(0, fragment.length);
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, targetNoteIds.map(wikilinkElement));
    fragment.insert(0, [paragraph]);
  });
}

function connected(role: "owner" | "editor" | "viewer" | "none"): CollabState {
  return { phase: "connected", role };
}

describe("extractLinkTargets", () => {
  it("recursively finds targetNoteId of nested wikilink nodes: deduplicated, sorted, non-uuid values filtered out", () => {
    const doc = new Y.Doc();
    setWikilinks(doc, [TARGET_B, TARGET_A, TARGET_B, "not-a-uuid"]);

    expect(extractLinkTargets(doc)).toEqual([TARGET_A, TARGET_B]);

    doc.destroy();
  });

  it("empty fragment, or no wikilink nodes at all -> empty array", () => {
    const doc = new Y.Doc();
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [new Y.XmlElement("paragraph")]);

    expect(extractLinkTargets(doc)).toEqual([]);

    doc.destroy();
  });
});

describe("createLinkSync", () => {
  let doc: Y.Doc;
  let api: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = new Y.Doc();
    toastMock.mockClear();
    i18nMock.t.mockClear();
  });

  afterEach(() => {
    doc.destroy();
    vi.useRealTimers();
  });

  function linksBody(targetNoteIds: string[]): RequestInit {
    return expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ link_target_ids: targetNoteIds }),
    }) as unknown as RequestInit;
  }

  it("commits once right after synced, without waiting for the debounce", async () => {
    api = vi.fn().mockResolvedValue(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);

    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith(LINKS_PATH, linksBody([TARGET_A]));
  });

  it("start() itself doesn't commit: doc changes before synced don't send either", async () => {
    api = vi.fn().mockResolvedValue(undefined);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    setWikilinks(doc, [TARGET_A]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS_FOR_TEST);

    expect(api).not.toHaveBeenCalled();
  });

  it("no send when unchanged: after the debounce the recomputed set equals the last successful commit, so no API call", async () => {
    api = vi.fn().mockResolvedValue(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();
    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    setWikilinks(doc, [TARGET_A]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS_FOR_TEST);

    expect(api).toHaveBeenCalledTimes(1);
  });

  it("set really changed: after the debounce the new full set is sent again", async () => {
    api = vi.fn().mockResolvedValue(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();
    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    setWikilinks(doc, [TARGET_A, TARGET_B]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS_FOR_TEST);

    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith(LINKS_PATH, linksBody([TARGET_A, TARGET_B]));
  });

  it("the debounce restarts from the latest change, not 2s per change", async () => {
    api = vi.fn().mockResolvedValue(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();
    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    setWikilinks(doc, [TARGET_A, TARGET_B]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS_FOR_TEST - 1);
    setWikilinks(doc, [TARGET_A, TARGET_B]); // same set, but it reset the debounce timer
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS_FOR_TEST - 1);
    expect(api).toHaveBeenCalledTimes(1); // not yet 2s of quiet, shouldn't send

    await vi.advanceTimersByTimeAsync(1);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("a remote update (Y.applyUpdate with a non-local origin) also triggers the debounced recompute and commit (remote included)", async () => {
    // The `doc.on("update", ...)` handler (`onDocUpdate`) deliberately doesn't check the event's origin: a genuinely remote update is built by editing another Y.Doc and Y.applyUpdate-ing it back with an origin clearly different from the local transact's (not by calling `doc.transact` on the same doc with the default origin), so this goes red if `onDocUpdate` is ever changed to accept only the local origin.
    api = vi.fn().mockResolvedValue(undefined);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();
    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1); // initial empty set
    expect(api).toHaveBeenLastCalledWith(LINKS_PATH, linksBody([]));

    const remote = new Y.Doc();
    setWikilinks(remote, [TARGET_A]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), "remote-peer");

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS_FOR_TEST);

    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith(LINKS_PATH, linksBody([TARGET_A]));

    remote.destroy();
  });

  it("a reconnect always resends: every onSynced resets the cache, so even unchanged content is sent once more", async () => {
    api = vi.fn().mockResolvedValue(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith(LINKS_PATH, linksBody([TARGET_A]));
  });

  it("after stop() no more commits (listener removed, schedule cleared)", async () => {
    api = vi.fn().mockResolvedValue(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();
    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    linkSync.stop();
    setWikilinks(doc, [TARGET_A, TARGET_B]);
    await vi.advanceTimersByTimeAsync(60_000);
    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);

    expect(api).toHaveBeenCalledTimes(1);
  });

  it("409 not_loaded: retries once after 1s, gives up if it still fails, no more automatic retries", async () => {
    api = vi
      .fn()
      .mockRejectedValueOnce(new ApiFail(409, "not_loaded", "x"))
      .mockRejectedValueOnce(new ApiFail(409, "not_loaded", "x"));
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(api).toHaveBeenCalledTimes(1); // not yet 1s

    await vi.advanceTimersByTimeAsync(1);
    expect(api).toHaveBeenCalledTimes(2); // the single retry

    await vi.advanceTimersByTimeAsync(60_000);
    expect(api).toHaveBeenCalledTimes(2); // gave up, no third call
    expect(toastMock).not.toHaveBeenCalled(); // not_loaded is silent throughout (no UI path)
  });

  it("409 not_loaded succeeds on retry: state returns to normal, and nothing is sent again when unchanged", async () => {
    api = vi.fn().mockRejectedValueOnce(new ApiFail(409, "not_loaded", "x")).mockResolvedValueOnce(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api).toHaveBeenCalledTimes(2);

    setWikilinks(doc, [TARGET_A]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS_FOR_TEST);
    expect(api).toHaveBeenCalledTimes(2); // unchanged: not sent
  });

  it("409 server_busy (not not_loaded): treated like 5xx with exponential backoff, not the 1s quick retry", async () => {
    api = vi.fn().mockRejectedValueOnce(new ApiFail(409, "server_busy", "x")).mockResolvedValueOnce(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(api).toHaveBeenCalledTimes(1);
    // The backoff starts at 1s, the same value as not_loaded's 1s; only the doubling in the next test tells them apart. This just confirms no retry before 1s.

    await vi.advanceTimersByTimeAsync(1);
    expect(api).toHaveBeenCalledTimes(2);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("409 server_busy failing twice in a row: the second retry lands at +2000ms (exponential doubling), not not_loaded's give-up after one retry", async () => {
    // Separates the server_busy and not_loaded paths: not_loaded gives up after its first retry fails (see the not_loaded test above); if an implementation routed every 409 through not_loaded's quick retry + single give-up (e.g. by missing `err.code !== "not_loaded"`), api would stop at 2 calls after the second failure, and the assertions below (still 2 at +1999ms, 3 at +2000ms) would go red.
    api = vi
      .fn()
      .mockRejectedValueOnce(new ApiFail(409, "server_busy", "x"))
      .mockRejectedValueOnce(new ApiFail(409, "server_busy", "x"))
      .mockResolvedValueOnce(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000); // first backoff: retry after 1s, the second attempt also fails
    expect(api).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(api).toHaveBeenCalledTimes(2); // the doubled delay is 2s, not reached yet (with not_loaded's give-up logic it would stay at 2 forever, however long the wait)

    await vi.advanceTimersByTimeAsync(1);
    expect(api).toHaveBeenCalledTimes(3); // the third retry lands at +2000ms, proving exponential doubling
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("5xx backoff capped at 60s: delays double on consecutive failures and lock at 60s once past the cap", async () => {
    api = vi.fn().mockRejectedValue(new ApiFail(500, "internal", "x"));
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    let calls = 1;
    for (const delay of delays) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(api).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      calls += 1;
      expect(api).toHaveBeenCalledTimes(calls);
    }
  });

  it("network-layer error (not ApiFail; `api()` throws a native Error on network failure): treated like 5xx with backoff", async () => {
    api = vi.fn().mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("403: latches and stops sending until onCollabState sees connected+canEdit, then unlatches and resends immediately", async () => {
    api = vi.fn().mockRejectedValueOnce(new ApiFail(403, "forbidden", "x")).mockResolvedValueOnce(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    setWikilinks(doc, [TARGET_A, TARGET_B]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api).toHaveBeenCalledTimes(1);

    linkSync.onCollabState(connected("viewer"));
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    linkSync.onCollabState(connected("editor"));
    await vi.advanceTimersByTimeAsync(0);

    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith(LINKS_PATH, linksBody([TARGET_A, TARGET_B]));
  });

  it("after a 403 unlatch, calling onCollabState again doesn't trigger again (the latch is no longer 403)", async () => {
    api = vi.fn().mockRejectedValueOnce(new ApiFail(403, "forbidden", "x")).mockResolvedValueOnce(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();
    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);

    linkSync.onCollabState(connected("owner"));
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(2);

    linkSync.onCollabState(connected("owner"));
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(2); // unchanged so not sent, not "unlatched again"
  });

  it("400: latches and toasts; stays latched while the set stays as it was when the 400 happened", async () => {
    api = vi.fn().mockRejectedValueOnce(new ApiFail(400, "invalid_body", "x"));
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({ title: "errors.invalid_body", variant: "destructive" });

    setWikilinks(doc, [TARGET_A]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("400 unlatch: when the recomputed result differs from the set that triggered the 400, unlatches and sends the new set", async () => {
    api = vi.fn().mockRejectedValueOnce(new ApiFail(400, "invalid_body", "x")).mockResolvedValueOnce(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    setWikilinks(doc, [TARGET_A, TARGET_B]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS_FOR_TEST);

    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith(LINKS_PATH, linksBody([TARGET_A, TARGET_B]));
  });

  it("onCollabState is a no-op when not latched (doesn't send by accident)", async () => {
    api = vi.fn().mockResolvedValue(undefined);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onCollabState(connected("editor"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(api).not.toHaveBeenCalled();
  });
});

// The server doesn't depend on BlockNote, so it can't test the "editor half" (the server only tests docClock); this is the place that verifies "set extracted by walking the Y.Doc == set extracted by walking editor.document": a mount harness (`BlockNoteEditor.create` + `editor.mount`; headless y-prosemirror doesn't write content back to the Y.Doc) builds a real editor bound to the same Y.Doc, inserts real wikilink nodes with `insertWikilink` (the wikilink spec), and compares the targetNoteId sets extracted by the two paths.
type ElementRendererHandle = (node: ReactNode, container: HTMLElement) => void;

const TestElementRenderer = forwardRef<ElementRendererHandle>((_props, ref) => {
  const [singleRenderData, setSingleRenderData] = useState<{ node: ReactNode; container: HTMLElement } | undefined>();

  useImperativeHandle(
    ref,
    () => (node: ReactNode, container: HTMLElement) => {
      flushSync(() => setSingleRenderData({ node, container }));
      setSingleRenderData(undefined);
    },
    [],
  );

  return singleRenderData ? createPortal(singleRenderData.node, singleRenderData.container) : null;
});
TestElementRenderer.displayName = "TestElementRenderer";

function mountedEditorOnDoc(doc: Y.Doc) {
  // `withCollaboration` (as in `buildNoteEditorOptions` of `NoteEditor.tsx`) doesn't just pass the `collaboration` field through to `BlockNoteEditor.create`: it puts a real `CollaborationExtension(options.collaboration)` into the returned object's `extensions` array (`collaboration` isn't a native `@blocknote/core` option; all the binding logic lives in that extension). Passing `collaboration: {...}` straight to `.create()` wouldn't wire y-prosemirror to this Y.Doc, writes wouldn't land in the fragment, and this test would fail silently (`extractLinkTargets(doc)` always empty).
  const options = withCollaboration({
    schema: noteSchema,
    collaboration: {
      fragment: doc.getXmlFragment(YDOC_FRAGMENT),
      user: { name: "tester", color: "#000" },
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple, any by repo convention (same as menu.test.tsx)
  const editor = BlockNoteEditor.create(options) as BlockNoteEditor<any, any, any>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["notes"], []);

  const rendererRef = createRef<ElementRendererHandle>();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TestElementRenderer ref={rendererRef} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  editor.elementRenderer = rendererRef.current!;

  return { editor, container };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
function extractViaEditorDocument(editor: BlockNoteEditor<any, any, any>): string[] {
  const found: string[] = [];

  interface BlockLike {
    content?: unknown;
    children?: BlockLike[];
  }

  const walk = (blocks: BlockLike[]): void => {
    for (const block of blocks) {
      if (Array.isArray(block.content)) {
        for (const item of block.content as unknown[]) {
          if (
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            (item as { type: unknown }).type === "wikilink"
          ) {
            const props = (item as unknown as { props: { targetNoteId: string } }).props;
            found.push(props.targetNoteId);
          }
        }
      }
      if (Array.isArray(block.children) && block.children.length > 0) walk(block.children);
    }
  };

  walk(editor.document as BlockLike[]);
  return [...new Set(found)].sort();
}

describe("traversal equivalence: set extracted by walking the Y.Doc == set extracted by walking editor.document", () => {
  let doc: Y.Doc;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    doc = new Y.Doc();
    ({ editor, container } = mountedEditorOnDoc(doc));
  });

  afterEach(() => {
    editor.unmount();
    container.remove();
    doc.destroy();
    vi.unstubAllGlobals();
  });

  it("single wikilink: both paths extract the same target", () => {
    insertWikilink(editor, { targetNoteId: TARGET_A, snapshotTitle: "A" });

    expect(extractLinkTargets(doc)).toEqual(extractViaEditorDocument(editor));
    expect(extractLinkTargets(doc)).toEqual([TARGET_A]);
  });

  it("several wikilinks spread over different blocks: both paths extract the same set", () => {
    insertWikilink(editor, { targetNoteId: TARGET_A, snapshotTitle: "A" });

    const firstBlockId = editor.document[0]!.id;
    const [newBlock] = editor.insertBlocks([{ type: "paragraph" }], firstBlockId, "after");
    editor.setTextCursorPosition(newBlock!.id, "start");
    insertWikilink(editor, { targetNoteId: TARGET_B, snapshotTitle: "B" });

    const viaDoc = extractLinkTargets(doc);
    const viaEditor = extractViaEditorDocument(editor);

    expect(viaDoc).toEqual(viaEditor);
    expect(viaDoc).toEqual([TARGET_A, TARGET_B].sort());
  });

  it("no wikilinks: both paths give an empty set", () => {
    editor.insertInlineContent(["plain text, no links here"]);

    expect(extractLinkTargets(doc)).toEqual([]);
    expect(extractViaEditorDocument(editor)).toEqual([]);
  });
});
