import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { ZoomButton } from "./ZoomButton";
import { useMediaZoom } from "./context";
import { prefetchMediaLightbox } from "./lightbox-chunk";
import { selectedImageOf } from "./selected-image";

const IMAGE_SELECTOR = '.bn-block-content[data-content-type="image"] img.bn-visual-media';
/** 欄內的 diff 預覽（例如 AI 建議的比對）是唯讀預覽，裡面的圖不提供放大。 */
const IN_DIFF = ".kb-diff";
const INSET = 4;
/** 圖兩側中段調寬把手高度的一半。 */
const HANDLE_HALF = 15;

type Size = { width: number; height: number };

/**
 * 放大鈕的位置（相對 `container`）。預設在圖的右上角內側 4px；圖矮到鈕會碰到右側中段的調寬把手時，
 * 改放圖外面的上方（水平位置不變）。
 */
export function zoomButtonPlacement(img: DOMRect, container: DOMRect, button: Size): { top: number; left: number } {
  const left = img.right - container.left - button.width - INSET;
  const tooShort = INSET + button.height > img.height / 2 - HANDLE_HALF - INSET;
  // 外側時鈕的下緣緊貼圖的上緣（不留縫）：滑鼠從圖往上移到鈕的途中不會離開圖。
  const top = tooShort ? img.top - container.top - button.height : img.top - container.top + INSET;
  return { top, left };
}

function isLoaded(img: HTMLImageElement): boolean {
  return img.isConnected && img.complete && img.naturalWidth > 0;
}

/**
 * 事件目標往上找：在某張圖的調寬框內，或在同一個圖片 block 的內容區／外框（圖與鈕之間的縫）⇒ 那張圖；
 * 在別的區塊內 ⇒ null（收起）；不在任何區塊內（例如放大鈕本身）⇒ undefined（不變）。
 */
function imageUnder(node: EventTarget | null): HTMLImageElement | null | undefined {
  const el = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  if (!el) return undefined;
  if (el.closest(IN_DIFF)) return undefined;
  const wrapper = el.closest(".bn-visual-media-wrapper");
  if (wrapper) {
    const img = wrapper.querySelector<HTMLImageElement>("img.bn-visual-media");
    if (img?.matches(IMAGE_SELECTOR)) return img;
  }
  const outer = el.closest(".bn-block-outer");
  if (!outer) return undefined;
  // 圖矮時鈕在圖外上方，滑鼠要經過 block 的內距才到得了：同一個圖片 block 的非巢狀部分都算在圖上。
  const group = el.closest(".bn-block-group");
  if (group && outer.contains(group)) return null;
  const own = outer.querySelector<HTMLImageElement>(`:scope > .bn-block > ${IMAGE_SELECTOR}`);
  return own ?? null;
}

function sourceOf(img: HTMLImageElement) {
  const caption = img.closest(".bn-block-content")?.querySelector("figcaption.bn-file-caption")?.textContent ?? "";
  return {
    kind: "image" as const,
    src: img.currentSrc || img.src,
    alt: img.alt,
    caption,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
  };
}

/**
 * #462：BlockNote 內建圖片 block 的浮動放大鈕，疊在編輯欄的 `relative` wrapper（`container`）上，跟著圖片自己的右上角走。
 * 顯示來源：滑鼠 hover（觸控的 pointer 不算）與 block 被選取（NodeSelection）；放大開著、或鈕有焦點時不隨 pointer／選取變動收起，
 * 關閉後焦點才回得到這顆鈕。唯讀時圖片本身可聚焦，點、Enter、Space 直接開。
 */
