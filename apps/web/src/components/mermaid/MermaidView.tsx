import { useEffect, useState, type JSX, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { renderMermaid, type MermaidRenderResult, type MermaidTheme } from "@/lib/mermaid";
import { cn } from "@/lib/utils";

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
 */
export function MermaidView({ code, editable, theme, onChange }: MermaidViewProps): JSX.Element {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(code);
  const [result, setResult] = useState<MermaidRenderResult | null>(null);

  // 每次 code/theme 換手都重畫。`cancelled` 是**必要**的：mermaid 的渲染是非同步的，
  // 使用者快速改動時舊的 promise 可能比新的晚 resolve，沒有這道閘門畫面會被舊結果蓋回去。
  useEffect(() => {
    let cancelled = false;
    void renderMermaid(code, theme).then((next) => {
      if (!cancelled) setResult(next);
    });
    return () => {
      cancelled = true;
    };
  }, [code, theme]);

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

  const body = (() => {
    if (result === null) return null; // 首次渲染尚未完成：不閃任何東西
    if (result.ok) {
      // `dangerouslySetInnerHTML` 的來源是 mermaid 的輸出——防線見檔頭說明
      // （`securityLevel:"strict"` + `htmlLabels:false` + 永不呼叫 `bindFunctions`）。
      return <div className="flex justify-center overflow-x-auto" dangerouslySetInnerHTML={{ __html: result.svg }} />;
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

  // 工具列只有**一顆鈕、一個方向**：進原始碼。出來的路是 Esc 或點別處（都走 `commit`），
  // 所以編輯中改顯示提示文字、不放第二顆鈕——舊版那顆「畫成圖」跟失焦行為完全重複。
  // viewer（`editable=false`）保留這顆鈕（標籤是「顯示原始碼」）：那是他們**唯一**看得到
  // 原始碼的入口（唯讀 textarea），拿掉就只剩語法錯誤時才看得到。
  //
  // ⚠ 這顆鈕與「點圖進編輯」那顆**不能巢狀**：巢狀 `<button>` 是不合法 HTML，且一次點擊
  // 會同時觸發兩者——單元測試釘住。
  //
  // 位置：**疊在方塊內的右上角**（`index.css` 的 `.block-control` 負責絕對定位，與 codeBlock
  // 的語言下拉同一條規則；外層要 `relative` 當它的 containing block）。#111 曾在方塊外面上方
  // 留一條 `h-7` 保留列放它，2026-10-15 定案拿掉（沒 hover 就是隱形、不擋內容，不必留距離）。
  // 疊上去之後與編輯鈕的**重疊**是刻意的，重疊區的點擊歸這顆鈕：
  //   - 可編輯：兩顆做的是同一件事（`startEditing`），點到哪顆結果都一樣。
  //   - 唯讀：底下是不可點的 `<div>`，沒有東西被攔。
  //   - 早期版本這顆鈕也疊在右上角（`absolute right-1 top-1`），e2e 抓到：block 很矮時（剛插入、
  //     只有一行提示）編輯鈕的**中心點**正好落在它底下——Playwright 的 click 打的就是中心點。
  //     現在空 block 的中心點命中的是編輯鈕（2026-10-15 headless Chromium 151、900px 寬實測），
  //     而且就算打到也同樣是進編輯。
  //   殘留：圖裡 `click X href` 的連結若正好畫在右上角，被這顆鈕蓋住的那一小塊點不到連結
  //   （滑鼠會先 hover 出鈕、看得見）。
  // 顯隱：平常 `opacity-0`，hover 整個方塊、方塊內有焦點（Tab 到編輯鈕）、或鈕自己被聚焦才現身。
  // 只用 `opacity` 隱藏而非 `hidden`——後者會讓它退出 Tab 順序，鍵盤使用者就永遠構不到。
  // 刻意**不**像語言下拉那樣在隱形時 `pointer-events:none`：觸控沒有 hover，唯讀者要看原始碼
  // 只剩點這個角落這條路（可編輯者點圖本身就進編輯，不需要它）。
  // 編輯中這顆鈕不渲染，改在 textarea **下方**放一行提示——提示文字長，疊在右上角會蓋住原始碼。
  // ⚠ 哪天若又要在**編輯中**放按鈕，記得補 `onMouseDown` 的 `preventDefault`：不擋的話
  // 點下去會先讓 textarea 失焦、`onBlur` 的 `commit()` 搶先翻狀態，按鈕看起來沒反應。
  // ⚠ `w-full` 不可省：BlockNote 的 `bn-block-content` 是 flex 容器，沒宣告寬度的子項
  // 會被 shrink-wrap 成內容寬度——實測（e2e 截圖）整個 block 縮成約 140px 的一小條。
  return (
    <div className="group relative w-full">
      {editing ? null : (
        <button
          type="button"
          onClick={startEditing}
          className={cn(
            // 長相與位置走 `index.css` 的 `.block-control`——那條規則同時餵這顆鈕與 codeBlock
            // 的語言下拉（原生 select 拿不到 className，只能用選擇器接進同一條規則），
            // 兩種 block 的控制項因此只有**一份**長相真相（issue #111）。這裡只留
            // 這顆鈕自己的顯隱行為。
            "block-control",
            "opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          {editable ? t("note.mermaid.edit") : t("note.mermaid.showSource")}
        </button>
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
            className="w-full resize-y rounded-md border border-input bg-muted/40 p-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        <div className="py-2">{body}</div>
      )}
    </div>
  );
}
