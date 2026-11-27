import { useCallback, useEffect, useMemo, useState } from "react";
import { flip, offset, shift } from "@floating-ui/react";
import { PositionPopover, useBlockNoteEditor, useComponentsContext, type FloatingUIOptions } from "@blocknote/react";
import type { EditorView } from "prosemirror-view";
import { useComments } from "@/lib/comments-context";
import { useIsPhone } from "@/lib/layout-tiers";
import { PassageCommentButton } from "./PassageCommentButton";

interface Range {
  from: number;
  to: number;
}

const TOOLBAR_ATTR = "data-kb-viewer-comment-toolbar";

function readRange(editor: { prosemirrorView?: EditorView }): Range | null {
  const view = editor.prosemirrorView;
  const selection = document.getSelection();
  if (!view || !selection || selection.rangeCount === 0 || selection.isCollapsed || selection.toString().trim() === "") return null;
  const dom = selection.getRangeAt(0);
  if (!view.dom.contains(dom.startContainer) || !view.dom.contains(dom.endContainer)) return null;
  try {
    const from = view.posAtDOM(dom.startContainer, dom.startOffset);
    const to = view.posAtDOM(dom.endContainer, dom.endOffset);
    return to > from ? { from, to } : null;
  } catch {
    return null;
  }
}

/**
 * Read-only editors get no formatting toolbar (SelectionAiController), so readers get this one-button toolbar instead. Mount it only while the
 * editor is read-only. The range comes from the DOM selection, not the editor state: a read-only view keeps its last selection when the DOM
 * selection moves outside it, which would leave the toolbar up after a click elsewhere. Positions shift when someone else edits earlier in
 * the note without any selectionchange, so the range is re-read at click time and on every editor change.
 */
export function ViewerCommentToolbar() {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext()!;
  const phone = useIsPhone();
  const { enabled } = useComments();
  const [range, setRange] = useState<Range | null>(null);
  const [mouseHeld, setMouseHeld] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const refresh = () => {
      const next = readRange(editor);
      setRange((prev) => (prev?.from === next?.from && prev?.to === next?.to ? prev : next));
    };
    const onSelectionChange = () => {
      refresh();
      setDismissed(false);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest(`[${TOOLBAR_ATTR}]`))) return;
      setMouseHeld(true);
    };
    const onMouseUp = () => setMouseHeld(false);
    onSelectionChange();
    const unsubscribe = editor.onChange(refresh);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mouseup", onMouseUp, true);
    return () => {
      unsubscribe();
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mouseup", onMouseUp, true);
    };
  }, [editor]);

  const open = enabled && !phone && !mouseHeld && !dismissed && range !== null;
  const onOpenChange = useCallback((next: boolean) => {
    if (!next) setDismissed(true);
  }, []);
  const floatingUIOptions = useMemo<FloatingUIOptions>(
    () => ({
      useFloatingOptions: { open, onOpenChange, placement: "top-start", middleware: [offset(10), shift(), flip()] },
      focusManagerProps: { disabled: true },
      elementProps: { style: { zIndex: 40 }, [TOOLBAR_ATTR]: "" } as FloatingUIOptions["elementProps"],
    }),
    [open, onOpenChange],
  );
  const currentRange = useCallback(() => readRange(editor), [editor]);

  return (
    <PositionPopover position={open ? range : undefined} {...floatingUIOptions}>
      {open && (
        // Keeps the note's selection (and the range read from it) through the click, so the toolbar isn't swapped for its closing copy first.
        <div onMouseDown={(event) => event.preventDefault()}>
          <Components.FormattingToolbar.Root className="bn-toolbar bn-formatting-toolbar">
            <PassageCommentButton range={currentRange} />
          </Components.FormattingToolbar.Root>
        </div>
      )}
    </PositionPopover>
  );
}
