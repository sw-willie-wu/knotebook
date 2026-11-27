import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type * as Y from "yjs";
import type { VersionDto } from "@knotebook/shared";
import { useVersionCurrent, useVersionList, versionsKey } from "@/api/versions";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { PaneResizeHandle } from "@/components/PaneResizeHandle";
import { focusCornerBubble, focusFromCorner } from "@/components/corner-stack-state";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EllipsisVertical, X } from "@/components/ui/icons";
import { useIsOverlay } from "@/lib/layout-tiers";
import { useVersions } from "@/lib/versions-context";
import { cn } from "@/lib/utils";
import { EditorAvatars } from "./EditorAvatars";
import { KindFilter, KindFilterEmpty } from "./KindFilter";
import { baseLabelOrDeleted, currentSubtitle, editorsText, formatVersionTime, versionLabel } from "./version-labels";
import { useApplyFlow } from "./use-apply-flow";
import {
  VERSIONS_PANEL_PLACEMENT,
  VERSIONS_PANEL_WIDTH_DEFAULT,
  VERSIONS_PANEL_WIDTH_MAX,
  VERSIONS_PANEL_WIDTH_MIN,
  VERSIONS_PANEL_WIDTH_STEP,
} from "./versions-panel-width";

export function VersionRowContent({ version }: { version: VersionDto }) {
  const { t, i18n } = useTranslation();
  const meta = [
    editorsText(t, version.editors),
    formatVersionTime(version.createdAt, i18n.language),
    ...(version.baseSeq !== null ? [t("versions.from", { label: baseLabelOrDeleted(t, version.base) })] : []),
  ].filter((s) => s !== "");
  return (
    <span className="flex min-w-0 flex-1 items-start gap-2">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm">
          <span className="min-w-0 truncate font-medium">{versionLabel(version)}</span>
          {version.kind === "auto" && (
            <span data-testid="auto-badge" className="shrink-0 rounded-full border border-border bg-muted px-1.5 text-[11px] leading-4 text-foreground/70">
              {t("versions.autoBadge")}
            </span>
          )}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{meta.join(" · ")}</span>
      </span>
      <EditorAvatars editors={version.editors} />
    </span>
  );
}

