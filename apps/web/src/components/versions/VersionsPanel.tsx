import { useEffect, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type * as Y from "yjs";
import type { VersionDto } from "@knotebook/shared";
import { useVersionList, versionsKey } from "@/api/versions";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EllipsisVertical, X } from "@/components/ui/icons";
import { useVersions } from "@/lib/versions-context";
import { cn } from "@/lib/utils";
import { BASE_DOT_COLOR, currentSubtitle, editorsText, formatVersionTime } from "./version-labels";

/** 列的兩行內容（面板與窄視窗整頁共用）。 */
export function VersionRowContent({ version, isBase }: { version: VersionDto; isBase: boolean }) {
  const { t, i18n } = useTranslation();
  const meta = [
    version.kind === "manual" ? t("versions.kind.manual") : t("versions.kind.auto"),
    editorsText(t, version.editors),
    formatVersionTime(version.createdAt, i18n.language),
    ...(version.baseSeq !== null ? [t("versions.from", { seq: version.baseSeq })] : []),
  ].filter((s) => s !== "");
  return (
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-1.5 text-sm">
        {isBase && (
          <span data-testid="base-dot" aria-hidden="true" title={t("versions.baseDot")} className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: BASE_DOT_COLOR }} />
        )}
        <span className="font-medium">v{version.seq}</span>
        {isBase && <span className="sr-only">{t("versions.baseDot")}</span>}
        {version.name !== null && <span className="min-w-0 truncate">{version.name}</span>}
      </span>
      <span className="block truncate text-xs text-muted-foreground">{meta.join(" · ")}</span>
    </span>
  );
}

/** 每列的 ⋯（面板與整頁共用）：套用、編輯版本名稱、刪除（基底版 disabled＋看得見的說明，起草裁定 9）。 */
export function VersionRowMenu({ version, isBase, onApply }: { version: VersionDto; isBase: boolean; onApply: (v: VersionDto) => void }) {
  const { t } = useTranslation();
  const { openDialog } = useVersions();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="shrink-0" aria-label={t("versions.rowMenu", { seq: version.seq })}>
          <EllipsisVertical aria-hidden="true" className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onApply(version)}>{t("versions.menu.apply")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDialog({ kind: "rename", version })}>{t("versions.menu.rename")}</DropdownMenuItem>
        <DropdownMenuItem disabled={isBase} className="flex-col items-start" onSelect={() => openDialog({ kind: "delete", version })}>
          <span>{t("versions.menu.delete")}</span>
          {isBase && <span className="text-xs text-muted-foreground">{t("versions.menu.baseNotDeletable")}</span>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 版本面板（spec §8.2，md+ 第三欄卡）。與 AI 面板同位置同規則、互斥（橋接在 CornerStack）。
 * `current` 的刷新：面板開著時訂閱活 `Y.Doc` 的 `update`，去抖動 1 s 後 invalidate `['notes', id, 'versions']`。
 */
export function VersionsPanel({ doc }: { doc: Y.Doc }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { noteId, preview, startPreview, close, openSave, openDialog } = useVersions();
  const id = noteId ?? "";
  const list = useVersionList(id, true);
  const rowsRef = useRef<Array<HTMLButtonElement | null>>([]);

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
  const current = list.data?.pages[0]?.current;
  const latestSeq = versions[0]?.seq ?? null;
  const selected = versions.find((v) => v.seq === preview?.seq) ?? null;
  // Task 9 換成 useApplyFlow().requestApply
  const apply = (v: VersionDto) => openDialog({ kind: "apply", version: v });

  const onRowKey = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : null;
    if (next === null || next < 0 || next >= versions.length) return;
    event.preventDefault();
    rowsRef.current[next]?.focus();
    startPreview({ seq: versions[next].seq, id: versions[next].id });
  };

  return (
    <aside
      data-testid="versions-panel"
      aria-label={t("versions.title")}
      className={cn(
        cardSurface,
        "z-30 flex shrink-0 flex-col overflow-hidden",
        "fixed inset-x-3 bottom-5 h-[80dvh] max-h-[calc(100dvh-5rem)]",
        "md:static md:inset-auto md:bottom-auto md:h-auto md:max-h-none md:w-80",
      )}
    >
      <div className="flex items-center justify-between px-3 pt-3">
        <h2 className="text-sm font-semibold">{t("versions.title")}</h2>
        <button type="button" aria-label={t("versions.close")} onClick={close} className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div data-testid="versions-current" className="mx-3 mt-3 border-b border-dashed border-border pb-2">
        <p className="text-sm font-medium">{t("versions.currentLabel")}</p>
        {current && <p className="text-xs text-muted-foreground">{currentSubtitle(t, current, latestSeq)}</p>}
        {current && !current.autoEnabled && <p className="text-xs text-muted-foreground">{t("versions.autoOff")}</p>}
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {versions.map((version, index) => {
          const isBase = current?.baseSeq === version.seq;
          return (
            <li key={version.id} className="flex items-start gap-1">
              <button
                ref={(el) => {
                  rowsRef.current[index] = el;
                }}
                type="button"
                onClick={() => startPreview({ seq: version.seq, id: version.id })}
                onKeyDown={onRowKey(index)}
                className={cn("flex min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-accent/60", preview?.seq === version.seq && "bg-accent")}
              >
                <VersionRowContent version={version} isBase={isBase} />
              </button>
              <VersionRowMenu version={version} isBase={isBase} onApply={apply} />
            </li>
          );
        })}
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
        <Button type="button" variant="brandDeep" size="sm" disabled={selected === null} onClick={() => selected && apply(selected)}>
          {selected ? t("versions.applySeq", { seq: selected.seq }) : t("versions.applyNone")}
        </Button>
      </div>
    </aside>
  );
}
