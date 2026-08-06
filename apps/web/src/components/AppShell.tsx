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
 * （不像 Login/SetupPage 用行內 `errorMessage` state——這裡沒有表單可以掛错误文案）。
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
    <div className="flex min-h-screen">
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
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
