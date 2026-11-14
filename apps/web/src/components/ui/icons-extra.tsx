import type { SVGProps } from "react";
import type { NoteWidth } from "@knotebook/shared";

// 只被 lazy 載入的 UI 使用的圖示（簡報、版本歷史、AI 框、設定、分享對話框、垃圾桶等）。
// 與 icons.tsx 分開：首包 import 的圖示留在 icons.tsx，避免這些圖示被併進首包。

/** 垃圾桶的「還原」（#181，逆時針箭頭）。路徑取自 lucide `rotate-ccw`（ISC），手刻同風格。 */
export function RotateCcw(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="restore" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

/** 移出最愛（最愛 tab 選取模式）。路徑取自 lucide `star-off`（ISC），手刻同風格。 */
export function StarOff(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="star-off" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M8.34 8.34 2 9.27l5 4.87L5.82 21 12 17.77 18.18 21l-.59-3.43" />
      <path d="M18.42 12.76 22 9.27l-6.91-1L12 2l-1.44 2.91" />
      <path d="m2 2 20 20" />
    </svg>
  );
}

/** 私人狀態（分享鈕依分享狀態變化，issue #72 UI 收尾）。 */
export function Lock(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

/** 公開狀態（分享鈕依分享狀態變化，issue #72 UI 收尾）。 */
export function Globe(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

/** 圖表（mermaid block 的 slash 選單項，issue #94）。三個節點＋兩條連線的極簡流程圖意象。 */
export function Diagram(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="9" y="2" width="6" height="5" rx="1" />
      <rect x="2" y="17" width="6" height="5" rx="1" />
      <rect x="16" y="17" width="6" height="5" rx="1" />
      <path d="M12 7v4" />
      <path d="M12 11H5v6" />
      <path d="M12 11h7v6" />
    </svg>
  );
}

/** 進入全螢幕（簡報工具列，#229）。路徑取自 lucide `maximize`（ISC），手刻同風格。 */
export function Maximize(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="maximize" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

/** 離開全螢幕（簡報工具列，#229）。路徑取自 lucide `minimize`（ISC），手刻同風格。 */
export function Minimize(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="minimize" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M8 3v3a2 2 0 0 1-2 2H3" />
      <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
      <path d="M3 16h3a2 2 0 0 1 2 2v3" />
      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

// 版本預覽橫幅的三顆模式鈕：並排＝兩欄、單欄＝框內橫列（與兩欄同框、一眼對照）、只看差異＝篩選。
export function Columns2(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="columns-2" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M12 3v18" />
    </svg>
  );
}

export function Rows3(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="rows-3" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M21 9H3" />
      <path d="M21 15H3" />
    </svg>
  );
}

export function ListFilter(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="list-filter" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 6h18" />
      <path d="M7 12h10" />
      <path d="M10 18h4" />
    </svg>
  );
}

/** 列內「測試連線」（#247）。 */
export function Plug(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="plug" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  );
}

/** 使用者表列內「重設密碼」（#286）。路徑取自 lucide `key-round`（ISC）。 */
export function KeyRound(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="key-round" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  );
}

/** 登入服務列的「圖示」對話框觸發鈕（#247）。名稱避開 DOM 的 `Image` 全域。 */
export function ImageIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="image" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </svg>
  );
}

/** #263 框選 AI 框的送出鈕。路徑取自 lucide `send`（ISC），手刻同風格。 */
export function Send(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="send" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </svg>
  );
}

/** #263 內建 Rewrite 的 chip。路徑取自 lucide `pen-line`（ISC）。 */
export function PenLine(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="pen-line" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 20h9" />
      <path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" />
    </svg>
  );
}

/** #263 內建 Translate 的 chip。路徑取自 lucide `languages`（ISC）。 */
export function Languages(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="languages" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2h1" />
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </svg>
  );
}

/** #263 內建 Summarize 的 chip。路徑取自 lucide `list-collapse`（ISC）。 */
export function ListCollapse(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="list-collapse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m3 10 2.5-2.5L3 5" />
      <path d="m3 19 2.5-2.5L3 14" />
      <path d="M10 6h11" />
      <path d="M10 12h11" />
      <path d="M10 18h11" />
    </svg>
  );
}

/** #263 內建 Continue writing 的 chip。路徑取自 lucide `chevrons-right`（ISC）。 */
export function ChevronsRight(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="chevrons-right" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m6 17 5-5-5-5" />
      <path d="m13 17 5-5-5-5" />
    </svg>
  );
}

/** AI 動作列的「上移」（取代文字箭頭）。路徑取自 lucide `arrow-up`（ISC）。 */
export function ArrowUp(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="arrow-up" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </svg>
  );
}

/** AI 動作列的「下移」。路徑取自 lucide `arrow-down`（ISC）。 */
export function ArrowDown(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="arrow-down" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </svg>
  );
}

/** 寬度 icon 的路徑：標準＝兩端垂直線、無箭頭（|--|）；寬＝朝外箭頭，外側再有兩端垂直線（|<->|）；全寬＝只有朝外箭頭（<->）。 */
const NOTE_WIDTH_PATH: Record<NoteWidth, string> = {
  standard: "M6 8v8M18 8v8M6 12h12",
  wide: "M3 8v8M21 8v8M10 8l-4 4 4 4M6 12h12M14 8l4 4-4 4",
  full: "M7 8l-4 4 4 4M3 12h18M17 8l4 4-4 4",
};

/** #297 頁首寬度 icon：依現值畫三種線形，無外框（見 NOTE_WIDTH_PATH）。 */
export function NoteWidthIcon({ width, ...props }: { width: NoteWidth } & SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon={`note-width-${width}`} aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d={NOTE_WIDTH_PATH[width]} />
    </svg>
  );
}
