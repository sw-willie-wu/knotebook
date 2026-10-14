import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { absoluteUrl, blockLinkUrl, copyBlockLink } from "@/lib/copy-block-link";

const HEADING_SELF = ':scope > .bn-block > .bn-block-content[data-content-type="heading"]';
const HEADING_TEXT = ":scope > .bn-block > .bn-block-content > .bn-inline-content";

/** 從事件目標往上找最近的 `.bn-block-outer`：自己是標題 ⇒ 那顆；是別種區塊 ⇒ null（隱藏）；不在任何區塊裡（例如 # 鈕本身）⇒ undefined（不變）。 */
function headingOuterOf(node: EventTarget | Node | null): HTMLElement | null | undefined {
  const el = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  const outer = el?.closest<HTMLElement>(".bn-block-outer") ?? null;
  if (!outer) return undefined;
  return outer.querySelector(HEADING_SELF) ? outer : null;
}

type Size = { width: number; height: number };

/**
 * 「#」放在標題文字**右側**（相對 `container`）。不放左側：可編輯時 BlockNote 側邊選單（`+`／`⠿`，z-index 20）正好蓋在區塊左緣外，
 * 「#」看得到、點不到（task-15 審查 r0 I-1，headed 瀏覽器實測）。
 * - 垂直：在文字**首行**置中——首行取 Range 的第一個 client rect；空標題（沒有文字片段）退回整個 inline box。
 * - 水平：不超出欄位右緣（`left ≤ 欄寬 − 鈕寬`）；文字頂到右緣時不讓「#」撐出橫向捲動（審查 r1 m1：公開頁 `<md` 量到 1px 溢出）。
 */
function placeOf(outer: HTMLElement, container: HTMLElement, button: Size): { top: number; left: number } {
  const box = container.getBoundingClientRect();
  const inline = outer.querySelector<HTMLElement>(HEADING_TEXT) ?? outer;
  const text = inline.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(inline);
  const firstLine = range.getClientRects()[0] ?? text;
  return {
    top: firstLine.top - box.top + (firstLine.height - button.height) / 2,
    left: Math.min(text.right - box.left + 4, box.width - button.width),
  };
}

type Target = { outer: HTMLElement; id: string; top: number; left: number };

/**
 * #269 §10.3(b)：標題旁 hover「#」鈕（editor、viewer、公開頁都有）。疊在編輯欄的 `relative` wrapper（`container`）上；pointer 進入、或選取
 * 游標落在標題區塊時顯示，pointer 離開整個欄位時隱藏。複製 `location.origin + location.pathname + "#b-" + id`（公開頁即公開網址）。
 * 觸控沒有 hover（§17-6）。
 */
export function HeadingAnchorButtons({ container, linkBase }: { container: HTMLElement | null; linkBase?: () => string }) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<Target | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // 鈕的實際尺寸：第一次出現前量不到（先當 0），掛上後在 layout effect 量到再重算一次（paint 前，不閃）。
  const sizeRef = useRef<Size>({ width: 0, height: 0 });

  useEffect(() => {
    if (!container) return;
    const show = (found: HTMLElement | null | undefined) => {
      if (found === undefined) return;
      if (found === null) {
        setTarget(null);
        return;
      }
      const id = found.getAttribute("data-id");
      if (!id) return;
      setTarget({ outer: found, id, ...placeOf(found, container, sizeRef.current) });
    };
    const onPointerOver = (e: PointerEvent) => show(headingOuterOf(e.target));
    const onPointerLeave = () => setTarget(null);
    const onSelection = () => {
      const anchor = document.getSelection()?.anchorNode ?? null;
      if (anchor && container.contains(anchor)) show(headingOuterOf(anchor));
    };
    container.addEventListener("pointerover", onPointerOver);
    container.addEventListener("pointerleave", onPointerLeave);
    document.addEventListener("selectionchange", onSelection);
    return () => {
      container.removeEventListener("pointerover", onPointerOver);
      container.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("selectionchange", onSelection);
    };
  }, [container]);

  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button || !container) return;
    const { width, height } = button.getBoundingClientRect();
    if (width === sizeRef.current.width && height === sizeRef.current.height) return;
    sizeRef.current = { width, height };
    setTarget(cur => (cur ? { ...cur, ...placeOf(cur.outer, container, sizeRef.current) } : cur));
  }, [target, container]);

  // 顯示中遇到版面變動（欄寬、內容推移、視窗縮放）就重算位置；區塊被刪掉就收起。座標相對欄 wrapper，wrapper 跟內容一起捲，捲動不必重算。
  const outer = target?.outer ?? null;
  useEffect(() => {
    if (!container || !outer) return;
    const replace = () =>
      setTarget(cur => {
        if (!cur || cur.outer !== outer) return cur;
        if (!outer.isConnected) return null;
        const next = placeOf(outer, container, sizeRef.current);
        return next.top === cur.top && next.left === cur.left ? cur : { ...cur, ...next };
      });
    const observer = new ResizeObserver(replace);
    observer.observe(container);
    observer.observe(outer);
    window.addEventListener("resize", replace);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", replace);
    };
  }, [container, outer]);

  if (!target) return null;
  const base = linkBase ? linkBase() : absoluteUrl(window.location.pathname);
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={t("note.blockLink.copyHeading")}
      title={t("note.blockLink.copyHeading")}
      className="absolute z-10 rounded px-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ top: target.top, left: target.left }}
      onClick={() => void copyBlockLink(blockLinkUrl(base, target.id), t)}
    >
      #
    </button>
  );
}
