import { useMemo } from "react";
import { flip, offset, shift, size } from "@floating-ui/react";
import { FormattingToolbarExtension } from "@blocknote/core/extensions";
import {
  FormattingToolbarController,
  useBlockNoteEditor,
  useEditorState,
  useExtensionState,
  type FloatingUIOptions,
} from "@blocknote/react";
import { isNonTextSelection, selectionInsideAnchor } from "@/ai/selection";
import { useIsPhone } from "@/lib/layout-tiers";
import { stickyTopInset } from "@/lib/page-scroll";
import { activeAnchorOf, useAiSession } from "./AiSession";
import { AiToolbar } from "./AiToolbar";
import { SelectionAiBox } from "./SelectionAiBox";

/**
 * Marks the floating-ui element wrapping the toolbar (z-index 40) so pointer hits on it can be disabled while dragging (`.kb-dragging` in
 * `index.css`): dragging by the handle selects the block and puts the toolbar right above it, where it would swallow the drop.
 * No `style` here: `FormattingToolbarController` spreads `{ style: { zIndex: 40 }, ...elementProps }`, so a `style` would replace the z-index.
 */
export const FORMATTING_TOOLBAR_ELEMENT_PROPS = { "data-kb-formatting-toolbar-popover": "" } as FloatingUIOptions["elementProps"];

/** Phone edit toolbar frame height (52px pill + 8px gap below); the floating toolbar must stay clear of it when it flips below and when the editor scrolls. */
export const PHONE_EDIT_TOOLBAR_CLEARANCE_PX = 60;

export const PHONE_FLOATING_TOOLBAR_EDGE_PX = 8;

/**
 * Same as BlockNote's default (offset, shift, flip), but on phones flip's bottom edge is inset by `bottomPadding` so the toolbar never
 * flips under the phone edit toolbar; floating-ui's boundary is already the visual viewport, so keyboard height isn't added.
 * Phones also cap the width at `100vw - 16px` (the button row can be wider than a 320px viewport and stick out on the right) and the inner
 * `.bn-toolbar` scrolls the rest horizontally; no overflow here, since a non-visible overflow-x makes overflow-y non-visible too and would
 * clip dropdowns and panels. shift keeps 8px on each side. `size` runs before `shift` so shift uses the capped width; shift's boundary is the
 * whole document (`document.documentElement`), not the default clipping ancestor, because the body card's side margins would leave the
 * toolbar wider than the space inside the card.
 */
export function formattingToolbarMiddleware(bottomPadding: number) {
  if (bottomPadding <= 0) return [offset(10), shift(), flip()];
  return [
    offset(10),
    size({
      apply({ elements }) {
        elements.floating.style.maxWidth = `calc(100vw - ${PHONE_FLOATING_TOOLBAR_EDGE_PX * 2}px)`;
      },
    }),
    shift({ boundary: document.documentElement, padding: { left: PHONE_FLOATING_TOOLBAR_EDGE_PX, right: PHONE_FLOATING_TOOLBAR_EDGE_PX } }),
    // On phones the document scrolls and the page header is pinned: inset the top by its height (read at each positioning) and flip below when there's no room above.
    flip(() => ({ padding: { top: stickyTopInset(), bottom: bottomPadding } })),
  ];
}

/**
 * Sole owner of the formatting toolbar controller and `SelectionAiBox` (`NoteEditorView` doesn't touch the AI context).
 * `toolbarStoreOpen` is the upstream store (always false during pointerdown) and is used only for `toolbarOpen`; the box's
 * auto-close uses `toolbarWouldShow` from `ai/selection.ts`. Overriding `useFloatingOptions.open` is enough to collapse the toolbar:
 * GenericPopover mounts by floating's `open` (collapsing has a ~270ms transition).
 */
export function SelectionAiController() {
  const editor = useBlockNoteEditor();
  const phone = useIsPhone();
  const { state, editable } = useAiSession();
  const flipBottomPadding = phone ? PHONE_EDIT_TOOLBAR_CLEARANCE_PX : 0;
  const toolbarStoreOpen = useExtensionState(FormattingToolbarExtension, { editor });
  const anchor = activeAnchorOf(state);
  const boxOpen = state.phase !== "idle";
  const insideTarget = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current !== null && anchor !== null && current.transact((tr) => selectionInsideAnchor(tr, anchor.blockIds)),
  });
  const nonTextSelection = useEditorState({
    editor,
    selector: ({ editor: current }) => current !== null && current.transact((tr) => isNonTextSelection(tr)),
  });
  // Phones (<640) hide the floating toolbar for text selections, where under touch it covers the selection and the system menu; image/file/cell
  // selections keep it (their replace, delete, merge actions have no other entry point). The AI box still opens from the phone edit toolbar.
  const hiddenOnPhone = phone && !nonTextSelection;
  // Read-only, the store still opens on a selection made without a pointer drag (a double-click, the keyboard), but every item renders nothing; readers get `ViewerCommentToolbar`.
  const toolbarOpen = toolbarStoreOpen && editable && !hiddenOnPhone && !(boxOpen && insideTarget);
  // FormattingToolbarController's internal useMemo depends on this object's identity; a new object per render would recompute every time.
  const floatingUIOptions = useMemo<FloatingUIOptions>(
    () => ({
      useFloatingOptions: { open: toolbarOpen, ...(flipBottomPadding > 0 && { middleware: formattingToolbarMiddleware(flipBottomPadding) }) },
      elementProps: FORMATTING_TOOLBAR_ELEMENT_PROPS,
    }),
    [toolbarOpen, flipBottomPadding],
  );

  return (
    <>
      <FormattingToolbarController formattingToolbar={AiToolbar} floatingUIOptions={floatingUIOptions} />
      <SelectionAiBox />
    </>
  );
}
