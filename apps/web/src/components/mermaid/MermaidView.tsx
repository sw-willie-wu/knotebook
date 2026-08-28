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
  // ⚠ 這顆鈕與「點圖進編輯」那顆**既不能巢狀、也不能重疊**，兩點都是實測換來的：
  //
  // 1. 巢狀 `<button>` 是不合法 HTML，且一次點擊會同時觸發兩者——單元測試釘住。
  // 2. 重疊（`absolute right-1 top-1` 疊在編輯鈕右上角）會**攔截點擊**：block 很矮時
  //    （剛插入的空 block 只有一行提示），編輯鈕的中心點正好落在它底下，使用者點圖
  //    想編輯卻打到那顆鈕。加 `pointer-events-none` 也救不了——滑鼠移上來就觸發
  //    `group-hover`，`pointer-events` 隨即被打開，而點擊本來就必然先經過 hover。
  //    這個 bug **jsdom 測不到**（沒有 layout／hit-testing），是 e2e 抓到的。
  //
  // 所以工具列自己一行（高度固定，避免顯隱時版面跳動），內容在下面。按鈕只用 `opacity`
  // 隱藏而非 `hidden`——後者會讓它退出 Tab 順序，鍵盤使用者就永遠構不到。
  // ⚠ 哪天若又要在**編輯中**放按鈕，記得補 `onMouseDown` 的 `preventDefault`：不擋的話
  // 點下去會先讓 textarea 失焦、`onBlur` 的 `commit()` 搶先翻狀態，按鈕看起來沒反應。
  // ⚠ `w-full` 不可省：BlockNote 的 `bn-block-content` 是 flex 容器，沒宣告寬度的子項
  // 會被 shrink-wrap 成內容寬度——實測（e2e 截圖）整個 block 縮成約 140px 的一小條。
  return (
    <div className="group w-full">
      <div className="flex h-7 items-center justify-end">
        {editing ? (
          <span className="text-xs text-muted-foreground">{t("note.mermaid.escHint")}</span>
        ) : (
          <button
            type="button"
            onClick={startEditing}
            className={cn(
              "rounded-sm border border-border bg-background px-2 py-1 text-xs text-muted-foreground",
              "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            {editable ? t("note.mermaid.edit") : t("note.mermaid.showSource")}
          </button>
        )}
      </div>

      {editing ? (
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
