import { SAFE_INSETS } from "@/components/ui/safe-area";
import { useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as Y from "yjs";
import type { NoteDto, VersionDto } from "@knotebook/shared";
import { useVersionCurrent, useVersionList, type VersionTarget } from "@/api/versions";
import { NotePanelSwitch, consumeNotePanelSwitch } from "@/components/NotePanelSwitch";
import { Button } from "@/components/ui/button";
import { useVersions } from "@/lib/versions-context";
import { ComparePicker } from "./ComparePicker";
import { VersionPreview } from "./VersionPreview";
import { OnlyChangesToggle } from "./PreviewBanner";
import { EditorAvatars } from "./EditorAvatars";
import { VersionRowContent, VersionRowMenu } from "./VersionsPanel";
import { KindFilter, KindFilterEmpty } from "./KindFilter";
import { currentSubtitle, editorsText, formatVersionTime, versionLabel } from "./version-labels";
import { useApplyFlow } from "./use-apply-flow";

/**
 * Phone (< 640), URL unchanged. Step one = list, step two = preview (the step is whether `preview` is null). Bottom "older/newer version" = the next smaller/larger seq (wording deliberately avoids "previous version", which would clash with the compare target); disabled at the ends (an older page is loaded first when it exists; disabled while loading).
 * No `PreviewBanner` on the full page: step two's second header row holds the compare dropdown pair (`ComparePicker`, left → right) and "only differences" (both read controller state); only side-by-side/single isn't offered (`forceSingle`), so the dropdowns always go on row 2.
 * Focus: a controlled Dialog has no Trigger so Radix doesn't restore focus: `document.activeElement` is recorded on mount and restored by hand on close (as `GroupNameDialog`); if that element is gone (opened from the header ⋮: the menu item unmounts with the menu) fall back to `returnFocusRef` (the ⋮ trigger passed down by NotePage).
 * Step two's second header row wraps (`flex-wrap`): it doesn't fit on one line at 320px.
 * Esc: step two → back to the list, step one → close; both `preventDefault` (NotePage's preview Esc yields on `defaultPrevented`).
 */
export function VersionsSheet({ doc, lastEdited, returnFocusRef }: { doc: Y.Doc; lastEdited: NoteDto["lastEdited"]; returnFocusRef?: RefObject<HTMLElement | null> }) {
  const { t, i18n } = useTranslation();
  const { noteId, preview, kindFilter, startPreview, stopPreview, close, openSave } = useVersions();
  // body doesn't count as a restorable element: treated as not recorded, so close falls back to returnFocusRef (⋮).
  const [returnFocus] = useState(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });
  const id = noteId ?? "";
  const list = useVersionList(id, true, kindFilter);
  const { requestApply } = useApplyFlow(id);
  const rows = list.data?.pages.flatMap((p) => p.versions) ?? [];
  const current = useVersionCurrent(id, list, kindFilter);
  const index = preview ? rows.findIndex((r) => r.id === preview.id) : -1;
  const row: VersionDto | undefined = index >= 0 ? rows[index] : undefined;
  const older = index >= 0 ? rows[index + 1] : undefined;
  const newer = index > 0 ? rows[index - 1] : undefined;
  // Bottom "older/newer version" only changes the left side (as clicking a panel row; the right side stays).
  const go = (v: VersionDto) => startPreview({ seq: v.seq, id: v.id, name: v.name });

  const shut = () => {
    stopPreview();
    close();
  };

  const lastEditedText = (() => {
    if (!lastEdited) return null;
    const handle = lastEdited.byHandle === "" ? t("note.lastEditedDeletedUser") : lastEdited.byHandle;
    const who = lastEdited.agentLabel === null ? handle : `${handle} (${lastEdited.agentLabel})`;
    return t("note.lastEdited", { who, when: new Date(lastEdited.at).toLocaleDateString(i18n.language) });
  })();

  const renderList = () => (
    <>
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button type="button" variant="ghost" size="sm" className="h-11" aria-label={t("versions.sheet.back")} onClick={shut}>
          <span aria-hidden="true">‹</span> {t("versions.sheet.back")}
        </Button>
        <h2 className="text-sm font-semibold">{t("versions.title")}</h2>
      </header>
      <NotePanelSwitch current="versions" />
      <p data-testid="sheet-last-edited" className="px-4 pt-3 text-xs text-muted-foreground">
        {lastEditedText}
      </p>
      <div data-testid="sheet-current" className="mx-4 mt-3 border-b border-dashed border-border pb-2">
        <p className="text-sm font-medium">{t("versions.currentLabel")}</p>
        {current && <p className="text-xs text-muted-foreground">{currentSubtitle(t, current)}</p>}
        {current && !current.autoEnabled && <p className="text-xs text-muted-foreground">{t("versions.autoOff")}</p>}
      </div>
      <KindFilter className="px-4 pt-2" />
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {rows.map((version) => {
          const isBase = current?.baseSeq === version.seq;
          return (
            <li key={version.id} className="flex items-start gap-1">
              <button type="button" onClick={() => go(version)} className="flex min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-accent/60">
                <VersionRowContent version={version} />
              </button>
              <VersionRowMenu version={version} isBase={isBase} onApply={(v) => void requestApply(v)} />
            </li>
          );
        })}
        {kindFilter === "manual" && list.isSuccess && rows.length === 0 && <KindFilterEmpty />}
        {list.hasNextPage && (
          <li>
            <Button type="button" variant="ghost" size="sm" className="w-full" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t("versions.loadMore")}
            </Button>
          </li>
        )}
      </ul>
      <footer data-testid="sheet-footer" className="border-t border-border p-3">
        <Button type="button" variant="outline" className="w-full" disabled={!current || !(current.dirty || current.baseSeq === null)} onClick={() => openSave()}>
          {t("versions.save")}
        </Button>
      </footer>
    </>
  );

  // The header "‹ list · name (short id)" and the apply button use the list row (a rename shows at once); if it isn't in the list, the name recorded at selection.
  const renderPreview = (target: VersionTarget) => {
    const label = versionLabel(row ?? target);
    return (
      <>
        <header className="space-y-1 border-b border-border px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Button type="button" variant="ghost" size="sm" className="h-11 min-w-0 max-w-[60%]" onClick={stopPreview}>
              <span aria-hidden="true">‹</span> <span className="truncate">{t("versions.sheet.backToList")} · {label}</span>
            </Button>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {row && `${formatVersionTime(row.createdAt, i18n.language)} · ${editorsText(t, row.editors)}`}
            </span>
            {row && <EditorAvatars editors={row.editors} />}
          </div>
          <div data-testid="sheet-compare-row" className="flex flex-wrap items-center gap-1 text-xs">
            <ComparePicker side="left" />
            <span aria-hidden="true" className="text-muted-foreground">
              →
            </span>
            <ComparePicker side="right" />
            <OnlyChangesToggle />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <VersionPreview doc={doc} forceSingle />
        </div>
        <footer data-testid="sheet-footer" className="grid grid-cols-3 gap-2 border-t border-border p-3">
          <Button type="button" variant="outline" disabled={older ? false : !list.hasNextPage || list.isFetchingNextPage} onClick={() => (older ? go(older) : void list.fetchNextPage())}>
            {t("versions.sheet.prev")}
          </Button>
          <Button type="button" variant="brandDeep" className="min-w-0" disabled={!row} onClick={() => row && void requestApply(row)}>
            <span className="truncate">{t("versions.applySeq", { label })}</span>
          </Button>
          <Button type="button" variant="outline" disabled={!newer} onClick={() => newer && go(newer)}>
            {t("versions.sheet.next")}
          </Button>
        </footer>
      </>
    );
  };

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && shut()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          className={`fixed inset-0 z-50 flex flex-col bg-card outline-none ${SAFE_INSETS}`}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (consumeNotePanelSwitch()) {
              event.preventDefault();
              return;
            }
            const target = returnFocus?.isConnected ? returnFocus : returnFocusRef?.current;
            if (!target?.isConnected) return;
            event.preventDefault();
            target.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (preview === null) return;
            event.preventDefault();
            stopPreview();
          }}
        >
          <DialogPrimitive.Title className="sr-only">{t("versions.title")}</DialogPrimitive.Title>
          {preview === null ? renderList() : renderPreview(preview)}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
