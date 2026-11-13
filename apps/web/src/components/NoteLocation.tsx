import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NoteDto } from "@knotebook/shared";
import { useFolders } from "@/api/folders";
import { useGroups } from "@/api/groups";
import { setCollapsed } from "@/components/sidebar/collapse";
import { expandFolderChain, indexFolders } from "@/components/sidebar/folder-index";
import { noteLocationParts } from "@/components/sidebar/tree";
import { useContainerWidth } from "@/lib/use-container-width";
import { useSidebarTabActions } from "@/lib/sidebar-tab";

const ELLIPSIS = "…";
const SEPARATOR = " › ";
const SUFFIX_SEPARATOR = " · ";
/** 清單換頁、資料夾展開後，等那一列真的排進版面的最長影格數（約 0.5 秒）。 */
const SCROLL_MAX_FRAMES = 30;

export interface FitResult {
  shown: string[];
  /** 首尾之外已沒有可省的段，最後一段要用文字截斷（尾端「…」）。 */
  truncateLast: boolean;
}

/**
 * 在 `available` 寬內排路徑：一定留第一與最後一段，中間從中央往外換成單一「…」；
 * 中間都換掉還放不下，就讓最後一段尾端省略。`widths[i]` 含第 i 段前面的分隔符，`ellipsisW` 含它前面的分隔符。
 */
export function fitSegments(segments: readonly string[], widths: readonly number[], available: number, ellipsisW: number): FitResult {
  const n = segments.length;
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (total <= available) return { shown: [...segments], truncateLast: false };
  const middle = Array.from({ length: Math.max(0, n - 2) }, (_, i) => i + 1);
  const center = (n - 1) / 2;
  middle.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
  const hidden = new Set<number>();
  let width = total;
  const build = (truncateLast: boolean): FitResult => {
    const shown: string[] = [];
    segments.forEach((segment, i) => {
      if (!hidden.has(i)) shown.push(segment);
      else if (!hidden.has(i - 1)) shown.push(ELLIPSIS);
    });
    return { shown, truncateLast };
  };
  for (const i of middle) {
    hidden.add(i);
    width = width - (widths[i] ?? 0) + (hidden.size === 1 ? ellipsisW : 0);
    if (width <= available) return build(false);
  }
  return build(true);
}

/** 清單換成這篇筆記所在的 tab 後，把它那一列捲到畫面中央（那一列要等清單可見、資料夾展開才存在）。 */
function scrollRowIntoView(noteId: string): void {
  let frames = 0;
  const tick = () => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(`[data-node-id="${noteId}"]`));
    const row = rows.find((el) => el.getClientRects().length > 0);
    if (row !== undefined) {
      row.scrollIntoView({ block: "center" });
      // 焦點跟著畫面：否則回清單時的焦點還原會落在上一次開啟的那一列。
      row.querySelector<HTMLElement>("a")?.focus({ preventScroll: true });
      return;
    }
    frames += 1;
    if (frames < SCROLL_MAX_FRAMES) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

interface Measure {
  widths: number[];
  ellipsisW: number;
  suffixW: number;
}

/**
 * 手機筆記頁首的位置副標：「我的筆記 › 資料夾 › …」。整行是一顆按鈕，點了回到清單、切到這篇所在的 tab、
 * 展開資料夾鏈並把這一列捲到中央。放不下時留首尾、中間換成「…」。
 */
export function NoteLocation({ note }: { note: NoteDto }) {
  const { t } = useTranslation();
  const foldersQuery = useFolders();
  const groupsQuery = useGroups();
  const { showTab } = useSidebarTabActions();
  const folderIndex = useMemo(() => indexFolders(foldersQuery.data ?? []), [foldersQuery.data]);
  const parts = noteLocationParts(
    note,
    { groupIds: new Set((groupsQuery.data ?? []).map((group) => group.id)), folders: folderIndex },
    (key, options) => t(key, options),
  );
  const fullPath = parts.segments.join(SEPARATOR) + (parts.suffix === null ? "" : `${SUFFIX_SEPARATOR}${parts.suffix}`);

  const wrapRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const available = useContainerWidth(wrapRef);
  const [measure, setMeasure] = useState<Measure | null>(null);
  // 量一份不可見的完整路徑；路徑（語言換了段名也會變）變了才重量。
  useLayoutEffect(() => {
    const root = measureRef.current;
    if (root === null) return;
    const widthOf = (selector: string) => root.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width ?? 0;
    const sepW = widthOf("[data-measure-sep]");
    const segW = Array.from(root.querySelectorAll<HTMLElement>("[data-measure-seg]")).map((el) => el.getBoundingClientRect().width);
    const ellipsisW = widthOf("[data-measure-ellipsis]") + sepW;
    const suffixW = widthOf("[data-measure-suffix]");
    setMeasure({ widths: segW.map((w, i) => (i === 0 ? w : w + sepW)), ellipsisW, suffixW });
  }, [fullPath]);

  const fit =
    measure === null || available === 0
      ? { shown: parts.segments, truncateLast: false }
      : fitSegments(parts.segments, measure.widths, available - measure.suffixW, measure.ellipsisW);

  function handleClick() {
    showTab(parts.tab);
    // 群組區塊收合時那一列不會渲染，先展開群組。
    if (parts.groupId !== null) setCollapsed(`group:${parts.groupId}`, false);
    if (parts.folderId !== null) expandFolderChain(folderIndex, parts.folderId);
    scrollRowIntoView(note.id);
  }

  return (
    <div ref={wrapRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        aria-label={t("note.showInList", { path: fullPath })}
        onClick={handleClick}
        // 標題列 + 這一列合計要 ≥ 44px 的點擊高度，所以用 py 撐高、不用負 margin 壓到標題上。
        className="flex w-full min-w-0 items-center overflow-hidden whitespace-nowrap rounded py-2 text-left text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {fit.shown.map((segment, i) => {
          const last = i === fit.shown.length - 1;
          const truncated = fit.truncateLast && (last || i === 0);
          // 只有一段，或首尾加起來仍放不下時：最後一段吃剩餘寬度，第一段最多佔一半，都以「…」截尾。
          const cls = !truncated ? "shrink-0" : last ? "min-w-0 truncate" : "max-w-[50%] shrink-0 truncate";
          return (
            <Fragment key={`${i}:${segment}`}>
              {i > 0 && (
                <span aria-hidden="true" className="shrink-0 whitespace-pre">
                  {SEPARATOR}
                </span>
              )}
              <span className={cls}>{segment}</span>
            </Fragment>
          );
        })}
        {parts.suffix !== null && (
          <>
            <span aria-hidden="true" className="shrink-0 whitespace-pre">
              {SUFFIX_SEPARATOR}
            </span>
            <span className="shrink-0">{parts.suffix}</span>
          </>
        )}
      </button>
      {/* 量測用的隱藏副本：關在自己的 overflow-hidden 盒子裡，長路徑不會撐大頁首的 scrollWidth。 */}
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <span ref={measureRef} className="invisible absolute start-0 top-0 whitespace-pre text-xs">
          {parts.segments.map((segment, i) => (
            <span key={`${i}:${segment}`} data-measure-seg="">
              {segment}
            </span>
          ))}
          <span data-measure-sep="">{SEPARATOR}</span>
          <span data-measure-ellipsis="">{ELLIPSIS}</span>
          {parts.suffix !== null && <span data-measure-suffix="">{`${SUFFIX_SEPARATOR}${parts.suffix}`}</span>}
        </span>
      </span>
    </div>
  );
}
