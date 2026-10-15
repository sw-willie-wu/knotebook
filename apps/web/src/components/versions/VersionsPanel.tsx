import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type * as Y from "yjs";
import type { VersionDto } from "@knotebook/shared";
import { useVersionCurrent, useVersionList, versionsKey } from "@/api/versions";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { PaneResizeHandle } from "@/components/PaneResizeHandle";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EllipsisVertical, X } from "@/components/ui/icons";
import { useVersions } from "@/lib/versions-context";
import { cn } from "@/lib/utils";
import { KindFilter, KindFilterEmpty } from "./KindFilter";
import { baseLabelOrDeleted, currentSubtitle, editorsText, formatVersionTime, versionLabel } from "./version-labels";
import { useApplyFlow } from "./use-apply-flow";
import {
  VERSIONS_PANEL_WIDTH_DEFAULT,
  VERSIONS_PANEL_WIDTH_MAX,
  VERSIONS_PANEL_WIDTH_MIN,
  VERSIONS_PANEL_WIDTH_STEP,
} from "./versions-panel-width";

/**
 * 列的兩行內容（面板與窄視窗整頁共用）。第一行「名稱 (短 id)」（#272 D5；未命名的用 uuid 推出的英文名），**只有自動版本**再加一顆
 * 中性色「自動存檔」pill（#258）；第二行 編輯者 · 時間 · 沿自 …（基底版已刪除時標「(deleted)」，D12）。基底版不在列上標示。
 */
export function VersionRowContent({ version }: { version: VersionDto }) {
  const { t, i18n } = useTranslation();
  const meta = [
    editorsText(t, version.editors),
    formatVersionTime(version.createdAt, i18n.language),
    ...(version.baseSeq !== null ? [t("versions.from", { label: baseLabelOrDeleted(t, version.base) })] : []),
  ].filter((s) => s !== "");
  return (
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
  );
}

/** 每列的 ⋯（面板與整頁共用）：套用、編輯版本名稱、刪除（基底版 disabled＋看得見的說明，起草裁定 9）。 */
export function VersionRowMenu({ version, isBase, onApply }: { version: VersionDto; isBase: boolean; onApply: (v: VersionDto) => void }) {
  const { t } = useTranslation();
  const { openDialog } = useVersions();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="shrink-0" aria-label={t("versions.rowMenu", { label: versionLabel(version) })}>
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
 * 版本面板（spec §8.2，md+ 第三欄卡）。
 * `current` 的刷新：面板開著時訂閱活 `Y.Doc` 的 `update`，去抖動 1 s 後 invalidate `['notes', id, 'versions']`。
 * 離開預覽（spec §8.4 rev 10 追記，Task 19；橫幅沒有 ✕）：點清單空白處（`<ul>` 本身，點到列或 ⋯ 不算）、
 * 再點已選中的那一列（toggle）、✕ 關面板（`close()` 一併離開預覽）；另有 NotePage 的 Esc。
 */
export function VersionsPanel({
  doc,
  width,
  onWidthChange,
}: {
  doc: Y.Doc;
  /** #274：md+ 的面板寬度（狀態在 NoteEditor，與錯誤外框共用；實際寬度走 `--versions-panel-width` CSS 變數，這裡只供把手的 aria-valuenow 與拖曳起點）。 */
  width: number;
  onWidthChange: (px: number, commit: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { noteId, preview, kindFilter, startPreview, stopPreview, close, openSave } = useVersions();
  const id = noteId ?? "";
  const list = useVersionList(id, true, kindFilter);
  const rowsRef = useRef<Array<HTMLButtonElement | null>>([]);
  // 這一發 click 的按下點是否也在 <ul> 本身（review M-1）：在列上按下、拖到列間縫放開時，瀏覽器把 click 派給共同祖先 <ul>，
  // 只看 click 的 target 會誤判成點空白。
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
  // 預覽中的那一版被篩選篩出清單時（#258）仍要能套用它：記住最後一次在清單裡看到的那一列。一律用 `id` 對（不用 seq：
  // 搬移清空歷史後 seq 會重用，同一個 seq 可能是另一版）。換筆記、換版本時 id 對不上就自然不命中；
  // `remembered.id === preview.id` 這一道是承重的：`remembered` 不會自己清，preview 變 null（離開預覽）或換成清單外的版本時，
  // 靠這道比對讓「套用」回到 disabled，否則會套用到上一個預覽的版本。
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
      data-testid="versions-panel"
      aria-label={t("versions.title")}
      className={cn(
        cardSurface,
        "z-30 flex shrink-0 flex-col",
        "fixed inset-x-3 bottom-5 h-[80dvh] max-h-[calc(100dvh-5rem)]",
        "md:relative md:inset-auto md:bottom-auto md:h-auto md:max-h-none md:w-[var(--versions-panel-width)]",
      )}
    >
      {/* 裁切（圓角、內部捲動）在這一層：aside 本身不能 overflow-hidden，否則伸到面板外的把手會被裁掉。 */}
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
        {/* 只認按下與放開都在 <ul> 本身（內距、列間空隙、清單下方空白）；列與 ⋯ 的點擊冒泡上來時 target 不是 <ul>，不算。
            滑鼠專用的捷徑，不給鍵盤焦點（鍵盤離開預覽用 Esc 或再按一次選中列）。 */}
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
                  // 已選中的列再點一次＝離開預覽（toggle）；↑↓ 走 onRowKey，不受影響。
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
      {/* #274：把手與側欄同形，`absolute right-full w-3` 伸進內文卡與面板之間的 `gap-3`（約略蓋在間隙上，以 padding box 定位、壓住面板左框一個框寬，與側欄對稱）；窄螢幕的底部卡片不顯示。
          放在最後一個子元素：Tab 順序不會以它為面板第一個停點。 */}
      <PaneResizeHandle
        width={width}
        onChange={onWidthChange}
        min={VERSIONS_PANEL_WIDTH_MIN}
        max={VERSIONS_PANEL_WIDTH_MAX}
        defaultWidth={VERSIONS_PANEL_WIDTH_DEFAULT}
        step={VERSIONS_PANEL_WIDTH_STEP}
        edge="left"
        label={t("versions.resize")}
        placementClassName="right-full max-md:hidden"
      />
    </aside>
  );
}
