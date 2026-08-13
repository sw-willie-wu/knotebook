import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { canonicalNotePath } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useCreateNote } from "@/api/notes";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { NoteList } from "@/components/NoteList";
import { UserMenu } from "@/components/UserMenu";

interface AppShellProps {
  children: ReactNode;
}

/**
 * 主佈局：左側欄（新增筆記鈕 + `NoteList` + 底部 `UserMenu`）、右側主內容區
 * （呼叫端傳入的 `children`——目前只有 `HomePage` 這一個呼叫端，因為
 * `/notes/:ref` 要到 Task 13 才存在；屆時編輯器頁面一樣掛在同一個插槽）。
 *
 * 新增筆記：`POST /api/notes`（`useCreateNote`）成功後直接導向新筆記的
 * `canonicalNotePath`（NoteDto.slug 此時必為 `null`，會落在 vanity-slug+id 或純
 * id 那兩態——見 `canonicalNotePath` 的說明）；失敗則跟 `NoteList` 刪除鈕同一套
 * 錯誤處理慣例：ApiFail → `errors.<code>`、否則 `errors.fallback`，用 toast 顯示
 * （不像 LoginPage 用行內 `errorMessage` state——這裡沒有表單可以掛错误文案）。
 */
export function AppShell({ children }: AppShellProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const createNote = useCreateNote();

  async function handleNewNote(): Promise<void> {
    try {
      const note = await createNote.mutateAsync(undefined);
      navigate(canonicalNotePath(note));
    } catch (err) {
      const message =
        err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback");
      toast({ title: message, variant: "destructive" });
    }
  }

  return (
    // 手動 UI 驗收回饋：NotePage 的三個面板（編輯器欄／AI 側欄／backlinks 區）要各自
    // 固定高度、內文獨立捲動，頁面本身不得整體捲動。根源在這裡——`min-h-screen`
    // 只設下限，內容一旦比視口高，這個 row 容器（連帶下面 `main`）就會跟著撐高，
    // 逼出**文件層級**的捲動，`main` 原本的 `overflow-y-auto` 或 `NotePage`/`NoteEditor`
    // 內部各自的 `overflow-y-auto` 因此永遠沒有機會真的裁切（它們的高度從沒被鎖住過，
    // 只是跟著內容長）。改成 `h-screen`（鎖視口）＋ `overflow-hidden`（防殘留捲軸）
    // 才能讓 `h-full` 這條鏈從這裡開始真的是「視口高度」，下游 `main`／`NotePage`／
    // `NoteEditor` 的 `min-h-0`＋`overflow-y-auto` 才會生效。
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="p-2">
          <Button className="w-full" onClick={() => void handleNewNote()} disabled={createNote.isPending}>
            {t("home.newNote")}
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          <NoteList />
        </div>
        <div className="border-t border-border p-2">
          <UserMenu />
        </div>
      </aside>
      {/* `min-h-0`：`main` 是這個 row 容器裡的 flex 子項，`h-screen` 讓它靠
          `align-items: stretch` 拿到明確高度，但 Safari/舊版瀏覽器對「stretch 出來的
          高度是否算明確」不一致；補一個 `min-h-0` 保險，確保它不會因為子孫內容
          （`NotePage` 的 `h-full` 鏈）而被撐高。 */}
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
