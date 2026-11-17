import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useTranslation } from "react-i18next";
import { X } from "@/components/ui/icons";
import { nextMermaidId, rewriteMermaidId } from "@/lib/mermaid";
import type { ZoomSource } from "./context";
import { ZoomSkeleton } from "./LightboxFallback";
import { fitView, panBy, toggleZoom, wheelFactor, zoomAt, type Point, type Size, type ZoomView } from "./zoom-math";

/** `+`／`-` 每按一次的縮放倍率。 */
const KEY_ZOOM_STEP = 1.2;
const KEY_PAN_STEP = 40;
const KEY_PAN_STEP_SHIFT = 200;
/** 按下到放開累計移動不超過這個距離才算「點一下」，超過就是拖曳。 */
const TAP_SLOP = 4;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE = 24;

/** 方向鍵＝看過去的方向：按右是要看更右邊，所以內容往左移。 */
const ARROW_PAN: Record<string, Point> = {
  ArrowRight: { x: -1, y: 0 },
  ArrowLeft: { x: 1, y: 0 },
  ArrowDown: { x: 0, y: -1 },
  ArrowUp: { x: 0, y: 1 },
};

interface Geometry {
  viewport: Size;
  view: ZoomView;
}

interface Gesture {
  start: Point;
  /** 這次手勢累計移動的距離（任一指）。 */
  travel: number;
  /** 期間曾有第二指按下：是捏合，不是點擊。 */
  multi: boolean;
  /** 按下時落在內容（圖／圖表）上；放開時指標被捕捉在視窗元素上，目標已看不出來。 */
  onContent: boolean;
}

function finite(p: Point): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

function positiveSize(size: Size): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 換掉 SVG 的根 id（mermaid 的樣式、marker 都以它為前綴），放大的這份就不會跟頁面上那張共用 id。
 * 沒有根 id 就原樣使用。
 */
function withFreshRootId(svg: string): string {
  // 只看第一個 `<svg …>` 開始標籤：根沒有 id 時不能退而換掉內層 svg 的 id。
  const rootTag = /<svg\b[^>]*>/.exec(svg)?.[0];
  const id = rootTag === undefined ? undefined : /\sid="([^"]+)"/.exec(rootTag)?.[1];
  return id === undefined ? svg : rewriteMermaidId(svg, id, nextMermaidId());
}

/**
 * 圖片與 mermaid 圖的全螢幕放大畫面（#462）。只經 `lightbox-chunk.ts` 的動態 `import()` 載入（`MediaZoomProvider` 的 `lazy()` 與預取共用）。
 *
 * 縮放改寬高而不是 `transform: scale()`：transform 會用點陣快照放大，SVG 會糊；只有平移用 `translate`。
 */
