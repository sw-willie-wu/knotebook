// This one import is enough: it @imports the mantine theme and `@blocknote/react` styles. `@blocknote/core/fonts/inter.css` is deliberately not imported (Latin-only woff that only grows the bundle for a CJK UI); fonts come from the app CSS.
import "@blocknote/mantine/style.css";
import { lazy, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { createCursorScroller, type CursorScroller } from "@/collab/cursor-scroll";
import { gateLocalCursor } from "@/collab/cursor-gate";
import { clearNodeSelectionAt, type BlankClickView } from "@/collab/blank-click";
import { collabUserColor } from "@knotebook/shared";
import { BlockNoteEditor, filterSuggestionItems, SuggestionMenu } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { withCollaboration } from "@blocknote/core/yjs";
import {
  FilePanelController,
  GridSuggestionMenuController,
  SideMenuController,
  SuggestionMenuController,
  TableHandlesController,
  useCreateBlockNote,
  type DefaultReactSuggestionItem,
  type FloatingUIOptions,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import type { NoteDto } from "@knotebook/shared";
import { useCreateNote, useNotes } from "@/api/notes";
import { classifyMediaTransfer, type BlockedTransferReason } from "@/collab/schema";
import { createCodeBlockCaretExtension } from "@/collab/code-block-caret";
import { createColumnEdgeKeymapExtension } from "@/collab/columns/edge-keymap";
import { endBlockDrop } from "@/collab/columns/drag-source";
import { blockMoveDrop, computeDropPosition, edgeDrop, emptyColumnDrop, withGutterFileDrop } from "@/collab/columns/edge-drop";
import { createColumnsPasteExtension, withColumnsDropPoint } from "@/collab/columns/paste-rule";
import { buildCollabEditorBase } from "@/collab/editor-options";
import { createMarkdownLinkExtension } from "@/collab/markdown-link";
import { createMarkdownPasteHandler } from "@/collab/paste";
import { createSiteLinkConvertExtension, createSiteLinkEnv, createSiteLinkPasteHook, withSiteLinkDrop, type SiteLinkEnvRef } from "@/collab/site-link-convert";
import { createTourTransactionFilterExtension } from "@/collab/tour-transaction-filter";
import { useCollabUndoLifeline } from "@/collab/undo";
import { usePageUndoShortcut } from "@/collab/page-undo";
import { PHONE_SLASH_MENU_FLOATING_OPTIONS, buildSlashMenuItems, withoutSlashBadges } from "@/components/slash-menu";
import { LinkDialog } from "@/components/LinkDialog";
import { linkAtSelection } from "@/components/editor/link-at-selection";
import { toast } from "@/components/ui/toast";
import { cardSurface } from "@/components/ui/card";
import { ARTICLE_COLUMN_PADDING, ARTICLE_TEXT_INSET, articleColumn, articleColumnState } from "@/components/ui/article-column";
import { useNoteWidth } from "@/components/note-width";
import { cn } from "@/lib/utils";
import { useIsOutlineCompact, useIsOverlay, useIsPhone } from "@/lib/layout-tiers";
import { stickyTopInset, useStickyTopVar, useTierScrollAnchor } from "@/lib/page-scroll";
import { useTableScrollHint } from "@/lib/table-scroll-hint";
import { useTheme } from "@/theme";
import { buildWikilinkMenuItems, type EditorRef } from "@/components/wikilink/menu";
import { safeMediaUrl } from "@/lib/media-url";
import { createUploadFile, type Translate } from "@/uploads/upload-file";
import { createFilePanel } from "@/components/FilePanel";
import { AiSessionProvider } from "@/components/ai/AiSession";
import { createNoteSizeGuard, createNoteSizePasteHandlers, formatNoteLimit } from "@/lib/note-size-guard";
import { CornerStack } from "@/components/CornerStack";
import { useVersions } from "@/lib/versions-context";
import { notifyEditorEditable, registerEditor } from "@/lib/tour-bridge";
import { tourTarget } from "@/lib/tour-targets";
import { VERSIONS_ERROR_FRAME, VersionsLazyBoundary } from "@/components/versions/VersionsLazyBoundary";
import { useVersionsPanelWidth } from "@/components/versions/versions-panel-width";
import { useFloatingPanelDismiss, useNoteHeaderHeight } from "@/components/versions/floating-panel";
import { PHONE_EDIT_TOOLBAR_CLEARANCE_PX, SelectionAiController } from "@/components/ai/SelectionAiController";
import { CORNER_STACK_FOOTPRINT_PX } from "@/components/corner-stack-geometry";
import { PHONE_FAB_FOOTPRINT_PX } from "@/components/sidebar/PhoneListFabs";
import { MobileEditToolbar } from "@/components/editor/mobile/MobileEditToolbar";
import { MobileToolbarSpacer } from "@/components/editor/mobile/MobileToolbarSpacer";
import { KnotebookSideMenu, NotePathContext, SIDE_MENU_FLOATING_OPTIONS } from "@/components/editor/KnotebookSideMenu";
import { useDragActiveClass } from "@/components/editor/use-drag-active-class";
import { KnotebookTableCellButton, KnotebookTableHandle } from "@/components/editor/colors/KnotebookTableMenus";
import { HeadingAnchorButtons } from "@/components/editor/HeadingAnchorButtons";
import { MediaZoomProvider } from "@/components/media-zoom/MediaZoomProvider";
import { ImageZoomLayer } from "@/components/media-zoom/ImageZoomLayer";
import { ColumnDividers } from "@/components/editor/ColumnDividers";
import { LinkLongPress } from "@/components/LinkLongPress";
import { NoteOutline } from "@/components/outline/NoteOutline";
import { OutlineMenuContext } from "@/components/outline/outline-menu-context";
import { focusBackTo } from "@/components/outline/OutlineSheet";
import { PhoneNoteOutline } from "@/components/outline/PhoneNoteOutline";
import { canPinOutline } from "@/components/outline/outline-layout";
import { useOutlinePinned, usePinMotionReady } from "@/components/outline/outline-pin";
import { useOutlineBox } from "@/components/outline/use-outline-box";
import { useOutlineHeadings } from "@/components/outline/use-outline-headings";

const VersionsPanel = lazy(() =>
  import("@/components/versions/VersionsLazy").then(m => ({ default: m.VersionsPanel })),
);

export { collabUserColor };

const BLOCKED_TRANSFER_TOAST_KEYS: Record<BlockedTransferReason, string> = {
  dataUrl: "note.transferDataUrl",
  textRepresentation: "note.transferSaveFirst",
  nonImageFile: "note.transferNonImage",
};

/** Must be `handleDOMEvents`, not `handlePaste`/`handleDrop`: BlockNote registers `handleDOMEvents.paste` that unconditionally preventDefaults and handles it, and ProseMirror consults `handlePaste`/`handleDrop` only inside the built-in editHandlers, after `handleDOMEvents` found no taker. So the latter never run on paste, nor on a drop carrying only `Files`. `someProp` checks directly passed editorProps before plugins, so this runs before BlockNote. Returns true = handled, BlockNote paste logic never runs; false = falls through, so ordinary text paste is unaffected. `view` is unused and typed `unknown` so tests can pass `null`. */
export function createMediaBlockingDOMEvents(translate: Translate): {
  paste: (view: unknown, event: ClipboardEvent) => boolean;
  drop: (view: unknown, event: DragEvent) => boolean;
} {
  const block = (event: ClipboardEvent | DragEvent, data: DataTransfer | null): boolean => {
    const reason = classifyMediaTransfer(data);
    if (!reason) return false;
    event.preventDefault();
    toast({ title: translate(BLOCKED_TRANSFER_TOAST_KEYS[reason]) });
    return true;
  };
  return {
    paste: (_view, event) => block(event, event.clipboardData),
    drop: (_view, event) => block(event, event.dataTransfer),
  };
}

export interface NoteEditorOptionsInput {
  doc: Y.Doc;
  provider: Pick<HocuspocusProvider, "awareness">;
  user: { id: string; name: string };
  language: string;
  translate: Translate;
  /** Late-bound: this pure function runs before the editor exists, but `[[` detection reads it at typing time. */
  editorRef: EditorRef;
  noteId: string;
  siteLinks: SiteLinkEnvRef;
  /** Late-bound: the editor is not rebuilt when editable changes. Omitted = always send. */
  canSendCursor?: () => boolean;
  /** Late-bound (the limit loads after the editor is created); asked once per paste/drop after parsing and before insertion with the estimated growth in bytes; true = would exceed (already notified), insert rejected. Omitted = no check. */
  sizeGuard?: (incomingBytes: number) => boolean;
  /** Late-bound getter, read at each upload: config loads after the editor is created and can change. Omitted or undefined = no pre-check. */
  maxUploadBytes?: () => number | undefined;
}

/** Separate function so it can be tested without mounting BlockNote (jsdom lacks DOM/Range APIs). These options carry the contracts: image blocks get uploadFile while other media data URLs stay blocked, the collab fragment name, and the dictionary choice. */
export function buildNoteEditorOptions({
  doc,
  provider,
  user,
  language,
  translate,
  editorRef,
  noteId,
  siteLinks,
  canSendCursor,
  sizeGuard,
  maxUploadBytes,
}: NoteEditorOptionsInput) {
  const sizeHandlers = createNoteSizePasteHandlers(sizeGuard ?? (() => false));
  return withCollaboration({
    ...buildCollabEditorBase({
      doc,
      // no cursor while read-only (`@/collab/cursor-gate`)
      awareness: provider.awareness ? gateLocalCursor(provider.awareness, canSendCursor ?? (() => true)) : undefined,
      language,
      user: { id: user.id, name: user.name, color: collabUserColor(user.id) },
    }),
    // `createUploadFile` never rejects (see its header): on failure it toasts and removes the placeholder itself.
    uploadFile: createUploadFile({ noteId, editorRef, translate, maxUploadBytes }),
    // Render-side URL guard (issue #12): note content is a Yjs document, so any collaborator with editor permission can write block props directly, bypassing the UI Embed tab checks. BlockNote runs previews and "open/download" through `resolveFileUrl` (verified against @blocknote/core and react 0.52.1 dist), the one place that intercepts before every sink without rewriting block specs. It must allow relative URLs (the input-side absolute-http(s) rule would block every uploaded image): our own uploads are `/api/uploads/<id>` (rules in shared `note-schema-config.ts`, web base in `lib/media-url.ts`).
    resolveFileUrl: (url: string) => Promise.resolve(safeMediaUrl(url)),
    pasteHandler: createMarkdownPasteHandler(createSiteLinkPasteHook(siteLinks)),
    // same criterion as `edgeDrop` in `handleDrop` below
    dropCursor: { hooks: { computeDropPosition } },
    _tiptapOptions: {
      extensions: [
        createMarkdownLinkExtension({ editorRef, siteLinks }),
        createSiteLinkConvertExtension({ envRef: siteLinks }),
        createCodeBlockCaretExtension(),
        createColumnEdgeKeymapExtension({ editorRef }),
        createColumnsPasteExtension(),
        // Must be attached at build: plugins cannot be registered during the tour demo (`@/collab/tour-transaction-filter`).
        createTourTransactionFilterExtension(),
      ],
      editorProps: {
        // Order matters: site-link drop, then gutter file drop redirect (a ⋮⋮ drag redirects before the drop point is recorded, a file after the media block), then record the drop point (the columns paste rule uses it), then media blocking. Site-link drop: #352.
        handleDOMEvents: withSiteLinkDrop(siteLinks, editorRef, withGutterFileDrop(editorRef, withColumnsDropPoint(createMediaBlockingDOMEvents(translate)))),
        // Directly passed editorProps are consulted before plugins. Estimates growth after the slice is parsed and before insertion, rejecting over the limit; false continues to BlockNote and the columns paste rule.
        handlePaste: sizeHandlers.handlePaste,
        // Size check only when no handler took over (copy-drags, external drags; a move adds no content; #428, #429). The dragged block recorded at dragstart is always cleared afterwards; a ⋮⋮ drag is also recorded to refocus the editor after dragend (#430).
        handleDrop: (view, event, slice, moved) => {
          try {
            return (
              edgeDrop(editorRef.current, view, event) ||
              emptyColumnDrop(editorRef.current, view, event, slice) ||
              blockMoveDrop(editorRef.current, view, event, slice, moved) ||
              sizeHandlers.handleDrop(view, event, slice, moved)
            );
          } finally {
            endBlockDrop(view);
          }
        },
        // Not delegated to `SuggestionMenu` own multi-character detection: it compares `textBetween(from - 2, from) + text`, and `textBetween` returns fewer than 2 chars at block start, so it only works when the first `[` is the block first char (verified against @blocknote/core 0.52.1). Our handler runs first (directly passed editorProps before plugins).
        // Judge "after this input lands, are the characters before the caret `[[`", not the typed character (issue #98): ordinary typing is picked up by `readDOMChange` as "replace [from, to) with text", where `text` can be any length (fast typing merges to "[[", IME ends with e.g. "測試[[") and from may differ from to.
        handleTextInput: (view, from, to, text) => {
          const sel = view.state.selection;
          // The deletions use parameter coordinates but `openSuggestionMenu` inserts at the current selection: they must be the same range (if they differ we would delete in one place and insert in another, corrupting the document), so guard explicitly (ProseMirror normally guarantees it).
          if (sel.from !== from || sel.to !== to) return false;

          const doc = view.state.doc;
          // `from >= 1` is insurance before `resolve(from - 1)`; the same-parent check documents that a `[` ending the previous block does not count (`textBetween` is already empty across blocks).
          let before = "";
          if (from >= 1) {
            const $prev = doc.resolve(from - 1),
              $cur = doc.resolve(from);
            if ($prev.parent === $cur.parent) before = doc.textBetween(from - 1, from);
          }
          if (!(before + text).endsWith("[[")) return false;

          // Return control to ProseMirror: returning true without opening the menu would swallow what the user just typed.
          const menu = editorRef.current?.getExtension(SuggestionMenu);
          if (!menu) return false;

          // How many of the two `[` come from `text`: if it ends with `[[` none in the document needs deleting.
          const fromText = text.endsWith("[[") ? 2 : 1;
          const keep = text.slice(0, text.length - fromText);
          const start = from - (2 - fromText);
          const tr = view.state.tr;
          if (from < to) tr.delete(from, to);
          if (start < from) tr.delete(start, from);
          // Returning true swallows the input, so the content before `[[` must be reinserted by us. `openSuggestionMenu` inserts `[[` at the selection, already mapped to `start` by the dispatch above (so dispatch first).
          if (keep) tr.insertText(keep, start);
          if (tr.docChanged) view.dispatch(tr);
          // `deleteTriggerCharacter: true` so `clearQuery` also deletes `[[`; omitted/false leaves `[[` behind.
          menu.openSuggestionMenu("[[", { deleteTriggerCharacter: true });
          return true; // swallow this input
        },
      },
    },
  });
}

/** Restoring the selection is not defensive: `editor.createLink` acts on the current selection, not the one at open time. */
export function insertLinkAtSavedSelection(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor has three generic parameters; repo convention is any (as in wikilink/menu.ts)
  editor: any,
  savedSelection: { from: number; to: number } | null,
  { text, href }: { text: string; href: string },
): void {
  if (savedSelection) editor._tiptapEditor.commands.setTextSelection(savedSelection);
  editor.createLink(href, text);
}

/** `getSlashItems` must keep its identity across dialog open/close: a changing identity re-runs the `useLoadSuggestionMenuItems` effect (deps `[query, getItems]`) and the menu flashes its loading state. */
export function useLinkMenuState(editorRef: EditorRef, translate: Translate) {
  // The phone menu has no shortcut column; crossing 640 reloads the menu once. Do not add `linkDialogOpen` to its deps or replace `openLinkDialog` with an inline arrow.
  const phone = useIsPhone();
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  // Restore the saved selection explicitly rather than rely on it not having changed while the dialog took focus; a ref because it affects no output.
  const linkSelectionRef = useRef<{ from: number; to: number } | null>(null);
  const [linkPrefill, setLinkPrefill] = useState({ text: "", url: "" });

  const openLinkDialog = useCallback(() => {
    const currentEditor = editorRef.current;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor has three generic parameters; repo convention is any (as in wikilink/menu.ts)
    const sel = (currentEditor as any)?._tiptapEditor?.state?.selection;
    // Editing an existing link: apply range is the whole link and the text prefilled, so unchanged text only replaces the URL (a collapsed caret would insert the URL into the link).
    const link = linkAtSelection(currentEditor);
    const editingLink = link !== undefined;
    linkSelectionRef.current = editingLink ? { from: link.from, to: link.to } : sel ? { from: sel.from, to: sel.to } : null;
    setLinkPrefill(
      editingLink
        ? { text: link.text, url: link.href }
        : { text: currentEditor?.getSelectedText?.() ?? "", url: currentEditor?.getSelectedLinkUrl?.() ?? "" },
    );
    setLinkDialogOpen(true);
  }, [editorRef]);

  // `text` is never empty here (`LinkDialog` already falls back to `href`).
  const handleLinkInsert = useCallback(
    ({ text, href }: { text: string; href: string }) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;
      // Equal to the selection: add only the link (retyping loses bold etc.); `LinkDialog` trims, so compare trimmed prefill.
      const prefilled = linkPrefill.text.trim();
      const keepText = prefilled !== "" && text === prefilled;
      insertLinkAtSavedSelection(currentEditor, linkSelectionRef.current, { text: keepText ? "" : text, href });
    },
    [editorRef, linkPrefill.text],
  );

  const getSlashItems = useCallback(
    (query: string) => {
      const items = buildSlashMenuItems(editorRef.current, translate, openLinkDialog);
      return Promise.resolve(filterSuggestionItems(phone ? withoutSlashBadges(items) : items, query));
    },
    [editorRef, translate, openLinkDialog, phone],
  );

  return { linkDialogOpen, setLinkDialogOpen, openLinkDialog, linkPrefill, handleLinkInsert, getSlashItems };
}

export interface NoteEditorProps {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  editable: boolean;
  user: { id: string; name: string };
  noteId: string;
  /** A plain `ReactNode`: a new node each render does not rebuild the editor. */
  headerSlot?: ReactNode;
  /** Sits in the article column above the editor, outside its contenteditable, so it never enters the shared document. A slot that renders nothing leaves no gap. */
  contentTopSlot?: ReactNode;
  footerSlot?: ReactNode;
  mobileToolbar?: boolean;
  fabClearance?: boolean;
  /** The live editor is not unmounted (a `NoteEditorView` remount kills the y-prosemirror UndoManager subscription); a hidden container still receives remote updates. */
  previewSlot?: ReactNode;
  onScrollRoot?: (el: HTMLElement | null) => void;
  /** Caller must pass a stable identity; re-handed only when the editor changes. */
  onCursorScroller?: (scroller: CursorScroller | null) => void;
  notePath?: string;
  noteMaxBytes?: number;
  maxUploadBytes?: number;
  pageUndoShortcut?: boolean;
}

function blockLine(block: HTMLElement): Element {
  return block.querySelector(":scope > .bn-block > .bn-block-content") ?? block;
}

/** Must forward `opts`: the upload 409 text uses `{{used}}`/`{{quota}}`; dropping them prints raw placeholders (unit stubs hide it). */
export function lateBoundTranslate(ref: { current: Translate }): Translate {
  return (key, opts) => ref.current(key, opts);
}

/** Separate from `NotePage` so page tests can mock it (BlockNote needs DOM APIs jsdom lacks). Mounted only once provider/doc are ready, so no null handling inside. */
export function NoteEditor({
  doc,
  provider,
  editable,
  user,
  noteId,
  headerSlot,
  contentTopSlot,
  footerSlot,
  mobileToolbar = false,
  fabClearance = false,
  previewSlot,
  onScrollRoot,
  onCursorScroller,
  notePath,
  noteMaxBytes,
  maxUploadBytes,
  pageUndoShortcut = false,
}: NoteEditorProps) {
  const { t, i18n } = useTranslation();
  const [columnEl, setColumnEl] = useState<HTMLElement | null>(null);
  const columnElRef = useRef<HTMLElement | null>(null);
  columnElRef.current = columnEl;
  // While any drag runs, floating layers like ⋮⋮ must not take pointer events so the drop reaches the editor (`index.css`).
  useDragActiveClass(columnEl);
  const { resolvedTheme } = useTheme();
  const { panelOpen, enabled: versionsEnabled } = useVersions();
  const panelWidth = useVersionsPanelWidth();
  // floating panel (640-1279: the versions panel floats over the note): top edge leaves room for the header (`floating-panel.ts`)
  const rowRef = useRef<HTMLDivElement>(null);
  const headerSlotRef = useRef<HTMLDivElement>(null);
  useNoteHeaderHeight(rowRef, headerSlotRef);
  const { onKeyDown: onRowKeyDown } = useFloatingPanelDismiss();
  const [width] = useNoteWidth(noteId);
  const hasPreview = previewSlot !== undefined && previewSlot !== null;
  // Phone: the footer scrolls with the body; the toolbar blank space stays last.
  const phone = useIsPhone();
  const footerInScroll = phone && footerSlot !== undefined && footerSlot !== null;
  // Phone header is sticky: its height feeds `scroll-margin-top` and scroll-to calculations.
  useStickyTopVar(headerSlotRef, phone);

  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  // Re-measure and re-subscribe when the container mounts; a ref does not re-render.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const setScrollRoot = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRootRef.current = el;
      setScrollEl(el);
      onScrollRoot?.(el);
    },
    [onScrollRoot],
  );
  useTableScrollHint(scrollRootRef, phone);
  // Keep the reading position when crossing 640 (e.g. rotating). Anchor on the first visible block (its own line) so both layouts stop at the same paragraph; on phones measure the header directly (`--kb-sticky-top` not written yet).
  useTierScrollAnchor({
    containerRef: scrollRootRef,
    itemSelector: ".bn-block-outer",
    idAttr: "data-id",
    measure: blockLine,
    phoneTop: () => headerSlotRef.current?.getBoundingClientRect().height ?? 0,
  });
  const hasPreviewRef = useRef(hasPreview);
  hasPreviewRef.current = hasPreview;
  const onCursorScrollerRef = useRef(onCursorScroller);
  onCursorScrollerRef.current = onCursorScroller;
  // Written at render, not in an effect: when editable flips, BlockNoteView remounts the PM view during commit and the gate must already read the new value then.
  const editableRef = useRef(editable);
  editableRef.current = editable;

  // Closures fixed at creation read the latest `t` through a ref; rebuilding would break the y-prosemirror binding.
  const translateRef = useRef<Translate>(t);
  translateRef.current = t;

  // Limit and document are read through refs (closures are fixed at creation).
  const noteMaxBytesRef = useRef(noteMaxBytes);
  noteMaxBytesRef.current = noteMaxBytes;
  const maxUploadBytesRef = useRef(maxUploadBytes);
  maxUploadBytesRef.current = maxUploadBytes;
  const docRef = useRef(doc);
  docRef.current = doc;
  const [sizeGuard] = useState(() =>
    createNoteSizeGuard(
      () => docRef.current,
      () => noteMaxBytesRef.current,
      limit => toast({ title: translateRef.current("note.sizeLimitBlocked", { size: formatNoteLimit(limit) }) }),
    ),
  );

  // Late-bound ref bridges `buildNoteEditorOptions`, which runs before the editor exists.
  const editorRef = useRef<EditorRef["current"]>(null);

  // Refreshed each render; plugin and fallbacks read the ref at action time.
  const queryClient = useQueryClient();
  const siteLinksRef = useRef<SiteLinkEnvRef["current"]>(null);
  siteLinksRef.current = createSiteLinkEnv({
    origin: window.location.origin,
    getNotes: () => queryClient.getQueryData<NoteDto[]>(["notes"]),
    editorRef,
  });

  const editor = useCreateBlockNote(
    buildNoteEditorOptions({
      doc,
      provider,
      user,
      language: i18n.language,
      translate: lateBoundTranslate(translateRef),
      editorRef,
      noteId,
      siteLinks: siteLinksRef,
      canSendCursor: () => editableRef.current,
      sizeGuard,
      maxUploadBytes: () => maxUploadBytesRef.current,
    }),
    // Language and noteId are not in deps: the dictionary is read once at creation, and a noteId change always changes `doc`/`provider` (`collab/useCollab.ts`), so a language switch applies after reload (rebuilding would remount the collab binding, not worth it).
    [doc, provider],
  );
  editorRef.current = editor;
  // When a whole block is selected, a click on blank area becomes a caret so the outline disappears.
  const onScrollAreaMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0 || e.shiftKey) return;
      const root = e.currentTarget;
      const target = e.target as HTMLElement;
      const blank =
        target === root ||
        target === columnElRef.current ||
        target.hasAttribute("data-article-flow") ||
        (!target.closest(".bn-block-outer") && (target.classList.contains("bn-container") || target.classList.contains("bn-editor") || target.classList.contains("bn-block-group")));
      if (!blank) return;
      // A press on the scrollbar also targets the scroll container.
      if (root.clientWidth > 0 && e.clientX - root.getBoundingClientRect().left >= root.clientWidth) return;
      const view = editor.prosemirrorView as unknown as BlankClickView | undefined;
      if (!view) return;
      const focus = editableRef.current;
      if (clearNodeSelectionAt(view, { x: e.clientX, y: e.clientY }, focus) && focus) e.preventDefault();
    },
    [editor],
  );
  // The live editor is hidden during version preview: an undo would change invisible content.
  usePageUndoShortcut(editor, pageUndoShortcut && !hasPreview);

  // Phones have their own entry. Outline is hidden during version preview (it maps only the live document) and when the floating version panel would cover it (768-1279). Layout is measured only when it may appear: a changed measurement re-renders this layer, once per frame while resizing.
  const outlineHeadings = useOutlineHeadings(editor);
  const overlay = useIsOverlay();
  const outlineCompact = useIsOutlineCompact();
  const outlineCanShow = !outlineCompact && !hasPreview && !(panelOpen && overlay) && outlineHeadings.length > 0;
  const outlineBox = useOutlineBox(outlineCanShow ? scrollEl : null, outlineCanShow ? columnEl : null);
  const showOutline = outlineCanShow && outlineBox !== null;
  // Pinning preference is site-wide; it applies only with an outline, standard width and room for a 640 column (after subtracting the panel), else it falls back to the thin line without changing the preference; it re-pins automatically when conditions return.
  const [outlinePinPref, setOutlinePinPref] = useOutlinePinned();
  const outlinePinAvailable = width === "standard" && outlineBox !== null && canPinOutline(outlineBox.width);
  const outlinePinned = showOutline && outlinePinPref && outlinePinAvailable;
  const pinMotionReady = usePinMotionReady(showOutline);
  // Below 768: position bubble + bottom panel; ⋮ opens the same panel via context, so the provider wraps the whole card. 640-767 listens to the container (document does not scroll there); phones to the window. On phones the top edge is the pinned header bottom; at 640-767 the bubble floats in the anchor layer at the container top.
  const phoneOutline = outlineCompact && !hasPreview && outlineHeadings.length > 0;
  const containerTopEdge = useCallback(() => scrollEl?.getBoundingClientRect().top ?? 0, [scrollEl]);
  const [outlineSheetOpen, setOutlineSheetOpen] = useState(false);
  // Close the panel when it disappears so it does not pop up again when the condition returns.
  useEffect(() => {
    if (!phoneOutline) setOutlineSheetOpen(false);
  }, [phoneOutline]);
  // No trigger button, so without a target focus falls to body: when opened while editing (bubble tap) return to the editor (no scroll, selection unchanged); otherwise to the opener (⋮ or keyboard-opened bubble). Returning to the editor brings the edit toolbar back; a keyboard-opened bubble is still present (no countdown while the panel is open), a finger-tapped bubble never had focus so focus is left alone. Recorded at open because focus is in the panel and the toolbar is collapsed while open.
  const [outlineFocusReturn, setOutlineFocusReturn] = useState<{ editing: boolean; el: HTMLElement | null }>({ editing: false, el: null });
  const mobileToolbarRef = useRef(mobileToolbar);
  mobileToolbarRef.current = mobileToolbar;
  const openOutlineSheet = useCallback((returnFocusTo?: HTMLElement | null) => {
    setOutlineFocusReturn({ editing: mobileToolbarRef.current, el: returnFocusTo ?? null });
    setOutlineSheetOpen(true);
  }, []);
  const outlineMenu = useMemo(() => ({ available: phoneOutline, open: openOutlineSheet }), [phoneOutline, openOutlineSheet]);
  const outlineRestoreFocus = useMemo(
    () => (outlineFocusReturn.editing ? () => editor.prosemirrorView?.dom.focus({ preventScroll: true }) : focusBackTo(outlineFocusReturn.el)),
    [outlineFocusReturn, editor],
  );

  useEffect(() => {
    // Captured so cleanup reports to the same callback.
    const report = onCursorScrollerRef.current;
    report?.(createCursorScroller({ editor, getRoot: () => (hasPreviewRef.current ? null : scrollRootRef.current) }));
    return () => report?.(null);
  }, [editor]);

  useEffect(() => registerEditor(noteId, editor), [noteId, editor]);
  // Notify once per editor instance when it first becomes editable (the registry dedups). Register first, then notify in the same commit; `editor.isEditable` is set by BlockNoteView ref callback earlier in commit.
  useEffect(() => {
    if (editable) notifyEditorEditable(noteId, editor);
  }, [noteId, editor, editable]);

  const { linkDialogOpen, setLinkDialogOpen, openLinkDialog, linkPrefill, handleLinkInsert, getSlashItems } = useLinkMenuState(editorRef, t);

  const notes = useNotes().data;
  const { mutateAsync: createNote } = useCreateNote();

  // `getItems` is an effect dependency of `useLoadSuggestionMenuItems`: an inline arrow would re-run it on any re-render and flash the loading state; `useCallback` pins identity.
  const getItems = useCallback(
    (query: string) =>
      Promise.resolve(
        buildWikilinkMenuItems({
          query,
          notes: notes ?? [],
          createNote: (title) => createNote({ title }),
          editorRef,
          translate: (key) => t(key, { query }),
          toast,
        }),
      ),
    [notes, createNote, t],
  );


  // AI state is contained here; `useCreateBlockNote` and its deps stay untouched so no NotePage re-render can rebuild the editor.
  // Column width and padding come only from `ui/article-column.ts` (do not duplicate here). `NoteEditorView` gets `flex-1` because the wrapper `min-h-full` cannot pass a percentage height to its grandchild. `data-testid="note-editor"` stays on `NoteEditorView`/`BlockNoteView` (e2e and NoteEditor.layout.test.tsx). The version panel is the same node at 640-1279 (absolute) and 1280+ (third column) so crossing 1280 does not remount or lose list scroll.
  return (
    <OutlineMenuContext.Provider value={outlineMenu}>
    <AiSessionProvider editor={editor} noteId={noteId} editable={editable} sizeGuard={sizeGuard}>
      <div ref={rowRef} onKeyDown={onRowKeyDown} className="relative flex h-full min-h-0 min-w-0 flex-1 gap-3" style={panelWidth.style}>
        <div className={cn(
          cardSurface,
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden max-sm:rounded-none max-sm:border-0",
          // Phone: the document scrolls; the card does not clip (header sticky) and is at least `svh` high (unchanged as browser toolbars resize) so a short note still reaches the bottom; tapping below still focuses the end.
          "max-sm:min-h-svh max-sm:overflow-visible",
          // The floating toolbar brings its own bottom safe area; the container bottom sits above it so the toolbar top is 60px above (caret scroll boundary and AI box flip use it). With the keyboard closed the toolbar top is exactly 60px above the container bottom; with keyboard or palette open the gap is a few px larger, harmless.
          mobileToolbar && "max-sm:pb-[env(safe-area-inset-bottom)]",
        )}>
          {/* phone: header slot owns the notch safe area and is pinned (opaque) */}
          <div ref={headerSlotRef} data-note-header-slot="" className="max-sm:sticky max-sm:top-0 max-sm:z-30 max-sm:bg-card max-sm:pt-[env(safe-area-inset-top)]">
            {headerSlot}
          </div>
          {showOutline && (
            <NoteOutline
              headings={outlineHeadings}
              scrollEl={scrollEl}
              box={outlineBox}
              bubbleShown={versionsEnabled && !panelOpen}
              pinned={outlinePinned}
              pinAvailable={outlinePinAvailable}
              onPinnedChange={setOutlinePinPref}
            />
          )}
          {phoneOutline && (
            <PhoneNoteOutline
              headings={outlineHeadings}
              root={scrollEl}
              scrollTarget={phone ? window : scrollEl}
              topEdge={phone ? stickyTopInset : containerTopEdge}
              placement={phone ? "page" : "anchor"}
              inputRoot={columnEl}
              editToolbarHeight={phone && mobileToolbar ? PHONE_EDIT_TOOLBAR_CLEARANCE_PX : 0}
              // Non-phone: same condition CornerStack uses to show the bubble (versions enabled, panel closed).
              bottomReserve={phone ? (fabClearance ? PHONE_FAB_FOOTPRINT_PX : 0) : versionsEnabled && !panelOpen ? CORNER_STACK_FOOTPRINT_PX : 0}
              sheetOpen={outlineSheetOpen}
              onSheetOpenChange={setOutlineSheetOpen}
              onOpenSheet={openOutlineSheet}
              restoreFocus={outlineRestoreFocus}
            />
          )}
          {/* Phone: height grows from content (flex-basis auto, not `flex-1` 0%): a 0% basis with `min-h-full` overflows and the sticky header leaves with the card bottom. */}
          <div
            ref={setScrollRoot}
            onMouseDown={onScrollAreaMouseDown}
            className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-clip max-sm:overflow-y-visible sm:[scrollbar-gutter:stable]", hasPreview ? "hidden" : "max-sm:flex max-sm:flex-auto max-sm:flex-col")}
          >
            {/* `relative` is load-bearing (#160): BlockNote table hover overlays use FloatingPortal into `editor.portalElement`; without a positioned ancestor (wrapper, scroll container or `.bn-container` all work) they size against `<html>` and grow a page scrollbar (extend buttons lack flip/shift). `overflow-x-clip` (#162) crops right-overflowing "add row" buttons: css-overflow-3 section 3.1 makes `clip` compute to `hidden` when the other axis is non-visible; `overflow-x:auto` already clips at the same box, so nothing new is clipped. Side +/⠿ handles overflow left and are clipped (`docs/known-limitations.md`, #115); the public page disables them via `!isEditable`. `scrollWidth` ignores `overflow-x`. We never call `scrollIntoView` and caret-follow is consumed by `.tableWrapper` first. Details in `14-table-hover.spec.ts`. */}
            {/* phone: wrapper at least as tall as the scroll container so a short note gets no extra scroll range */}
            <div data-article-flow="" className={footerInScroll || fabClearance ? "flex min-h-full flex-col max-sm:grow" : "contents"}>
            <div
              ref={setColumnEl}
              data-testid="article-column"
              className={cn(
                articleColumn(articleColumnState(width, outlinePinned), { pinMotion: pinMotionReady }),
                ARTICLE_COLUMN_PADDING,
                "relative flex flex-col py-6",
                footerInScroll || fabClearance ? "grow shrink-0" : "min-h-full",
              )}
            >
              {contentTopSlot !== undefined && contentTopSlot !== null && (
                <div data-note-content-top="" className={cn(ARTICLE_TEXT_INSET, "shrink-0 pb-2 empty:hidden")}>
                  {contentTopSlot}
                </div>
              )}
              {/* zoom covers only the article column */}
              <MediaZoomProvider>
                <NoteEditorView
                  editor={editor}
                  editable={editable}
                  theme={resolvedTheme}
                  noteId={noteId}
                  getItems={getItems}
                  getSlashItems={getSlashItems}
                  notePath={notePath}
                >
                  {/* sole owner of the formatting toolbar controller and AI box; NoteEditorView never touches AI context */}
                  <SelectionAiController />
                </NoteEditorView>
                <HeadingAnchorButtons container={columnEl} />
                <ImageZoomLayer container={columnEl} editable={editable} editor={editor} />
              </MediaZoomProvider>
              {/* nothing to resize when read-only */}
              {editable && <ColumnDividers container={columnEl} editor={editor} />}
              {mobileToolbar && !footerInScroll && <MobileToolbarSpacer />}
            </div>
            {/* footer before the toolbar blank space so it can scroll above the toolbar */}
            {footerInScroll && footerSlot}
            {mobileToolbar && footerInScroll && <MobileToolbarSpacer />}
            {/* 56 button + 16 offset + safe area + 8 gap */}
            {fabClearance && <div aria-hidden="true" data-fab-clearance="" className="h-[calc(5rem+env(safe-area-inset-bottom))] shrink-0" />}
            </div>
          </div>
          {hasPreview && (
            // At 640-1279 the panel floats: margin (not padding) so the preview scrollbar is not covered, and the preview width threshold measures the remaining width.
            <div
              data-testid="preview-slot"
              className={cn(
                "min-h-0 min-w-0 flex-1 overflow-y-auto",
                panelOpen && "max-xl:mr-[min(var(--versions-panel-width),calc(100%_-_3rem))]",
              )}
            >
              {previewSlot}
            </div>
          )}
          {/* history bubble anchor */}
          <CornerStack scrollRef={scrollRootRef} />
          {!footerInScroll && footerSlot}
        </div>
        {panelOpen && (
          // `display: contents` keeps the row container as positioning base; collapse and Esc checks recognise this node.
          <div data-versions-panel-slot="" className="contents">
            <VersionsLazyBoundary noteId={noteId} errorClassName={VERSIONS_ERROR_FRAME.panel}>
              <VersionsPanel doc={doc} width={panelWidth.width} onWidthChange={panelWidth.onChange} />
            </VersionsLazyBoundary>
          </div>
        )}
        {mobileToolbar && <MobileEditToolbar editor={editor} onCreateLink={openLinkDialog} />}
      </div>
      {/* Open state lives here (`openLinkDialog` feeds `getSlashItems`). */}
      <LinkDialog
        editor={editor}
        open={linkDialogOpen}
        onOpenChange={setLinkDialogOpen}
        onSubmit={handleLinkInsert}
        initialText={linkPrefill.text}
        initialUrl={linkPrefill.url}
      />
    </AiSessionProvider>
    </OutlineMenuContext.Provider>
  );
}

