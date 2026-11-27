import { useId, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useCommentUnreadCount } from "@/api/comments";
import { Button } from "@/components/ui/button";
import { FROSTED_SURFACE } from "@/components/ui/frosted";
import { ChevronDown, ChevronUp, History, MessageSquare } from "@/components/ui/icons";
import { useComments } from "@/lib/comments-context";
import { useIsPhone } from "@/lib/layout-tiers";
import { useVersions } from "@/lib/versions-context";
import { tourTarget } from "@/lib/tour-targets";
import { CORNER_STACK_GAP_PX, cornerStackFootprint } from "./corner-stack-geometry";
import { useCornerStackExpanded } from "./corner-stack-state";

/** Nothing sits under the bubble, so hover uses a brand background instead of opacity. Last in the class string so twMerge overrides the frosted hover/press values. `hover:` applies only on hover-capable pointers (`@media (hover: hover)`), so touch is unaffected. */
const BUBBLE_HOVER =
  "cursor-pointer hover:bg-brand-soft supports-[backdrop-filter]:hover:bg-brand-soft active:bg-brand-soft-strong supports-[backdrop-filter]:active:bg-brand-soft-strong";
const BUBBLE = `h-12 w-12 rounded-full text-brand-on-soft hover:text-brand-on-soft ${FROSTED_SURFACE} ${BUBBLE_HOVER}`;
// The open panel's bubble keeps the pressed tint, also under the pointer.
const BUBBLE_PRESSED = "aria-pressed:bg-brand-soft-strong supports-[backdrop-filter]:aria-pressed:bg-brand-soft-strong";

const CORNER_STACK_CLEARANCE_CSS_VAR = "--corner-stack-clearance";
// Below this the floating panel's header, list and composer no longer fit.
const FLOATING_PANEL_MIN_REM = 18;

/** `tight`: the floating panel wouldn't keep its minimum height above the expanded stack, so only the toggle shows, whatever the saved choice; pressing it then shows the bubbles for now (`shown`) without changing that choice. */
export interface CornerStackRoom {
  tight: boolean;
  shown: boolean;
  toggle(): void;
}

/** None below 640, where the ⋮ menu has the entries. `count` is how many round buttons the stack shows: the toggle plus, when expanded, the bubbles. */
export function useCornerStackBubbles(room?: CornerStackRoom): {
  versions: boolean;
  comments: boolean;
  bubbles: number;
  preferExpanded: boolean;
  expanded: boolean;
  count: number;
} {
  const versions = useVersions();
  const comments = useComments();
  const phone = useIsPhone();
  const [preferExpanded] = useCornerStackExpanded();
  const v = !phone && versions.enabled;
  const c = !phone && comments.enabled;
  const bubbles = (v ? 1 : 0) + (c ? 1 : 0);
  const expanded = room?.tight ? room.shown : preferExpanded;
  return { versions: v, comments: c, bubbles, preferExpanded, expanded, count: bubbles === 0 ? 0 : 1 + (expanded ? bubbles : 0) };
}

/**
 * 640-1279: the floating panel's bottom edge stops above the stack (`VERSIONS_PANEL_PLACEMENT` reads the variable), so the bubbles stay
 * reachable for switching panels; where that would leave the panel too short, the stack shrinks to its toggle instead. Measured from the
 * anchor because the stack sits above the mentions row, whose height varies. The clearance is written to the row container's style, not
 * state, like `--note-header-h`.
 */
