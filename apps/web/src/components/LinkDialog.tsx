import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { resolveTrailingMarkdownLink } from "@/collab/markdown-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface LinkDialogProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 NoteEditor.tsx、wikilink/menu.ts）
  editor: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: { text: string; href: string }) => void;
}

/**
 * `/` 選單「連結」項的插入對話框（issue #99，design §6／§6.1）。兩欄：顯示文字、網址。
 *
 * ⚠ **不自己判網址**：網址驗證共用 Task 2 的裁決函式 `resolveTrailingMarkdownLink`——
 * 組 `[x](網址)` 去驗（顯示文字用佔位符 `x`，使用者填的顯示文字完全不進這段
 * markdown），否則文字裡的 `]`／`*`／反引號都要跳脫，等於在 UI 層重寫一份 markdown
 * escaper。因此 `editor` 是必要 prop，不是可選的裝飾。
 *
 * 送出後**不自己呼叫 `editor.createLink`**——那是 `NoteEditor` 的責任（它才是
 * 「選單開關 state」與「還原 selection 再落地」的所在，見該檔接線）。這裡只負責把
 * `{ text, href }` 交出去。
 *
 * ⚠ **顯示文字留空時用 `href` 頂上**（design §6 D15）：`editor.createLink(href, "")`
 * 的第二參數 falsy 時走 `addMark(r, i)`，而 `/` 選單的 selection 是 collapsed
 * （`r === i`）⇒ 零 step、對話框關掉、畫面什麼都沒發生——這是靜默失敗，必須在
 * 送出前擋掉，不是防禦性寫法。
 *
 * 這個 dialog 沒有 `DialogDescription`（跟 `ShareDialog` 的版型有這一點落差）：
 * 兩欄輸入框本身就是內容，沒有值得額外念一句的說明——同 `AiEditsDialog` 省略它的
 * 理由。`aria-describedby={undefined}` 是不給 Radix 一個不存在的目標，不是漏補。
 *
 * 焦點回歸必須走 `DialogContent` 的 `onCloseAutoFocus` ＋ `preventDefault()`：
 * 同步呼叫 `editor.focus()`（例如在取消鈕的 `onClick` 裡）會被 `FocusScope` 的
 * 還原蓋掉（真編輯器實測過，三條關閉路徑——送出成功、取消鈕、Esc／點背景——
 * 都釘在 `LinkDialog.test.tsx` 裡）。
 */
export function LinkDialog({ editor, open, onOpenChange, onSubmit }: LinkDialogProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 同頁若出現第二個 `LinkDialog` 實例（目前用不到，但比照 `<label for>` 綁定的一般
  // 慣例），id 不寫死——避免兩份 `<label for="link-dialog-text">` 打架。
  const textId = useId();
  const urlId = useId();
  const urlErrorId = useId();

  // 每次開啟都是全新的一輪——不帶上一次殘留的文字或錯誤訊息。
  useEffect(() => {
    if (open) {
      setText("");
      setUrl("");
      setError(null);
    }
  }, [open]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmedUrl = url.trim();
    const hit = resolveTrailingMarkdownLink(editor, `[x](${trimmedUrl})`);
    // ⚠ `resolveTrailingMarkdownLink` 的判準是**尾端比對**（design §4 第 7 步：
    // `textBefore.endsWith(recon)`），不是「整段等於」。這裡餵給它的 textBefore 就是
    // `[x](${trimmedUrl})` 本身，所以只要網址欄裡藏著自己的 `)` 加另一段
    // `[y](真正網址`，尾端仍能拼出一個合法連結、`hit` 不是 null，但 `hit.href` 是
    // 「藏在後半段」的那個網址，不是使用者以為自己填的那一整串。不比對回去就會
    // 靜默插出一個 使用者沒打算給的 href（複核 fix round 3 Minor 1）。
    if (!hit || hit.href !== trimmedUrl) {
      setError(t("note.link.invalidUrl"));
      return;
    }
    onSubmit({ text: text.trim() || hit.href, href: hit.href });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("note.link.dialogTitle")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={textId} className="text-sm font-medium">
              {t("note.link.textLabel")}
            </label>
            <Input id={textId} value={text} onChange={(event) => setText(event.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor={urlId} className="text-sm font-medium">
              {t("note.link.urlLabel")}
            </label>
            <Input
              id={urlId}
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
              }}
              aria-describedby={error ? urlErrorId : undefined}
            />
            {error && (
              <p id={urlErrorId} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("home.cancel")}
            </Button>
            <Button type="submit">{t("note.link.insert")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