/** Different ids per menu: a just-closed menu lingers in the DOM and a shared id would highlight the old one in the tour. Module-level constants (identity is a `useMemo` dependency). Only adds attributes; never set `style`/`onMouseDownCapture` here. */
const WIKILINK_MENU_FLOATING_OPTIONS: Partial<FloatingUIOptions> = {
  elementProps: tourTarget("wikilinkMenu") as FloatingUIOptions["elementProps"],
};
const SLASH_MENU_FLOATING_OPTIONS: Partial<FloatingUIOptions> = {
  elementProps: tourTarget("slashMenu") as FloatingUIOptions["elementProps"],
};
const WIKILINK_MENU_PHONE_FLOATING_OPTIONS: Partial<FloatingUIOptions> = {
  ...PHONE_SLASH_MENU_FLOATING_OPTIONS,
  ...WIKILINK_MENU_FLOATING_OPTIONS,
};
const SLASH_MENU_PHONE_FLOATING_OPTIONS: Partial<FloatingUIOptions> = {
  ...PHONE_SLASH_MENU_FLOATING_OPTIONS,
  ...SLASH_MENU_FLOATING_OPTIONS,
};

export interface NoteEditorViewProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor has three generic parameters; repo convention is any (as in wikilink/menu.ts)
  editor: BlockNoteEditor<any, any, any>;
  editable: boolean;
  theme: "light" | "dark";
  noteId: string;
  getItems: (query: string) => Promise<DefaultReactSuggestionItem[]>;
  getSlashItems: (query: string) => Promise<DefaultReactSuggestionItem[]>;
  children?: ReactNode;
  notePath?: string;
}