export function useCornerStackRoom(
  rowRef: RefObject<HTMLElement | null>,
  scrollEl: HTMLElement | null,
  active: boolean,
  bubbles: number,
  preferExpanded: boolean,
): CornerStackRoom {
  const [tight, setTight] = useState(false);
  const [shown, setShown] = useState(false);
  if (!active && (tight || shown)) {
    setTight(false);
    setShown(false);
  }
  useLayoutEffect(() => {
    const row = rowRef.current;
    const anchor = row?.querySelector<HTMLElement>('[data-testid="corner-anchor"]') ?? null;
    if (row === null || anchor === null || !active || bubbles === 0) return;
    const header = row.querySelector<HTMLElement>("[data-note-header-slot]");
    const measure = () => {
      const box = row.getBoundingClientRect();
      const belowStack = box.bottom - anchor.getBoundingClientRect().top + CORNER_STACK_GAP_PX;
      const clearance = (buttons: number) => Math.max(0, Math.round(belowStack + cornerStackFootprint(buttons)));
      const panelHeight = box.height - (header?.getBoundingClientRect().height ?? 0) - clearance(1 + bubbles);
      const minPx = FLOATING_PANEL_MIN_REM * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
      // A row with no height isn't laid out (jsdom, hidden): nothing to fit.
      const nextTight = box.height > 0 && panelHeight < minPx;
      setTight(nextTight);
      if (!nextTight) setShown(false);
      const all = nextTight ? shown : preferExpanded;
      row.style.setProperty(CORNER_STACK_CLEARANCE_CSS_VAR, `${clearance(all ? 1 + bubbles : 1)}px`);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(row);
    if (scrollEl !== null) observer?.observe(scrollEl);
    if (header !== null) observer?.observe(header);
    return () => {
      observer?.disconnect();
      row.style.removeProperty(CORNER_STACK_CLEARANCE_CSS_VAR);
    };
  }, [rowRef, scrollEl, active, bubbles, preferExpanded, shown]);
  return { tight: active && tight, shown: active && shown, toggle: () => setShown((v) => !v) };
}

/**
 * Pinned to the scroll area bottom (zero-height anchor), not the window corner. Hidden below 640 (reads the same `useIsPhone()` as the ⋮ versions and comments items, so each width has exactly one entry). 18px above the scroll area bottom and 18px left of the scrollbar gutter (the scroll area reserves one from 640 up, `scrollbar-gutter: stable`). Does not fade on scroll.
 * Stays while a panel is open, so the bubbles also switch between the two panels.
 */
export function CornerStack({ scrollRef, room }: { scrollRef?: RefObject<HTMLElement | null>; room?: CornerStackRoom }) {
  const { t } = useTranslation();
  const versions = useVersions();
  const comments = useComments();
  const bubbles = useCornerStackBubbles(room);
  const [, toggleSaved] = useCornerStackExpanded();
  const toggle = room?.tight ? room.toggle : toggleSaved;
  const { expanded } = bubbles;
  const show = bubbles.count > 0;
  const groupId = useId();
  const unread = useCommentUnreadCount(comments.noteId, bubbles.comments).data?.count ?? 0;
  // The gutter width is measured because Firefox thin scrollbars are narrower than `--scrollbar-size`; falls back to it when unmeasurable (jsdom, hidden).
  const [gutter, setGutter] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef?.current;
    if (!show || !el || typeof ResizeObserver === "undefined") return;
    const measure = () => setGutter(el.offsetWidth > 0 ? el.offsetWidth - el.clientWidth : null);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [show, scrollRef]);

  if (!show) return null;

  const commentsLabel = t("note.menu.comments");
  const dot = !expanded && unread > 0;
  // `flex-col-reverse`: the first child is the bottom one, so the toggle is at the bottom and the comments bubble sits above the version history bubble.
  return (
    <div data-testid="corner-anchor" className="pointer-events-none relative z-20 h-0 shrink-0">
      <div
        data-testid="corner-stack"
        className="pointer-events-auto absolute bottom-[18px] right-[calc(18px+var(--bubble-gutter,var(--scrollbar-size)))] flex flex-col-reverse gap-3"
        style={gutter !== null && gutter > 0 ? ({ "--bubble-gutter": `${gutter}px` } as CSSProperties) : undefined}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="corner-toggle"
          aria-label={dot ? t("note.cornerToggleUnread") : t("note.cornerToggle")}
          aria-expanded={expanded}
          aria-controls={expanded ? groupId : undefined}
          onClick={toggle}
          className={`relative ${BUBBLE}`}
        >
          {expanded ? <ChevronDown className="h-5 w-5" /> : <ChevronUp className="h-5 w-5" />}
          {dot && <span aria-hidden="true" data-testid="corner-unread-dot" className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-brand-deep" />}
        </Button>
        {expanded && (
          <div id={groupId} data-testid="corner-bubbles" className="flex flex-col-reverse gap-3">
            {bubbles.versions && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-testid="versions-bubble"
                {...tourTarget("versions")}
                aria-label={t("versions.bubble")}
                aria-pressed={versions.panelOpen}
                onClick={versions.panelOpen ? versions.close : versions.open}
                className={`${BUBBLE} ${BUBBLE_PRESSED}`}
              >
                <History aria-hidden="true" className="h-5 w-5" />
              </Button>
            )}
            {bubbles.comments && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-testid="comments-bubble"
                // The count joins the name without a translated pattern, which keeps the string out of the first bundle; the badge itself is hidden from screen readers.
                aria-label={unread > 0 ? `${commentsLabel} (${unread})` : commentsLabel}
                aria-pressed={comments.panelOpen}
                onClick={() => (comments.panelOpen ? comments.close() : comments.open())}
                className={`relative ${BUBBLE} ${BUBBLE_PRESSED}`}
              >
                <MessageSquare aria-hidden="true" className="h-5 w-5" />
                {unread > 0 && (
                  <span
                    aria-hidden="true"
                    data-testid="comments-unread"
                    className="absolute -right-0.5 -top-0.5 min-w-5 rounded-full bg-brand-deep px-1 text-center text-[11px] font-semibold leading-5 text-brand-fg"
                  >
                    {unread > 9 ? "9+" : unread}
                  </span>
                )}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
