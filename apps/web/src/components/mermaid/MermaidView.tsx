import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { cachedMermaid, preloadMermaid, renderMermaid, type MermaidRenderResult, type MermaidTheme } from "@/lib/mermaid";
import { useMediaZoom } from "@/components/media-zoom/context";
import { svgIntrinsicSize } from "@/components/media-zoom/svg-size";
import { prefetchMediaLightbox } from "@/components/media-zoom/lightbox-chunk";
import { ZoomButton } from "@/components/media-zoom/ZoomButton";
import { tourTarget } from "@/lib/tour-targets";
import { useIsPhone } from "@/lib/layout-tiers";
import { cn } from "@/lib/utils";

/**
 * 「視窗附近」的範圍（#344 C）：上下各多 600px 就先開始畫，使用者捲到時圖多半已經好了。
 * 只放寬垂直方向——筆記是縱向捲動，橫向放寬沒有意義。
 */
export const MERMAID_ROOT_MARGIN = "600px 0px";

/** 這個環境有沒有 `IntersectionObserver`。沒有（jsdom、舊瀏覽器）就退回「掛上就畫」。 */
function hasIntersectionObserver(): boolean {
  return typeof IntersectionObserver !== "undefined";
}

/**
 * 最近的可捲動祖先，當 IntersectionObserver 的 `root`；找不到回 `null`（＝視窗）。
 *
 * ⚠ 不能省：筆記頁捲動的是內層的 `overflow-y-auto` 容器，不是視窗。`root` 用預設（視窗）時，
 * `rootMargin` 只放寬視窗那一層，目標先被內層捲動容器的可見框裁掉——600px 的預先範圍**完全不生效**，
 * 圖要真的露出來才開始畫（e2e 疊上實測：捲動容器底緣下方 42px 的圖一直沒被請求）。
 * 手機（< 640）上那一層是 `overflow-y: visible`、捲的是文件，這裡找不到會捲的祖先、回 null，正好就是視窗。
 *
 * ⚠ **從編輯器（`.bn-editor`）外面開始找**：BlockNote 的並排欄 `.bn-block-column` 設了
 * `overflow-x:auto`，依 CSS 規則另一軸的 `visible` 會算成 `auto`，所以欄的 computed `overflowY` 也是
 * `"auto"`——從圖本身往上找會先撞到欄。欄不會縱向捲動，圖永遠落在它的框內，IntersectionObserver 就
 * 一直回報「在附近」，並排裡的圖等於掛上就畫。編輯器內部的東西（欄、表格包層）
 * 永遠不是筆記的捲動容器。不在編輯器裡（獨立使用）時從自己的父層開始。
 */
function scrollRootOf(el: Element): Element | null {
  const start = el.closest(".bn-editor")?.parentElement ?? el.parentElement;
  for (let parent = start; parent !== null; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return parent;
  }
  return null;
}

/** 畫面上這份結果是替哪個 `(theme, code)` 畫的。 */
function renderKey(code: string, theme: MermaidTheme): string {
  return `${theme}\n${code}`;
}

interface Rendered {
  key: string;
  /** 畫這份結果時的原始碼（判斷「只換了主題」用）。 */
  code: string;
  result: MermaidRenderResult;
}

/** 掛載當下的結果：空原始碼不必等（不載 mermaid、直接是「還沒填」），快取命中就直接有圖。 */
function initialRendered(code: string, theme: MermaidTheme): Rendered | null {
  const key = renderKey(code, theme);
  if (code.trim().length === 0) return { key, code, result: { ok: false, message: "" } };
  const svg = cachedMermaid(code, theme);
  return svg === null ? null : { key, code, result: { ok: true, svg } };
}
export interface MermaidViewProps {
  /** mermaid 原始碼（block 的 `code` prop）。 */
  code: string;
  /** 目前角色能不能編輯（`roleCanEdit && synced`，同編輯器其餘部分）。false ⇒ 沒有編輯入口。 */
  editable: boolean;
  /** `resolvedTheme`。換主題會整張重畫。 */
  theme: MermaidTheme;
  /** 提交新的原始碼。**只在真的有變動時才會被呼叫**（見 `commit`）。 */
  onChange(code: string): void;
}