/** Separate exported component so the `filePanel={false}` and `useMemo` identity contracts can be tested with a real editor (`NoteEditorView.test.tsx`). */
export function NoteEditorView({ editor, editable, theme, noteId, getItems, getSlashItems, children, notePath }: NoteEditorViewProps) {
  const phone = useIsPhone();
  // If the block menu was open when narrowing to phone width, the controller unmounts but core's menu stays frozen: unfreeze it (state must exist first or core throws).
  useEffect(() => {
    if (!phone) return;
    const sideMenu = editor.getExtension(SideMenuExtension);
    if (sideMenu?.store.state?.show) sideMenu.unfreezeMenu();
  }, [phone, editor]);
  // `createFilePanel(noteId)` returns a new component type: pin with `useMemo` or `FilePanelController` remounts it.
  const filePanel = useMemo(() => createFilePanel(noteId), [noteId]);

  // y-prosemirror undo plugin destroys the UndoManager when the PM view is destroyed, and `editable` flipping remounts the view: without this Ctrl+Z dies after editable goes false to true (#97, see `@/collab/undo`). Lives here because this component holds `<BlockNoteView>`.
  useCollabUndoLifeline(editor);

  return (
    <NotePathContext.Provider value={notePath ?? null}>
      <BlockNoteView
        editor={editor}
        editable={editable}
        theme={theme}
        data-testid="note-editor"
        // Phone: column height grows from content (`flex-auto`); `flex-1` 0% + `min-h-full` overflows. className also lands on BlockNote portal root, whose `min-h-full` would add a blank section on phones, hence zeroed.
        className="min-h-full flex-1 max-sm:min-h-0 max-sm:flex-auto"
        // false: otherwise two file panel controllers stack (ours replaces it; see `components/FilePanel.tsx`)
        filePanel={false}
        // false is required: `SelectionAiController` owns the formatting toolbar and suppresses it while the AI box is open; a default one would escape that.
        formattingToolbar={false}
        // false: otherwise two slash menus stack
        slashMenu={false}
        // false: our side menu adds "Copy section link" (#269)
        sideMenu={false}
        // false: our table handles add custom colours
        tableHandles={false}
        // false: ours applies phone floating options so it does not cover the toolbar
        emojiPicker={false}
      >
        <SuggestionMenuController
          triggerCharacter="[["
          getItems={getItems}
          floatingUIOptions={phone ? WIKILINK_MENU_PHONE_FLOATING_OPTIONS : WIKILINK_MENU_FLOATING_OPTIONS}
        />
        <GridSuggestionMenuController
          triggerCharacter=":"
          columns={10}
          minQueryLength={2}
          floatingUIOptions={phone ? PHONE_SLASH_MENU_FLOATING_OPTIONS : undefined}
        />
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={getSlashItems}
          floatingUIOptions={phone ? SLASH_MENU_PHONE_FLOATING_OPTIONS : SLASH_MENU_FLOATING_OPTIONS}
        />
        {/* no block handle below 640: a touch tap would flash it */}
        {!phone && <SideMenuController sideMenu={KnotebookSideMenu} floatingUIOptions={SIDE_MENU_FLOATING_OPTIONS} />}
        <TableHandlesController tableHandle={KnotebookTableHandle} tableCellHandle={KnotebookTableCellButton} />
        <FilePanelController filePanel={filePanel} />
        {/* touch long-press on a link opens the link toolbar */}
        <LinkLongPress />
        {children}
      </BlockNoteView>
    </NotePathContext.Provider>
  );
}
