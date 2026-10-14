import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * 可調寬窗格的拖曳把手（`role="separator"`），側欄（`AppShell`）與版本面板（`VersionsPanel`）共用。
 *
 * - `edge`：把手在窗格的哪一緣。`"right"`（側欄）＝往右拖變寬；`"left"`（版本面板）＝往左拖變寬。
 *   鍵盤隨方向：往「外」的方向鍵變寬（right 緣 → ArrowRight 變寬；left 緣 → ArrowLeft 變寬），Home／End 到下／上限。
 * - `placementClassName`：把手相對窗格的定位 class（側欄 `left-full`、版本面板 `left-0 max-md:hidden`）——
 *   由呼叫端以**完整字面**給（Tailwind 靜態掃描）。把手自身只帶 `absolute inset-y-0 w-3` 等共用部分。
 * - 拖曳（pointer capture）、雙擊回預設；只在「提交」（放開、鍵盤、雙擊）時 `onChange(px, true)`，拖曳途中 `onChange(px, false)`。
 */
export function PaneResizeHandle({
  width,
  onChange,
  min,
  max,
  defaultWidth,
  step,
  edge,
  label,
  placementClassName,
}: {
  width: number;
  onChange: (px: number, commit: boolean) => void;
  min: number;
  max: number;
  defaultWidth: number;
  step: number;
  edge: "left" | "right";
  label: string;
  placementClassName: string;
}) {
  // `latest`：拖曳中最後一次算出的寬度。放開時寫入 localStorage 用它，不用 render 閉包裡的 `width`——
  // 真瀏覽器裡 pointermove（連續事件）的 state 更新不保證在 pointerup（離散事件）handler 之前 commit，
  // 讀 `width` 可能存到上一格（gate r1 M1）。未在瀏覽器量過；jsdom 的 fireEvent 每發都包 act，
  // 兩種寫法在 jsdom 下行為相同、單元測試分不出來（突變 A7 實跑全綠），只能靠手動清單驗。
  const dragRef = useRef<{ startX: number; startWidth: number; latest: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // 往外拖＝變寬：right 緣 +dx、left 緣 −dx。
  const sign = edge === "right" ? 1 : -1;
  const clamp = (px: number) => Math.min(max, Math.max(min, Math.round(px)));

  // 拖曳中鎖 body：游標在把手外也維持 col-resize、不選到文字。cleanup 還原舊值。
  useEffect(() => {
    if (!dragging) return;
    const { style } = document.body;
    const previous = { cursor: style.cursor, userSelect: style.userSelect };
    style.cursor = "col-resize";
    style.userSelect = "none";
    return () => {
      style.cursor = previous.cursor;
      style.userSelect = previous.userSelect;
    };
  }, [dragging]);

  function endDrag(): void {
    const drag = dragRef.current;
    if (!drag) return; // pointerup 之後還會來一發 lostpointercapture
    dragRef.current = null;
    setDragging(false);
    onChange(drag.latest, true);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-dragging={dragging ? "" : undefined}
      className={cn("group/resize absolute inset-y-0 flex w-3 cursor-col-resize touch-none select-none justify-center outline-none", placementClassName)}
      // 不在 pointerdown `preventDefault`：它會壓掉相容的 mouse 事件，雙擊是否照發沒驗過。
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { startX: event.clientX, startWidth: width, latest: width };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        drag.latest = clamp(drag.startWidth + sign * (event.clientX - drag.startX));
        onChange(drag.latest, false);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => onChange(defaultWidth, true)}
      onKeyDown={(event) => {
        const next = {
          ArrowLeft: width - sign * step,
          ArrowRight: width + sign * step,
          Home: min,
          End: max,
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        onChange(clamp(next), true);
      }}
    >
      {/* 視覺（Willie 2026-09-30 裁決）：平常透明（側欄：就是頁底色的那條間距；版本面板：卡片底色）；hover **只換游標**
          （col-resize）、不畫線；拖曳中與鍵盤聚焦才出現 ring 色的線。class 必須以完整字面出現
          （Tailwind 靜態掃描），不得樣板化。 */}
      <div
        aria-hidden="true"
        className="h-full w-0.5 rounded-full transition-colors group-focus-visible/resize:bg-ring group-data-[dragging]/resize:bg-ring"
      />
    </div>
  );
}