export function VersionRowMenu({ version, isBase, onApply }: { version: VersionDto; isBase: boolean; onApply: (v: VersionDto) => void }) {
  const { t } = useTranslation();
  const { openDialog } = useVersions();
  return (
    <DropdownMenu phoneSheet>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="shrink-0" aria-label={t("versions.rowMenu", { label: versionLabel(version) })}>
          <EllipsisVertical aria-hidden="true" className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sheetTitle={versionLabel(version)}>
        <DropdownMenuItem onSelect={() => onApply(version)}>{t("versions.menu.apply")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDialog({ kind: "rename", version })}>{t("versions.menu.rename")}</DropdownMenuItem>
        <DropdownMenuItem disabled={isBase} className="flex-col items-start justify-center" onSelect={() => openDialog({ kind: "delete", version })}>
          <span>{t("versions.menu.delete")}</span>
          {isBase && <span className="text-xs text-muted-foreground">{t("versions.menu.baseNotDeletable")}</span>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** `current` refresh: while open it subscribes to the live Y.Doc `update` and invalidates `['notes', id, 'versions']` after a 1 s debounce. Leaving preview (the banner has no ✕): click blank list space (the `<ul>` itself, not rows or ⋯), click the selected row again (toggle), ✕ closes the panel (`close()` leaves preview too); plus NotePage's Esc. */
export function VersionsPanel({
  doc,
  width,
  onWidthChange,
}: {
  doc: Y.Doc;
  /** State lives in NoteEditor (shared with the error frame); the real width goes through `--versions-panel-width`: this is only for the handle's aria-valuenow and drag start. */
  width: number;
  onWidthChange: (px: number, commit: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { noteId, preview, kindFilter, startPreview, stopPreview, close: closeVersions, openSave } = useVersions();
  // The ✕ goes away with the panel; its focus goes to the bubble, as with Esc.
  const close = () => {
    closeVersions();
    requestAnimationFrame(() => focusCornerBubble("versions-bubble"));
  };
  const id = noteId ?? "";
  const list = useVersionList(id, true, kindFilter);
  const rowsRef = useRef<Array<HTMLButtonElement | null>>([]);
  // The floating segment's real width can be clamped by CSS to card width − 3rem (smaller than the setting in narrow windows): report the real width for aria-valuenow and drag start.
  const asideRef = useRef<HTMLElement>(null);
  const [renderedWidth, setRenderedWidth] = useState(0);
  useEffect(() => {
    const el = asideRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setRenderedWidth(Math.round(el.getBoundingClientRect().width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Same rule as the comments panel; the list has nothing to type in, so the panel itself takes focus.
  useEffect(() => {
    if (focusFromCorner()) asideRef.current?.focus({ preventScroll: true });
  }, []);
  // The fixed segment is never clamped: use the setting directly (the measured value lags one frame and gives a stale width on key repeat).
  const overlay = useIsOverlay();
  const shownWidth = overlay && renderedWidth > 0 ? Math.min(width, renderedWidth) : width;
  // When the floating segment is clamped narrow, the handle counts from the real width: moving wider but not past the setting writes nothing, or the setting would be lowered.
  const handleWidthChange = (px: number, commit: boolean) => {
    if (px >= shownWidth && px < width) return; // only the floating segment can have shownWidth < width
    onWidthChange(px, commit);
  };
  // Whether this click's press also started on the <ul> itself: pressing on a row and releasing in the gap between rows makes the browser dispatch the click to the common ancestor <ul>, which looking only at the click target would misread as a blank-space click.
  const pressedOnListRef = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: versionsKey(id) }), 1000);
    };
    doc.on("update", onUpdate);
    return () => {
      doc.off("update", onUpdate);
      clearTimeout(timer);
    };
  }, [doc, id, queryClient]);

  const versions = list.data?.pages.flatMap((p) => p.versions) ?? [];
  const current = useVersionCurrent(id, list, kindFilter);
  // A previewed version that the filter (#258) removed from the list must still be applicable: remember the last row seen in the list. Matched by `id` (not seq: seq is reused after a move clears history).
  // The `remembered.id === preview.id` check is load-bearing: `remembered` never clears itself, and this comparison returns Apply to disabled when preview becomes null or a version outside the list, instead of applying the previous preview's version.
  const inList = versions.find((v) => v.id === preview?.id) ?? null;
  const [remembered, setRemembered] = useState<VersionDto | null>(null);
  if (inList !== null && inList !== remembered) setRemembered(inList);
  const selected = inList ?? (remembered !== null && remembered.id === preview?.id ? remembered : null);
  const { requestApply } = useApplyFlow(id);
  const apply = (v: VersionDto) => void requestApply(v);

  const onRowKey = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : null;
    if (next === null || next < 0 || next >= versions.length) return;
    event.preventDefault();
    rowsRef.current[next]?.focus();
    startPreview({ seq: versions[next].seq, id: versions[next].id, name: versions[next].name });
  };

  return (
    <aside
      ref={asideRef}
      data-testid="versions-panel"
      aria-label={t("versions.title")}
      tabIndex={-1}
      className={cn(
        cardSurface,
        "flex shrink-0 flex-col outline-none",
        VERSIONS_PANEL_PLACEMENT,
      )}
    >
      {/* Clipping (rounding, inner scroll) lives here: the aside itself can't be overflow-hidden or the handle sticking out would be clipped */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
        <div className="flex items-center justify-between px-3 pt-3">
          <h2 className="text-sm font-semibold">{t("versions.title")}</h2>
          <button type="button" aria-label={t("versions.close")} onClick={close} className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div data-testid="versions-current" className="mx-3 mt-3 border-b border-dashed border-border pb-2">
          <p className="text-sm font-medium">{t("versions.currentLabel")}</p>
          {current && <p className="text-xs text-muted-foreground">{currentSubtitle(t, current)}</p>}
          {current && !current.autoEnabled && <p className="text-xs text-muted-foreground">{t("versions.autoOff")}</p>}
        </div>
        <KindFilter className="px-3 pt-2" />
        {/* Only a press and release both on the <ul> itself count (padding, row gaps, blank space below); clicks bubbling from rows and ⋯ have another target.
            Mouse-only shortcut, no keyboard focus (the keyboard leaves preview with Esc or by re-pressing the selected row). */}
        <ul
          className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2"
          onPointerDown={(event) => {
            pressedOnListRef.current = event.target === event.currentTarget;
          }}
          onClick={(event) => {
            const pressedOnList = pressedOnListRef.current;
            pressedOnListRef.current = false;
            if (pressedOnList && event.target === event.currentTarget) stopPreview();
          }}
        >
          {versions.map((version, index) => {
            const isBase = current?.baseSeq === version.seq;
            return (
              <li key={version.id} className="flex items-start gap-1">
                <button
                  ref={(el) => {
                    rowsRef.current[index] = el;
                  }}
                  type="button"
                  // Clicking the selected row again leaves preview (toggle); ↑↓ go through onRowKey, unaffected.
                  onClick={() => (preview?.id === version.id ? stopPreview() : startPreview({ seq: version.seq, id: version.id, name: version.name }))}
                  onKeyDown={onRowKey(index)}
                  className={cn("flex min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-accent/60", preview?.id === version.id && "bg-accent")}
                >
                  <VersionRowContent version={version} />
                </button>
                <VersionRowMenu version={version} isBase={isBase} onApply={apply} />
              </li>
            );
          })}
          {kindFilter === "manual" && list.isSuccess && versions.length === 0 && <KindFilterEmpty />}
          {list.hasNextPage && (
            <li>
              <Button type="button" variant="ghost" size="sm" className="w-full" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t("versions.loadMore")}
              </Button>
            </li>
          )}
        </ul>
        <div data-testid="versions-footer" className="flex justify-end gap-2 border-t border-border p-3">
          <Button type="button" variant="outline" size="sm" disabled={!current || !(current.dirty || current.baseSeq === null)} onClick={() => openSave()}>
            {t("versions.save")}
          </Button>
          <Button type="button" variant="brandDeep" size="sm" className="min-w-0" disabled={selected === null} onClick={() => selected && apply(selected)}>
            <span className="truncate">{selected ? t("versions.applySeq", { label: versionLabel(selected) }) : t("versions.applyNone")}</span>
          </Button>
        </div>
      </div>
      {/* Resize handle shaped like the sidebar's: `absolute right-full w-3` reaches into the `gap-3` between note card and panel (positioned by padding box, covering one border width of the panel's left edge, symmetric with the sidebar); present in both the floating and the 1280+ third-column layouts.
          Last child so Tab order doesn't make it the panel's first stop. */}
      <PaneResizeHandle
        width={shownWidth}
        onChange={handleWidthChange}
        min={VERSIONS_PANEL_WIDTH_MIN}
        max={VERSIONS_PANEL_WIDTH_MAX}
        defaultWidth={VERSIONS_PANEL_WIDTH_DEFAULT}
        step={VERSIONS_PANEL_WIDTH_STEP}
        edge="left"
        label={t("versions.resize")}
        placementClassName="right-full"
      />
    </aside>
  );
}