/**
 * mermaid 圖表的兩態檢視（issue #94）。
 *
 * 刻意跟 block spec（`spec.tsx`）分開成獨立元件：spec 那層綁死 BlockNote 的
 * `block`/`editor` 型別、很難單獨測；這一層只吃四個普通 props，jsdom 測得到
 * 兩態切換、錯誤態、viewer 視角與非同步競態（`lib/mermaid` 在測試中被 mock 掉——
 * mermaid 本體在 jsdom 跑不起來，理由見該檔）。
 *
 * ⚠ **SVG 是用 `dangerouslySetInnerHTML` 塞的**。這在本專案是可接受的，前提是
 * `lib/mermaid.ts` 的 `securityLevel: "strict"`（背後是 mermaid 內建的 dompurify）
 * 與 `htmlLabels: false` 都在，且**永不呼叫 `bindFunctions`**。動那支檔案前先讀它的說明。
 *
 * 效能（#344）：圖進到視窗附近（`MERMAID_ROOT_MARGIN`）才請求渲染、畫好之前顯示佔位、
 * 掛上就先暖 mermaid chunk；序列化佇列與快取在 `lib/mermaid.ts`。
 */
export function MermaidView({ code, editable, theme, onChange }: MermaidViewProps): JSX.Element {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(code);
  const [rendered, setRendered] = useState<Rendered | null>(() => initialRendered(code, theme));
  const result = rendered?.result ?? null;
  const rootRef = useRef<HTMLDivElement>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  const zoom = useMediaZoom();
  // 沒有 IntersectionObserver 的環境一律當成「在視窗附近」——寧可全畫，不可整張不畫。
  const [near, setNear] = useState(() => !hasIntersectionObserver());

  // #344 E：一掛上就暖 mermaid 主 chunk（不渲染），即使這張還在視窗外。空 block 不暖——
  // 新建的空 block 是常態，不該為它拉進一整包相依（同 `renderMermaid` 的空原始碼規則）。
  const hasSource = code.trim().length > 0;
  useEffect(() => {
    if (hasSource) preloadMermaid();
  }, [hasSource]);

  // #344 C：只在視窗附近才請求渲染。捲動的那一層跨 640 會換（手機上是文件、640 起是內文容器），換段時重找 root。
  const phone = useIsPhone();
  useEffect(() => {
    const el = rootRef.current;
    if (el === null || !hasIntersectionObserver()) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last !== undefined) setNear(last.isIntersecting);
      },
      { root: scrollRootOf(el), rootMargin: MERMAID_ROOT_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [phone]);

  // 要不要畫：在視窗附近就畫；不在附近時，只有「畫過、而且原始碼換了」才照常重畫。
  // **只換了主題**的遠處圖先留著舊主題的圖，等進到附近再重畫——換主題時畫面上的圖先換，
  // 不必排在上面那一長串捲出去的圖後面；600px 的預先範圍讓它捲回來之前多半已經換好。
  // 原始碼換了（例如共編的人改了它）則不等：舊圖已經不是這段原始碼的樣子。
  const key = renderKey(code, theme);
  const upToDate = rendered?.key === key;
  const codeChanged = rendered !== null && rendered.code !== code;
  const wanted = near || codeChanged;

  // 每次 code/theme 換手都重畫。`cancelled` 是**必要**的：mermaid 的渲染是非同步的，
  // 使用者快速改動時舊的 promise 可能比新的晚 resolve，沒有這道閘門畫面會被舊結果蓋回去。
  // `abort()` 則讓**還沒輪到**的請求直接離開佇列（捲出視窗、卸載、原始碼又改了），不白白畫一次；
  // 已經開始畫的停不下來，結果會進快取，捲回來時直接命中。
  useEffect(() => {
    if (!wanted || upToDate) return;
    let cancelled = false;
    const controller = new AbortController();
    renderMermaid(code, theme, { signal: controller.signal }).then(
      (next) => {
        if (!cancelled) setRendered({ key, code, result: next });
      },
      (err: unknown) => {
        // 已作廢的請求（含 AbortError——只有這裡的 cleanup 會 abort，所以 AbortError 必然伴隨 `cancelled`）
        // 不論怎麼結束都不管。沒作廢卻 reject（`renderMermaid` 正常不會，只有它自己的 bug 才會）不能吞：
        // 吞了圖就永遠停在佔位，改成錯誤態讓使用者至少看得到原始碼。
        if (cancelled) return;
        setRendered({ key, code, result: { ok: false, message: err instanceof Error ? err.message : String(err) } });
      },
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [code, theme, key, wanted, upToDate]);

  const startEditing = (): void => {
    setDraft(code);
    setEditing(true);
  };

  /** 離開編輯態。**原始碼沒變就不呼叫 `onChange`**——這是共編文件，無意義的
   * `updateBlock` 會產生一次 Yjs 更新、推一次 store、也會弄髒別人的 undo 堆疊。 */
  const commit = (): void => {
    setEditing(false);
    if (draft !== code) onChange(draft);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter 刻意不攔：圖的原始碼本來就是多行的。只有 Esc 是「我改完了」。
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // 不讓 Esc 冒到編輯器/Dialog 之類的上層 handler
      commit();
    }
  };

  // 放大：只在有放大功能（有 provider）、不在編輯、圖已畫好時成立。
  const canZoom = zoom !== null && !editing && result?.ok === true;

  const openZoom = (button: HTMLElement | null, media: Element): void => {
    if (zoom === null || result === null || !result.ok) return;
    const svg = diagramRef.current?.querySelector("svg");
    if (!svg) return;
    const box = svgIntrinsicSize(svg) ?? svg.getBoundingClientRect();
    const naturalWidth = box.width;
    const naturalHeight = box.height;
    if (!(naturalWidth > 0 && naturalHeight > 0)) return;
    zoom.open({ kind: "svg", svg: result.svg, naturalWidth, naturalHeight }, { button, media });
  };

  const openFromButton = (event: MouseEvent<HTMLButtonElement>): void => {
    // 唯讀時這顆鈕不可聚焦（只給滑鼠），關掉後焦點改回可聚焦的圖容器（圖的祖先）。
    openZoom(editable ? event.currentTarget : null, diagramRef.current ?? event.currentTarget);
  };

  const readOnlyZoomProps =
    canZoom && !editable
      ? {
          role: "button" as const,
          tabIndex: 0,
          "aria-label": t("note.zoom.openDiagram"),
          onClick: (event: MouseEvent<HTMLDivElement>) => {
            // 圖裡 `click X href` 產生的連結照常走連結，不開放大。
            if ((event.target as Element).closest("a") !== null) return;
            // 拖曳選取圖裡的文字後放開也會觸發 click：有選取就不開。
            if (window.getSelection()?.isCollapsed === false) return;
            openZoom(null, event.currentTarget);
          },
          onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault(); // Space 不捲頁
            openZoom(null, event.currentTarget);
          },
        }
      : {};

  const body = (() => {
    if (result === null) {
      // #344 D：還沒畫出來（還沒捲到，或正在排隊／渲染）——固定最小高度的佔位，取代一片空白，
      // 版面也不會從 0 高跳起來。只在**首次**出現：已經有圖時改 code 重畫，舊圖留著直到新圖出來。
      return (
        <div
          aria-busy="true"
          className="flex min-h-40 items-center justify-center rounded-md bg-muted/40 text-sm text-muted-foreground motion-safe:animate-pulse"
        >
          {t("note.mermaid.rendering")}
        </div>
      );
    }
    if (result.ok) {
      // `dangerouslySetInnerHTML` 的來源是 mermaid 的輸出——防線見檔頭說明
      // （`securityLevel:"strict"` + `htmlLabels:false` + 永不呼叫 `bindFunctions`）。
      return <div ref={diagramRef} className="flex justify-center overflow-x-auto" dangerouslySetInnerHTML={{ __html: result.svg }} />;
    }
    // 空原始碼不是錯誤，是「還沒填」——新建的 block 就長這樣。
    if (result.message === "") {
      return <p className="text-sm text-muted-foreground">{t("note.mermaid.empty")}</p>;
    }
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          {t("note.mermaid.error")}：{result.message}
        </p>
        {/* 錯誤態**必須**同時顯示原始碼——只給一句錯誤訊息的話，使用者（尤其是 viewer）
            根本不知道圖裡寫了什麼，也就改不回來。 */}
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 font-mono text-xs">{code}</pre>
      </div>
    );
  })();

  // 右上角是一組控制項（`.block-control-group`）：先是進原始碼的鈕，**放大鈕在最右角**。
  // 出來的路是 Esc 或點別處（都走 `commit`），所以編輯中改顯示提示文字、不放第二顆鈕。
  // viewer（`editable=false`）保留原始碼鈕（標籤是「顯示原始碼」）：那是他們**唯一**看得到
  // 原始碼的入口（唯讀 textarea），拿掉就只剩語法錯誤時才看得到。
  //
  // ⚠ 這組鈕與「點圖進編輯」那顆**不能巢狀**：巢狀 `<button>` 是不合法 HTML，且一次點擊
  // 會同時觸發兩者——單元測試釘住。
  //
  // 位置：**疊在方塊內的右上角**。組的位置由 `index.css` 的 `.block-control-group` 給，
  // 兩顆鈕照舊吃 `.block-control` 的長相（與 codeBlock 的語言下拉同一份長相真相，issue #111）；
  // 外層要 `relative` 當 containing block。重疊區的點擊歸這組鈕：
  //   - 可編輯：原始碼鈕與點圖做的是同一件事（`startEditing`），點到哪個結果都一樣。
  //   - 唯讀：底下是開放大的區塊，點到鈕就走鈕自己的動作。
  //   殘留：圖裡 `click X href` 的連結若正好畫在右上角，被這組鈕蓋住的那一小塊點不到連結
  //   （滑鼠會先 hover 出鈕、看得見）。
  // 顯隱：顯隱 class 掛在**組**上。平常 `opacity-0`，hover 整個方塊或方塊內有焦點才現身；
  // 觸控沒有 hover，所以 `hover: none` 的裝置上常駐淡色（看得到才點得到）。
  // 只用 `opacity` 隱藏而非 `hidden`——後者會讓它退出 Tab 順序，鍵盤使用者就永遠構不到；
  // 隱形時仍收得到點擊（沒有 pointer-events:none）：滑鼠點之前一定先 hover，那時鈕已經看得見，所以無妨。唯讀的觸控裝置上放大鈕另外 `hidden`：點圖本身就會放大，不需要它。
  // 編輯中這顆鈕不渲染，改在 textarea **下方**放一行提示——提示文字長，疊在右上角會蓋住原始碼。
  // ⚠ 哪天若又要在**編輯中**放按鈕，記得補 `onMouseDown` 的 `preventDefault`：不擋的話
  // 點下去會先讓 textarea 失焦、`onBlur` 的 `commit()` 搶先翻狀態，按鈕看起來沒反應。
  // ⚠ `w-full` 不可省：BlockNote 的 `bn-block-content` 是 flex 容器，沒宣告寬度的子項
  // 會被 shrink-wrap 成內容寬度——實測（e2e 截圖）整個 block 縮成約 140px 的一小條。
  return (
    <div
      ref={rootRef}
      className="group relative w-full"
      onPointerEnter={canZoom ? prefetchMediaLightbox : undefined}
      {...tourTarget("flowchart")}
    >
      {editing ? null : (
        <div
          className={cn(
            "block-control-group",
            "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-60 [@media(hover:none)]:group-focus-within:opacity-100",
          )}
        >
          <button type="button" onClick={startEditing} className="block-control">
            {editable ? t("note.mermaid.edit") : t("note.mermaid.showSource")}
          </button>
          {canZoom ? (
            <ZoomButton
              onClick={openFromButton}
              // 唯讀時鍵盤與螢幕閱讀器走圖的容器（相鄰、做同一件事），這顆只留給滑鼠。
              {...(editable ? {} : { tabIndex: -1, "aria-hidden": true as const })}
              className={editable ? undefined : "[@media(hover:none)]:hidden"}
            />
          ) : null}
        </div>
      )}

      {editing ? (
        <>
          <textarea
            aria-label={t("note.mermaid.sourceLabel")}
            value={draft}
            autoFocus
            readOnly={!editable}
            spellCheck={false}
            rows={Math.max(3, draft.split("\n").length + 1)}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={handleKeyDown}
            className="w-full resize-y rounded-md border border-input bg-muted/40 p-3 font-mono text-sm pointer-coarse:text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="mt-1 text-right text-xs text-muted-foreground">{t("note.mermaid.escHint")}</p>
        </>
      ) : editable ? (
        <button
          type="button"
          aria-label={t("note.mermaid.editArea")}
          // 圖裡可能有 `click X href` 產生的真連結（`<a>` 巢狀在 `<button>` 內不合法，
          // 點下去會同時導航與進編輯態）。點在連結上就讓連結自己處理。
          onClick={(event) => {
            if ((event.target as Element).closest("a") !== null) return;
            startEditing();
          }}
          className={cn("block w-full cursor-text rounded-md border border-transparent p-2 text-left", "hover:border-input")}
        >
          {body}
        </button>
      ) : (
        <div
          className={cn("py-2", readOnlyZoomProps.role !== undefined && "cursor-zoom-in")}
          {...readOnlyZoomProps}
        >
          {body}
        </div>
      )}
    </div>
  );
}
