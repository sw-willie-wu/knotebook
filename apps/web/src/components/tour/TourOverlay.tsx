import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import "@/i18n/tour-strings";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { X } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { arrowPath, HOLE_RADIUS, padRect, placeCard, type Rect, type Size } from "./geometry";

export interface TourOverlayProps {
  /** 目標在視窗座標的矩形（多個目標先用 `unionRect` 合成）；null＝不挖洞、卡片置中。呼叫端每一格畫面重新量。 */
  target: Rect | null;
  /** 第幾站，從 1 起算。 */
  step: number;
  total: number;
  title: string;
  body: string;
  /** 演示站：焦點留在編輯器（不搶），卡片讀出換站與結束的按鍵。 */
  live?: boolean;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onClose: () => void;
  onKeep: () => void;
  onDelete: () => void;
}

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}
const viewportWidth = () => window.innerWidth;
const viewportHeight = () => window.innerHeight;

/** `useId` 的字元不一定能直接放進 `url(#…)`，只留英數。 */
function svgId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^a-zA-Z0-9]/g, "")}`;
}

/**
 * 功能導覽的遮罩與說明卡（只負責畫面與按鍵；換站、找目標、結束後的還原由呼叫端處理）。
 *
 * - 卡片是 `aria-modal="false"` 的 dialog，不用 Radix 的 modal Dialog：modal 會把頁面其他部分標成 `aria-hidden`／`inert`，
 *   要指的目標就查不到了，報讀器也讀不到被挖亮的東西。焦點與 Tab 迴圈自己管。
 * - 遮罩蓋滿整個畫面、擋掉頁面的滑鼠操作，只有卡片可按。
 * - `pointerdown` 在 window 的 capture 階段攔：BlockNote 的選單用 floating-ui 的 `useDismiss` 在 document 的 capture 階段聽
 *   `pointerdown`，「點到外面」就關選單，而且不看 `defaultPrevented`；元素上的處理輪不到，只有比 document 更早的 window
 *   capture 擋得住。`preventDefault` 讓焦點留在原處（演示站的編輯器）。因此卡片上的 React `onPointerDown` 收不到事件，
 *   按鈕動作一律掛 `onClick`（`click` 照常觸發）。
 * - Esc 也在 window capture 接走：焦點在編輯器時 BlockNote 會自己用 Esc 關選單，導覽要先拿到。
 * - 挖洞、外框、箭頭、卡片都不做過渡，換站與目標移動時一起跳到新位置：只讓挖洞做過渡的話，那段時間箭頭尖端會離開外框；
 *   呼叫端每格畫面重量目標（例如捲動中），有過渡的挖洞也會落後目標。沒有動畫也就不必另外處理 `prefers-reduced-motion`。
 * - 卡片的名稱與描述在換站時是原地換掉的（焦點常常一直停在同一顆「下一步」上），報讀器不會重讀；
 *   所以另有一個常駐的 polite live region，換站時填入「n / N、標題、說明」。掛上那一次不填：焦點會進卡片，dialog 本身就會被讀出。
 */
export function TourOverlay({ target, step, total, title, body, live = false, onNext, onBack, onSkip, onClose, onKeep, onDelete }: TourOverlayProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const reactId = useId();
  const titleId = `${reactId}-title`;
  const bodyId = `${reactId}-body`;
  const questionId = `${reactId}-question`;
  const maskId = svgId("kb-tour-mask", reactId);
  const markerId = svgId("kb-tour-arrow", reactId);

  const isFirst = step === 1;
  const isLast = step === total;

  // 換過站才報（見檔頭）；在 render 中比對上一個 step，不必多等一輪 effect。
  const [prevStep, setPrevStep] = useState(step);
  const [stepChanged, setStepChanged] = useState(false);
  if (step !== prevStep) {
    setPrevStep(step);
    setStepChanged(true);
  }
  const progress = t("tourGuide.progress", { n: step, total });
  // 標題已經以標點結尾（例如「忘了怎麼用？」）就不再補句點，免得報讀成「？。」；標點後面跟著收尾的引號、括號也算。
  const titleStop = /[.!?。．！？…⋯]["'”’」』）)]*$/u.test(title.trimEnd()) ? "" : t("tourGuide.titleStop");
  const announcement = stepChanged ? t("tourGuide.stepAnnouncement", { progress, title, titleStop, body }) : "";

  const viewport: Size = {
    width: useSyncExternalStore(subscribeResize, viewportWidth),
    height: useSyncExternalStore(subscribeResize, viewportHeight),
  };

  // 卡片尺寸要等畫出來才量得到：掛上時在 layout effect 先量一次（畫面上不會先閃一格錯的位置），
  // 之後換站、換語言、視窗變窄讓卡片變大變小，由 ResizeObserver 通知再量。
  const [cardSize, setCardSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (el === null) return;
    const measure = () => {
      const next = { width: el.offsetWidth, height: el.offsetHeight };
      setCardSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const hole = target === null ? null : padRect(target);
  const placement = placeCard(hole, cardSize, viewport);
  const arrow =
    hole === null ? null : arrowPath(hole, { left: placement.left, top: placement.top, ...cardSize }, placement.placement);

  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    // 輸入法組字中的 Esc 是取消組字，交給輸入法（Chromium 組字中的 keydown 是 keyCode 229）。
    if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    // 演示站的焦點在編輯器，Tab 怎麼處理由演示站決定；這裡只管卡片內的迴圈。
    if (e.key !== "Tab" || live) return;
    const items = Array.from(cardRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      at === -1 ? items[e.shiftKey ? items.length - 1 : 0]! : items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length]!;
    next.focus();
  });

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && e.target instanceof Node && root.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => handleKeyDown(e);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  // 一般站一進站就把焦點放在主要動作（最後一站是〔保留示範筆記〕，不是〔刪除〕）；演示站焦點要留在編輯器，選單才不會關。
  useEffect(() => {
    if (!live) primaryRef.current?.focus();
  }, [step, total, live]);

  // z-[95]：要高於編輯器浮層（BlockNote 最高 90），低於 toast（100）。
  return createPortal(
    <div ref={rootRef} data-tour-overlay="" className="fixed inset-0 z-[95]">
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full forced-color-adjust-none">
        <defs>
          <mask id={maskId}>
            <rect width="100%" height="100%" fill="white" />
            {hole && (
              <rect
                data-tour-hole=""
                x={hole.left}
                y={hole.top}
                width={hole.width}
                height={hole.height}
                rx={HOLE_RADIUS}
                fill="black"
              />
            )}
          </mask>
          <marker id={markerId} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-brand forced-colors:fill-[Highlight]" />
          </marker>
        </defs>
        <rect width="100%" height="100%" mask={`url(#${maskId})`} className="fill-black/50" />
        {hole && (
          <>
            {/* 高對比模式下暗色遮罩與挖洞的交界看不出來，外面多畫一圈系統文字色。 */}
            <rect
              data-tour-ring-contrast=""
              x={hole.left - 2}
              y={hole.top - 2}
              width={hole.width + 4}
              height={hole.height + 4}
              rx={HOLE_RADIUS + 2}
              fill="none"
              strokeWidth={2}
              className="hidden forced-colors:inline forced-colors:stroke-[CanvasText]"
            />
            <rect
              data-tour-ring=""
              x={hole.left}
              y={hole.top}
              width={hole.width}
              height={hole.height}
              rx={HOLE_RADIUS}
              fill="none"
              strokeWidth={2}
              className="stroke-brand forced-colors:stroke-[Highlight]"
            />
          </>
        )}
        {arrow && (
          <path
            data-tour-arrow=""
            d={arrow.d}
            fill="none"
            strokeWidth={2}
            markerEnd={`url(#${markerId})`}
            className="stroke-brand forced-colors:stroke-[Highlight]"
          />
        )}
      </svg>
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-tour-card=""
        tabIndex={-1}
        style={{ left: placement.left, top: placement.top }}
        className={cn(
          cardSurface,
          "fixed w-80 max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-y-auto p-4 shadow-lg outline-none",
        )}
      >
        <h2 id={titleId} className="pr-8 text-sm font-semibold">
          {title}
        </h2>
        <p id={bodyId} className="mt-2 text-sm text-muted-foreground">
          {body}
        </p>
        {isLast && (
          <p id={questionId} className="mt-2 text-sm">
            {t("tourGuide.keepOrDeleteSample")}
          </p>
        )}
        {/* 一般站也先掛著空的 live region：換到演示站時才填字，報讀器才讀得出來。 */}
        <p aria-live="polite" className={live ? "mt-2 text-xs text-muted-foreground" : undefined}>
          {live ? t("tourGuide.liveHint") : null}
        </p>
        <p data-tour-step-announcement="" aria-live="polite" className="sr-only">
          {announcement}
        </p>
        <div className="mt-4 flex items-center gap-2">
          <span className="mr-auto text-xs text-muted-foreground">{progress}</span>
          {isFirst && !isLast && (
            <Button type="button" variant="outline" onClick={onSkip}>
              {t("tourGuide.skip")}
            </Button>
          )}
          {!isFirst && (
            <Button type="button" variant="outline" onClick={onBack}>
              {t("tourGuide.back")}
            </Button>
          )}
          {isLast ? (
            <>
              <Button ref={primaryRef} type="button" variant="brandDeep" aria-describedby={questionId} onClick={onKeep}>
                {t("tourGuide.keepSample")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                aria-label={t("tourGuide.deleteSampleLabel")}
                aria-describedby={questionId}
                className="border border-input text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={onDelete}
              >
                {t("tourGuide.deleteSample")}
              </Button>
            </>
          ) : (
            <Button ref={primaryRef} type="button" variant="brandDeep" onClick={onNext}>
              {t("tourGuide.next")}
            </Button>
          )}
        </div>
        {/* DOM 放在最後，Tab 順序才是「動作鈕 → ✕」；畫面上在右上角。 */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-2 top-2 h-7 w-7"
          aria-label={t("management.close")}
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>,
    document.body,
  );
}