export function MediaLightbox({
  source,
  onClose,
  restoreFocus,
}: {
  source: ZoomSource;
  onClose: () => void;
  restoreFocus: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const natural = useMemo<Size>(
    () => ({ width: source.naturalWidth, height: source.naturalHeight }),
    [source.naturalWidth, source.naturalHeight],
  );
  const [viewportNode, setViewportNode] = useState<HTMLDivElement | null>(null);
  const [geo, setGeo] = useState<Geometry | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  // 圖片要等載入並解碼完才換掉灰塊（SVG 是內嵌的，不必等）。
  const [imageReady, setImageReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const markImageReady = useCallback((img: HTMLImageElement) => {
    const decoding = typeof img.decode === "function" ? img.decode() : undefined;
    if (decoding === undefined) setImageReady(true);
    else void decoding.then(
      () => setImageReady(true),
      () => setImageReady(true),
    );
  }, []);
  const setContent = useCallback(
    (el: HTMLElement | null) => {
      contentRef.current = el;
      // 已在快取裡（頁面上那張就是同一個網址）：當場視為備妥，連一格灰塊都不出。
      if (el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0) setImageReady(true);
    },
    [],
  );
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ at: number; point: Point } | null>(null);
  /** 觸控／筆點背景：等接下來的 `click` 才關，見 `handlePointerUp`。 */
  const closeOnClick = useRef(false);

  // 字串就是頁面上那份 mermaid 輸出，防線見 `lib/mermaid.ts`。
  const svgMarkup = useMemo(() => (source.kind === "svg" ? withFreshRootId(source.svg) : ""), [source]);

  // 量視窗尺寸；量到之前不渲染內容。尺寸一變（旋轉手機、縮放視窗）就回到新尺寸的「符合視窗」。
  useLayoutEffect(() => {
    if (viewportNode === null || !positiveSize(natural)) return;
    const measure = (force: boolean) => {
      const viewport = { width: viewportNode.clientWidth, height: viewportNode.clientHeight };
      if (!positiveSize(viewport)) return;
      setGeo(g =>
        !force && g !== null && g.viewport.width === viewport.width && g.viewport.height === viewport.height
          ? g
          : { viewport, view: fitView(natural, viewport) },
      );
    };
    measure(true);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(viewportNode);
    return () => observer.disconnect();
  }, [viewportNode, natural]);

  // 滾輪要 preventDefault（不捲動背後的頁面），React 的 onWheel 是 passive，所以掛原生監聽。
  useEffect(() => {
    if (viewportNode === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewportNode.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const { deltaY, deltaMode, ctrlKey } = event;
      if (!finite(anchor)) return;
      setGeo(g => {
        if (g === null) return g;
        const next = g.view.scale * wheelFactor(deltaY, deltaMode, ctrlKey, g.viewport.height);
        if (!(Number.isFinite(next) && next > 0)) return g;
        return { ...g, view: zoomAt(g.view, next, anchor, natural, g.viewport) };
      });
    };
    viewportNode.addEventListener("wheel", onWheel, { passive: false });
    return () => viewportNode.removeEventListener("wheel", onWheel);
  }, [viewportNode, natural]);

  function local(p: Point): Point {
    const rect = viewportNode?.getBoundingClientRect();
    return rect ? { x: p.x - rect.left, y: p.y - rect.top } : p;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // 帶修飾鍵的組合（例如 Ctrl／⌘ 加 `+`、`-` 的頁面縮放）留給瀏覽器；Esc 交給 Radix。
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const arrow = ARROW_PAN[event.key];
    if (arrow !== undefined) {
      event.preventDefault();
      const step = event.shiftKey ? KEY_PAN_STEP_SHIFT : KEY_PAN_STEP;
      setGeo(g => (g === null ? g : { ...g, view: panBy(g.view, arrow.x * step, arrow.y * step, natural, g.viewport) }));
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      setGeo(g => (g === null ? g : { ...g, view: fitView(natural, g.viewport) }));
      return;
    }
    const factor = event.key === "+" || event.key === "=" ? KEY_ZOOM_STEP : event.key === "-" ? 1 / KEY_ZOOM_STEP : 0;
    if (factor === 0) return;
    event.preventDefault();
    setGeo(g => {
      if (g === null) return g;
      const center = { x: g.viewport.width / 2, y: g.viewport.height / 2 };
      return { ...g, view: zoomAt(g.view, g.view.scale * factor, center, natural, g.viewport) };
    });
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    closeOnClick.current = false;
    if (geo === null || event.button !== 0) return;
    const point = { x: event.clientX, y: event.clientY };
    if (!finite(point)) return;
    pointers.current.set(event.pointerId, point);
    setDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 捕捉不到（例如指標已結束）不影響拖曳
    }
    if (pointers.current.size === 1) {
      const target = event.target instanceof Node ? event.target : null;
      gesture.current = {
        start: point,
        travel: 0,
        multi: false,
        onContent: target !== null && contentRef.current?.contains(target) === true,
      };
    } else if (gesture.current !== null) {
      gesture.current.multi = true;
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const previous = pointers.current.get(event.pointerId);
    if (previous === undefined) return;
    const current = { x: event.clientX, y: event.clientY };
    if (!finite(current)) return;
    if (gesture.current !== null) gesture.current.travel += distance(previous, current);

    if (pointers.current.size === 1) {
      pointers.current.set(event.pointerId, current);
      const dx = current.x - previous.x;
      const dy = current.y - previous.y;
      setGeo(g => (g === null ? g : { ...g, view: panBy(g.view, dx, dy, natural, g.viewport) }));
      return;
    }

    // 兩指：以中點、距離比縮放，舊中點底下的內容跟著手指移到新中點。第三指以後不參與。
    const [idA, idB] = [...pointers.current.keys()] as [number, number];
    if (event.pointerId !== idA && event.pointerId !== idB) {
      pointers.current.set(event.pointerId, current);
      return;
    }
    const a = pointers.current.get(idA)!;
    const b = pointers.current.get(idB)!;
    const nextA = event.pointerId === idA ? current : a;
    const nextB = event.pointerId === idB ? current : b;
    pointers.current.set(event.pointerId, current);
    const before = distance(a, b);
    const after = distance(nextA, nextB);
    if (!(before > 0 && after > 0)) return;
    const ratio = after / before;
    const oldMid = local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const newMid = local({ x: (nextA.x + nextB.x) / 2, y: (nextA.y + nextB.y) / 2 });
    setGeo(g => {
      if (g === null) return g;
      const next = g.view.scale * ratio;
      if (!(Number.isFinite(next) && next > 0)) return g;
      const zoomed = zoomAt(g.view, next, oldMid, natural, g.viewport);
      return { ...g, view: panBy(zoomed, newMid.x - oldMid.x, newMid.y - oldMid.y, natural, g.viewport) };
    });
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const previous = pointers.current.get(event.pointerId);
    if (previous === undefined) return;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) setDragging(false);
    const g = gesture.current;
    const end = { x: event.clientX, y: event.clientY };
    if (g !== null && finite(end)) g.travel += distance(previous, end);
    if (pointers.current.size > 0) return;
    gesture.current = null;
    if (g === null || g.multi || g.travel > TAP_SLOP) return;

    // 點一下：背景關閉；圖上兩下（間隔與距離都夠近）在「符合視窗」與放大之間切換。
    if (!g.onContent) {
      lastTap.current = null;
      // 觸控與筆在 pointerup 之後瀏覽器還會補送一次 click：這時就關掉，那次 click 會落到底下的頁面上
      // （幽靈點擊）。所以等那次 click 落在視窗元素上才關（Radix 的點外面關閉也是這樣做）；滑鼠照舊放開就關。
      if (event.pointerType === "touch" || event.pointerType === "pen") closeOnClick.current = true;
      else onClose();
      return;
    }
    const now = Date.now();
    const last = lastTap.current;
    if (last !== null && now - last.at <= DOUBLE_TAP_MS && distance(last.point, g.start) <= DOUBLE_TAP_DISTANCE) {
      lastTap.current = null;
      const anchor = local(g.start);
      setGeo(geom => (geom === null ? geom : { ...geom, view: toggleZoom(geom.view, anchor, natural, geom.viewport) }));
      return;
    }
    lastTap.current = { at: now, point: g.start };
  }

  /** 指標取消或失去捕捉（例如系統手勢接手）：把它從追蹤中拿掉，殘留的指標才不會讓之後的單指拖曳被當成捏合。 */
  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>): void {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = null;
      setDragging(false);
    }
  }

  function handleClick(): void {
    if (!closeOnClick.current) return;
    closeOnClick.current = false;
    onClose();
  }

  const title =
    source.kind === "image" ? source.caption || source.alt || t("note.zoom.imageTitle") : t("note.zoom.diagramTitle");
  const caption = source.kind === "image" ? source.caption : "";

  // 內容比視窗大（任一軸）才拖得動：游標是 grab／grabbing；剛好放得下就維持預設游標。
  // 指標被捕捉在視窗元素上，所以視窗本身也要帶同一個游標，背板與邊緣才與內容上一致。
  const canPan =
    geo !== null &&
    (natural.width * geo.view.scale > geo.viewport.width + 0.5 || natural.height * geo.view.scale > geo.viewport.height + 0.5);
  const panCursor = canPan ? (dragging ? "grabbing" : "grab") : undefined;

  let content: JSX.Element | null = null;
  if (geo !== null) {
    const { scale, offset } = geo.view;
    const style = {
      width: `${natural.width * scale}px`,
      height: `${natural.height * scale}px`,
      transform: `translate(${offset.x}px, ${offset.y}px)`,
      ...(panCursor !== undefined ? { cursor: panCursor } : {}),
    };
    // 內容坐在跟筆記裡一樣的卡面（`bg-card`，編輯器的底色）上：mermaid 的淺色主題用深灰畫線與字、根元素沒有底色，
    // 直接放在半透明黑背板上會看不見；圖片的卡面只會從透明像素透出來。
    content =
      source.kind === "image" ? (
        <img
          ref={setContent}
          src={source.src}
          alt={source.alt}
          draggable={false}
          className={`absolute left-0 top-0 max-w-none bg-card${imageReady ? "" : " opacity-0"}`}
          style={style}
          onLoad={event => markImageReady(event.currentTarget)}
          onError={() => setImageReady(true)}
        />
      ) : (
        <div
          ref={setContent}
          className="absolute left-0 top-0 rounded-md bg-card p-2 [&>svg]:block [&>svg]:h-full [&>svg]:w-full [&>svg]:max-w-none!"
          style={style}
          dangerouslySetInnerHTML={{ __html: svgMarkup }}
        />
      );
  }

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        {/* 不淡入：與先頂上的外殼（`LightboxFallback`）同一個不透明度，換手時背板不會閃。 */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 outline-none"
          onKeyDown={handleKeyDown}
          onCloseAutoFocus={event => {
            event.preventDefault();
            restoreFocus();
          }}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{t("note.zoom.hint")}</DialogPrimitive.Description>
          <div
            ref={setViewportNode}
            data-zoom-viewport=""
            className="absolute inset-0 touch-none select-none overflow-hidden"
            style={panCursor !== undefined ? { cursor: panCursor } : undefined}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onLostPointerCapture={handlePointerCancel}
            onClick={handleClick}
          >
            {content}
            {content === null || (source.kind === "image" && !imageReady) ? <ZoomSkeleton natural={natural} viewport={geo?.viewport} /> : null}
          </div>
          {caption && (
            <p className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/50 px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-center text-sm text-white">
              {caption}
            </p>
          )}
          <DialogPrimitive.Close
            aria-label={t("note.zoom.close")}
            className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] rounded-full bg-black/50 p-2 text-white/90 transition-colors hover:bg-black/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white pointer-coarse:after:absolute pointer-coarse:after:-inset-3.5 pointer-coarse:after:content-['']"
          >
            <X className="h-5 w-5" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
