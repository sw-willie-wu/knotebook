import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export interface ManualCopyFieldProps {
  /** 要讓使用者手動選取複製的網址（呼叫端已組好完整字串）。 */
  value: string;
}

/**
 * 程式化複製兩條路都失敗時（見 `lib/clipboard.ts` 的 `copyText`）的退路 UI：就地
 * 攤出一個唯讀輸入框讓使用者自己選取複製——**不能只丟 toast**：Radix 的 toast root
 * 帶行內 `userSelect: "none"`，橫向拖曳還會被 swipe-to-dismiss 手勢吃掉，等於看得到
 * 卻選不起來。**必須掛在某個 `<Dialog>` 底下**——說明文字用 Radix 的
 * `DialogDescription`（見下），它讀 `useDialogContext()`，脫離 Dialog 會直接丟錯；
 * 兩處既有呼叫端（`ShareDialog`／`NoteMenu`）都已符合這個前提。
 *
 * PR2（D.4）從 `ShareDialog` 的 `CopyLinkButton` 抽出，供 ⋮ 選單的複製失敗分支共用。
 * **`ShareDialog.test.tsx` 零改動是這次抽出的保存條件**——抽出時逐項保真：
 * `aria-labelledby` + `readOnly` + `onFocus` 全選 + 既有文案（`share.copyFailed`）。
 *
 * 說明文字改用 `DialogDescription`（而非普通 `<p>`）：review 收尾——這是 repo 裡
 * 唯一沒有 description 的 Dialog（`NoteMenu.tsx` 的手動複製 Dialog 原本只有
 * `DialogTitle`）。`id={labelId}` 覆寫 Radix 內部的 `context.descriptionId`——
 * `DialogDescription` 允許同一個 Dialog 底下掛多個實例（Radix 用 count 判斷「有沒有
 * 描述」，不限一個），覆寫 id 純粹是為了讓 `aria-labelledby` 能精準指到這一段文字，
 * 不影響 Radix 自己那份 `aria-describedby` 的判斷（`ShareDialog` 自己的
 * `DialogDescription` 不受影響，兩者 id 不同不衝突）。
 *
 * 只在「值真的換手」時自動選取：`useEffect` deps 是 `[value]`（抽出前
 * `ShareDialog.tsx` 的等價寫法是 `[manualUrl]`——同一個值換手就重選一次，這裡精確
 * 對齊，不是「反正掛載一次」的空 deps 近似值）。不用 inline 的
 * `ref={n => n?.select()}`：那個 callback 每次 render 都是新 identity，React 會
 * 重新掛載它而再次 `select()`，`select()` 會把焦點移過來，使用者在同一個 dialog
 * 裡打字時會被搶走（與 TitleInput #10 同一類缺陷）。回頭想再選一次的話，下面的
 * `onFocus` 已經涵蓋。
 */
export function ManualCopyField({ value }: ManualCopyFieldProps) {
  const labelId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    inputRef.current?.select();
  }, [value]);

  return (
    <>
      <DialogDescription id={labelId}>{t("share.copyFailed")}</DialogDescription>
      <Input
        readOnly
        value={value}
        aria-labelledby={labelId}
        onFocus={(event) => event.currentTarget.select()}
        ref={inputRef}
      />
    </>
  );
}
