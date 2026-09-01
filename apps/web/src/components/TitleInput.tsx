import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useUpdateNote } from "@/api/notes";
import { toast } from "@/components/ui/toast";

/** 停止輸入後多久自動存檔（spec §5：blur 或 800ms debounce）。 */
export const TITLE_DEBOUNCE_MS = 800;

interface TitleInputProps {
  note: NoteDto;
  /** 沒有編輯權限（viewer／none／連線已終止）時改成純文字顯示。 */
  readOnly: boolean;
}

/**
 * 筆記標題輸入框。**標題不在 Y.Doc 裡**（spec §5：標題走 REST 的 last-write-wins，
 * 不即時共編）——所以這裡是一個獨立於 BlockNote 之外的受控 input，只跟
 * `PATCH /api/notes/:id` 打交道。
 *
 * 存檔時機：停止輸入 800ms，或 blur（blur 會把 pending 的 debounce 立刻沖出去，
 * 不等計時器）。存檔成功後把回應寫回 `['note', note.id]`（#122 起 NotePage 的常駐層
 * 就是這把 id 鍵——寫回它頁面即時反映；`['notes']` 側欄清單由 `useUpdateNote` 自己
 * invalidate）。**本元件不寫網址**（A3）：改標題會重算 auto slug、canonical 跟著變，
 * 但唯一寫網址點是 NotePage 的收斂 effect——快取更新 → 常駐層 note 變 → effect
 * `replaceState`；在途 PATCH 於換筆記後才回來時，收斂 effect 會因為轉場中 `note`
 * 被閘成 undefined 而早退（舊版自帶 replaceState 沒這道閘，會把網址改回前一篇）。
 *
 * 空標題不送（server 端 `z.string().min(1)` 會回 400）：blur 時若內容是空白，
 * 一律還原成目前的標題。
 */
export function TitleInput({ note, readOnly }: TitleInputProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const updateNote = useUpdateNote();

  const [value, setValue] = useState(note.title);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最近一次「已送出或已知同步」的標題。用它判斷 note.title 的變化是不是我們自己
  // 造成的回音，避免把使用者正在打的字覆蓋掉。
  const syncedRef = useRef(note.title);

  // 標題被別處改動（協作者改名、快取 refetch）時重新對齊。使用者本地有未存的修改
  // （value !== syncedRef.current）時不覆蓋。#122 A1 之後「換筆記」不再走這裡——
  // 轉場一律出佔位卡，本元件會被卸載重掛、useState 直接吃新值（⚠ NotePage 本身仍是
  // 同元件重用不 remount，別把那個結論改掉——是 TitleInput 的掛載期變短了）。
  useEffect(() => {
    if (note.title === syncedRef.current) return;
    syncedRef.current = note.title;
    setValue(note.title);
  }, [note.title]);

  // 請求往返期間使用者可能又打了字。回寫（成功回音或失敗還原）只在「輸入框仍是我們
  // 送出的那份內容」時才做——否則就是把使用者剛打的字直接抹掉。用 functional update
  // 讀當下的 value，避免 `save` 的閉包相依帶入 value 而每次輸入都重建。
  const keepIfUnedited = (submitted: string, next: string): void => {
    setValue((prev) => (prev.trim() === submitted ? next : prev));
  };

  const mutate = updateNote.mutateAsync;
  const save = useCallback(
    async (next: string): Promise<void> => {
      const trimmed = next.trim();
      if (trimmed.length === 0 || trimmed === syncedRef.current) return;
      syncedRef.current = trimmed;
      try {
        const updated = await mutate({ id: note.id, title: trimmed });
        syncedRef.current = updated.title;
        keepIfUnedited(trimmed, updated.title);
        queryClient.setQueryData(["note", note.id], updated);
      } catch (err) {
        syncedRef.current = note.title;
        keepIfUnedited(trimmed, note.title);
        const message =
          err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback");
        toast({ title: message, variant: "destructive" });
      }
    },
    [mutate, note.id, note.title, queryClient, t],
  );

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // 卸載時清掉尚未觸發的計時器（不硬存——卸載通常代表使用者離開這篇筆記，
  // 在背景對已離開的頁面發 PATCH 只會製造難以解釋的競態）。
  useEffect(() => clearTimer, []);

  function handleChange(next: string): void {
    setValue(next);
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void save(next);
    }, TITLE_DEBOUNCE_MS);
  }

  function handleBlur(): void {
    clearTimer();
    if (value.trim().length === 0) {
      setValue(syncedRef.current);
      return;
    }
    void save(value);
  }

  if (readOnly) {
    return (
      <h1 className="min-w-0 flex-1 truncate text-xl font-semibold" title={note.title}>
        {note.title}
      </h1>
    );
  }

  return (
    <input
      className="min-w-0 flex-1 bg-transparent text-xl font-semibold outline-none placeholder:text-muted-foreground"
      aria-label={t("note.titleLabel")}
      placeholder={t("note.titlePlaceholder")}
      value={value}
      onChange={(event) => handleChange(event.target.value)}
      onBlur={handleBlur}
    />
  );
}