export function ImageZoomLayer({
  container,
  editable,
  editor,
}: {
  container: HTMLElement | null;
  editable: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，repo 慣例
  editor?: BlockNoteEditor<any, any, any>;
}): JSX.Element | null {
  const zoom = useMediaZoom();
  const active = zoom !== null;
  const [hover, setHover] = useState<HTMLImageElement | null>(null);
  const [selected, setSelected] = useState<HTMLImageElement | null>(null);
  const [rev, setRev] = useState(0);
  const bump = useCallback(() => setRev((n) => n + 1), []);
  const layerRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<Size>({ width: 0, height: 0 });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // 放大開著，或剛關掉、焦點還沒還回放大鈕。
  const frozenRef = useRef(false);
  const isOpenNow = zoom?.isOpen === true;
  // pointer 實際所在的圖；顯示中的 hover 在放大開著或鈕有焦點時凍結，之後再追上這個值。
  const pointerImgRef = useRef<HTMLImageElement | null>(null);
  // 目前顯示鈕的那張圖（沒有鈕時 null）：內容變動時只有鈕在才需要重量位置。
  const shownRef = useRef<HTMLImageElement | null>(null);
  const buttonFocused = () => {
    const layer = layerRef.current;
    return layer !== null && layer.contains(document.activeElement);
  };
  const { t } = useTranslation();
  const zoomLabel = t("note.zoom.open");

  // 放大畫面關掉後，Radix 要到下一個 task 才把焦點還給放大鈕（`onCloseAutoFocus`）。這段空檔裡
  // 指標底下若是別的區塊，pointerover 會先把鈕收掉，焦點就回不到它。所以關掉後多凍結一個 task，
  // 焦點落定了才追上指標。這個 setTimeout 一定排在 Radix 那次之後：Radix 是在 FocusScope 卸載的
  // cleanup 裡排它的 setTimeout，而 React 在同一次 commit 裡會先跑完所有卸載的 cleanup，才跑新的
  // passive effect（這裡）。
  useEffect(() => {
    if (isOpenNow) {
      frozenRef.current = true;
      return;
    }
    if (!frozenRef.current) return;
    const timer = setTimeout(() => {
      frozenRef.current = false;
      if (!buttonFocused()) setHover(pointerImgRef.current);
    }, 0);
    return () => {
      clearTimeout(timer);
      frozenRef.current = false;
    };
  }, [isOpenNow]);

  useEffect(() => {
    if (!container || !active) return;
    const isOpen = () => zoomRef.current?.isOpen === true || frozenRef.current;
    const onPointerOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const found = imageUnder(e.target);
      if (found === undefined) return;
      pointerImgRef.current = found;
      if (found !== null) prefetchMediaLightbox(); // 點下去前就把放大畫面的 chunk 抓好
      // 放大開著時完全凍結；鈕有焦點時只擋「收起」，可以換成別張圖。
      if (isOpen() || (found === null && buttonFocused())) return;
      setHover(found);
      bump(); // 同一張圖被推動（欄分隔線、區塊搬移）時 ResizeObserver 不會響：進來時重量一次
    };
    const onPointerLeave = () => {
      pointerImgRef.current = null;
      if (!isOpen() && !buttonFocused()) setHover(null);
    };
    // 圖載好（或載失敗）的當下重算：hover 中的圖剛載好要補出鈕。
    const onMediaEvent = (e: Event) => {
      if (e.target instanceof HTMLImageElement) bump();
    };
    container.addEventListener("pointerover", onPointerOver);
    container.addEventListener("pointerleave", onPointerLeave);
    container.addEventListener("load", onMediaEvent, true);
    container.addEventListener("error", onMediaEvent, true);
    return () => {
      container.removeEventListener("pointerover", onPointerOver);
      container.removeEventListener("pointerleave", onPointerLeave);
      container.removeEventListener("load", onMediaEvent, true);
      container.removeEventListener("error", onMediaEvent, true);
    };
  }, [container, active, bump]);

  useEffect(() => {
    if (!editable || !editor || !active) return;
    const update = () => {
      if (zoomRef.current?.isOpen) return;
      setSelected(selectedImageOf(editor.prosemirrorView));
    };
    update();
    // 區塊搬移、欄分隔線拖曳不改圖的尺寸、ResizeObserver 不響：鈕顯示中時內容一變就（每幀至多一次）重量位置。
    let frame = 0;
    const onChange = () => {
      if (frame || shownRef.current === null) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        bump();
      });
    };
    const offSelection = editor.onSelectionChange(update);
    const offChange = editor.onChange(onChange);
    return () => {
      offSelection?.();
      offChange?.();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [editable, editor, active, bump]);

  // 唯讀：圖片本身可聚焦、可點。MutationObserver 補上之後才插進來（或被重繪換掉）的圖。
  useEffect(() => {
    if (!container || !active || editable) return;
    const mark = () => {
      container.querySelectorAll<HTMLImageElement>(IMAGE_SELECTOR).forEach((img) => {
        if (img.closest(IN_DIFF)) return;
        img.setAttribute("tabindex", "0");
        img.setAttribute("data-kb-zoomable", "");
        // 可聚焦的圖念出「圖名，放大檢視」：開得了放大檢視要讓鍵盤與讀屏使用者知道。
        img.setAttribute("aria-label", img.alt ? `${img.alt}, ${zoomLabel}` : zoomLabel);
      });
    };
    const open = (img: HTMLImageElement) => {
      if (!isLoaded(img)) return;
      zoomRef.current?.open(sourceOf(img), { button: null, media: img });
    };
    const imageOf = (e: Event): HTMLImageElement | null => {
      const found = e.target instanceof Element ? e.target.closest<HTMLImageElement>(IMAGE_SELECTOR) : null;
      return found && !found.closest(IN_DIFF) ? found : null;
    };
    const onClick = (e: MouseEvent) => {
      const img = imageOf(e);
      if (!img || (e.target as Element).closest("a") !== null) return;
      // 拖曳選取文字後放開也會觸發 click：有選取就不開。
      if (window.getSelection()?.isCollapsed === false) return;
      open(img);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const img = imageOf(e);
      if (!img || e.target !== img) return;
      e.preventDefault(); // Space 不捲頁
      open(img);
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(container, { childList: true, subtree: true });
    container.addEventListener("click", onClick);
    container.addEventListener("keydown", onKeyDown);
    return () => {
      observer.disconnect();
      container.removeEventListener("click", onClick);
      container.removeEventListener("keydown", onKeyDown);
      container.querySelectorAll<HTMLElement>("[data-kb-zoomable]").forEach((img) => {
        img.removeAttribute("tabindex");
        img.removeAttribute("data-kb-zoomable");
        img.removeAttribute("aria-label");
      });
    };
  }, [container, active, editable, zoomLabel]);

  const target = hover ?? selected;
  const shown = active && container !== null && target !== null && isLoaded(target) ? target : null;
  shownRef.current = shown;

  // 顯示中遇到版面變動（欄寬、圖被調寬、視窗縮放）就重算。座標相對欄 wrapper，wrapper 跟內容一起捲，捲動不必重算。
  useEffect(() => {
    if (!container || !shown) return;
    const observer = new ResizeObserver(bump);
    observer.observe(container);
    observer.observe(shown);
    window.addEventListener("resize", bump);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", bump);
    };
  }, [container, shown, bump]);

  // 鈕的實際尺寸第一次出現前量不到（先當 0），掛上後在 layout effect 量到再重算（paint 前，不閃）。
  useLayoutEffect(() => {
    const button = layerRef.current?.querySelector("button");
    if (!button) return;
    const { width, height } = button.getBoundingClientRect();
    if (width === sizeRef.current.width && height === sizeRef.current.height) return;
    sizeRef.current = { width, height };
    bump();
  });

  if (!shown || !container) return null;
  void rev; // 版面變動時 bump 讓這裡重新量位置
  const style = zoomButtonPlacement(shown.getBoundingClientRect(), container.getBoundingClientRect(), sizeRef.current);
  return (
    <div
      ref={layerRef}
      data-kb-zoom-layer=""
      className="absolute z-10"
      style={style}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        if (!zoomRef.current?.isOpen) setHover(pointerImgRef.current);
      }}
    >
      <ZoomButton
        // 唯讀時鍵盤與螢幕閱讀器走圖本身（它的 aria-label 已帶「放大檢視」），這顆只留給滑鼠。
        {...(editable ? {} : { tabIndex: -1, "aria-hidden": true as const })}
        // 唯讀時這顆鈕不可聚焦，關掉後焦點改回圖本身（唯讀時圖可聚焦）。
        onClick={(event) => zoom?.open(sourceOf(shown), { button: editable ? event.currentTarget : null, media: shown })}
      />
    </div>
  );
}
