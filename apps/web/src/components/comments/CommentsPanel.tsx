import "@/i18n/comments-strings";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type * as Y from "yjs";
import { PaneResizeHandle } from "@/components/PaneResizeHandle";
import { focusCornerBubble, focusFromCorner } from "@/components/corner-stack-state";
import { cardSurface } from "@/components/ui/card";
import { X } from "@/components/ui/icons";
import {
  VERSIONS_PANEL_PLACEMENT,
  VERSIONS_PANEL_WIDTH_DEFAULT,
  VERSIONS_PANEL_WIDTH_MAX,
  VERSIONS_PANEL_WIDTH_MIN,
  VERSIONS_PANEL_WIDTH_STEP,
} from "@/components/versions/versions-panel-width";
import { useComments } from "@/lib/comments-context";
import { useIsOverlay } from "@/lib/layout-tiers";
import { cn } from "@/lib/utils";
import { CommentThread } from "./CommentThread";

export function CommentsPanel({ doc, width, onWidthChange }: { doc: Y.Doc; width: number; onWidthChange: (px: number, commit: boolean) => void }) {
  const { t } = useTranslation();
  const { close: closeComments, noteId } = useComments();
  // As with Esc, the bubble takes the focus the ✕ had.
  const close = () => {
    closeComments();
    requestAnimationFrame(() => focusCornerBubble("comments-bubble"));
  };
  const asideRef = useRef<HTMLElement>(null);
  const [renderedWidth, setRenderedWidth] = useState(0);
  useEffect(() => {
    const el = asideRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setRenderedWidth(Math.round(el.getBoundingClientRect().width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Opened from a bubble, or from the version history panel that just unmounted (focus is then on the page). The panel also remounts on
  // every note switch while it stays open: focus that is somewhere else stays there.
  useEffect(() => {
    if (focusFromCorner()) asideRef.current?.querySelector("textarea")?.focus({ preventScroll: true });
  }, []);
  // As in the version history panel: the floating segment can be narrower than the setting, and widening up to the setting must not lower it.
  const overlay = useIsOverlay();
  const shownWidth = overlay && renderedWidth > 0 ? Math.min(width, renderedWidth) : width;
  const handleWidthChange = (px: number, commit: boolean) => {
    if (px >= shownWidth && px < width) return;
    onWidthChange(px, commit);
  };

  return (
    <aside ref={asideRef} data-testid="comments-panel" aria-label={t("comments.title")} className={cn(cardSurface, "flex shrink-0 flex-col", VERSIONS_PANEL_PLACEMENT)}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
        <div className="flex items-center justify-between px-3 pt-3">
          <h2 className="text-sm font-semibold">{t("comments.title")}</h2>
          <button type="button" aria-label={t("comments.close")} onClick={close} className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <CommentThread key={noteId ?? ""} doc={doc} />
      </div>
      <PaneResizeHandle
        width={shownWidth}
        onChange={handleWidthChange}
        min={VERSIONS_PANEL_WIDTH_MIN}
        max={VERSIONS_PANEL_WIDTH_MAX}
        defaultWidth={VERSIONS_PANEL_WIDTH_DEFAULT}
        step={VERSIONS_PANEL_WIDTH_STEP}
        edge="left"
        label={t("comments.resize")}
        placementClassName="right-full"
      />
    </aside>
  );
}
