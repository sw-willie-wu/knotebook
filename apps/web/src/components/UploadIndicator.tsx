import { lazy, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ICON_28_HIT } from "@/components/ui/hit-area";
import { SIDEBAR_PANEL_ANCHOR_ATTR } from "@/components/ui/panel-shell";
import { SidebarPanelLazyBoundary } from "@/components/ui/sidebar-panel-lazy-boundary";
import { useIsPhone } from "@/lib/layout-tiers";
import { cn } from "@/lib/utils";
import { uploadQueueSummary, useUploadQueue } from "@/uploads/upload-queue-store";

// The list, its strings and the runner's retry load only when the pill is first opened (`UploadsLazy` is the one entry point).
const UploadsPanel = lazy(() => import("@/components/uploads/UploadsLazy").then((m) => ({ default: m.UploadsPanel })));

const RING = 2 * Math.PI * 6;

/** Must match the attribute UploadsPanel puts on its popover and sheet. */
const UPLOADS_PANEL_SELECTOR = '[data-panel="uploads"]';

/** The bell beside the pill, else the account menu's trigger in the sidebar row. */
function neighbourOf(pill: HTMLElement | null): HTMLElement | null {
  const next = pill?.nextElementSibling;
  if (next instanceof HTMLElement) return next;
  return pill?.closest(`[${SIDEBAR_PANEL_ANCHOR_ATTR}]`)?.querySelector("button") ?? null;
}

/** Its own button beside the bell, never inside the user menu's trigger (a button in a button). */
export function UploadIndicator({ placement }: { placement: "sidebar" | "topBar" }) {
  const { t } = useTranslation();
  const items = useUploadQueue();
  const phone = useIsPhone();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const handoffRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    // Cleared on every run, so a target from a render that never committed can't be used later.
    const target = handoffRef.current;
    handoffRef.current = null;
    if (items.length === 0) target?.focus();
  }, [items.length]);
  if (items.length === 0) {
    // The pill and its panel disappear together (the last item closed or written), taking focus with them; it is
    // read here because after the commit only <body> is left. An open panel still loading or showing its error card
    // holds no focus, so only focus that is really on the pill or in the panel moves.
    const focused = document.activeElement;
    const ours = buttonRef.current !== null && focused !== null && (focused === buttonRef.current || focused.closest(UPLOADS_PANEL_SELECTOR) !== null);
    handoffRef.current = ours ? neighbourOf(buttonRef.current) : null;
    // Otherwise the next upload would reopen a list nobody asked for.
    if (open) setOpen(false);
    return null;
  }

  const { active, percent } = uploadQueueSummary(items);
  const attention = items.length - active;
  const activeLabel = t("uploadIndicator.active", { count: active, percent });
  const attentionLabel = t("uploadIndicator.attention", { count: attention });
  const label = active === 0 ? attentionLabel : attention === 0 ? activeLabel : t("uploadIndicator.both", { active: activeLabel, attention: attentionLabel });
  const shown = active === 0 ? 100 : (percent ?? 0);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-upload-indicator=""
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn("relative flex shrink-0 items-center rounded-full", placement === "topBar" ? "h-11 px-1" : cn("h-7", ICON_28_HIT))}
      >
        <span
          aria-hidden="true"
          className={cn(
            "relative flex h-6 items-center gap-1.5 rounded-full pl-1.5 pr-2 text-xs tabular-nums",
            active > 0 ? "bg-brand-soft text-brand-on-soft hover:bg-brand-soft-strong" : "bg-destructive/10 text-destructive hover:bg-destructive/15",
          )}
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4 -rotate-90">
            <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2.5" className="stroke-current opacity-25" />
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              strokeWidth="2.5"
              strokeDasharray={RING}
              strokeDashoffset={RING * (1 - shown / 100)}
              className={active > 0 ? "stroke-brand" : "stroke-current"}
            />
          </svg>
          {active === 0 ? attention : placement === "topBar" ? active : `${active} · ${percent}%`}
          {active > 0 && attention > 0 && <span data-upload-attention-dot="" className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-destructive" />}
        </span>
      </button>
      {open && (
        <SidebarPanelLazyBoundary chunk="uploads">
          <UploadsPanel anchorRef={buttonRef} phone={phone} onClose={() => setOpen(false)} />
        </SidebarPanelLazyBoundary>
      )}
    </>
  );
}
