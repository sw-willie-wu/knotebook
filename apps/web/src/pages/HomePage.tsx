import { useTranslation } from "react-i18next";
import { useNotes } from "@/api/notes";
import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { NarrowTopBar } from "@/components/NarrowTopBar";
import { cardSurface } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * `/` 首頁。`/notes/:ref` 要到 Task 13 才存在，所以這裡永遠沒有「選取中的筆記」，
 * 主內容區一律顯示引導文案：完全沒有筆記時引導建立第一篇（跟 `NoteList` 側欄的
 * 空狀態文案呼應）；已經有筆記時則引導從側欄選取或新增一篇。
 *
 * 這裡的 `useNotes()` 跟 `NoteList` 內部各自呼叫一次，但兩者共用同一個 query key
 * （`['notes']`）——react-query 會 dedupe，不會真的打兩次 `GET /api/notes`。
 */
export default function HomePage() {
  const { t } = useTranslation();
  const notesQuery = useNotes();
  const hasNotes = (notesQuery.data?.length ?? 0) > 0;

  return (
    <AppShell>
      {/* PR2（G 節）：主區插槽自己渲染一張全寬內文卡，跟 NotePage 的內文卡／佔位卡
          同一套視覺——main 已無自身捲動（見 AppShell.tsx），overflow-y-auto 掛在卡
          自己身上。 */}
      <div className={cn(cardSurface, "min-w-0 flex-1 overflow-y-auto")}>
        <NarrowTopBar />
        <EmptyState
          title={hasNotes ? t("home.selectTitle") : t("home.empty")}
          description={hasNotes ? t("home.selectDescription") : t("home.emptyDescription")}
        />
      </div>
    </AppShell>
  );
}
