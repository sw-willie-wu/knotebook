import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NoteDto } from "@knotebook/shared";
import { errorMessage, useAddFavorite, useRemoveFavorite } from "@/api/favorites";
import { FavoriteRemoveDialog } from "@/components/FavoriteRemoveDialog";
import { Button } from "@/components/ui/button";
import { Star } from "@/components/ui/icons";
import { hoverRevealOnly } from "@/components/ui/reveal";
import { toast } from "@/components/ui/toast";
import { captureRemoveContext, focusAfterRemoveLater, type RemoveContext } from "@/lib/favorite-focus";
import { cn } from "@/lib/utils";

/**
 * 側欄筆記列右側的最愛星星（24px 圖示鈕，緊接在 `RoleBadge` 之後、⋮ 之前）。
 * - 已是最愛：實心、一直顯示；點下先開確認框，確認後移出。
 * - 不是最愛：空心、平常 `opacity-0`，列被 hover 或列內有鍵盤焦點時浮出；觸控裝置整顆隱藏（加入走 ⋮）；點下直接加入。
 * - 可及名稱固定 `note.favorite.label`（同頁首星號），狀態只由 `aria-pressed` 表達；`title` 是目前動作的提示。
 *
 * 狀態從 `NoteList` 傳進來（整份清單只訂一次 `["favorites"]`），這裡不訂 `["favorites"]` 查詢，所以列數多也不會多出 query observer（每列仍各有自己的 mutation hook）。
 * 送出中用 `aria-disabled`＋onClick 直接 return，不用 `disabled`：鍵盤焦點留在鈕上。
 * 確認框只在開著時掛載。最愛 tab 裡那一列會在移出成功後卸載，所以關框與焦點都在 `await` 之後，
 * 焦點退路用開框當下記下的鄰居決定。
 */
export function RowFavoriteStar({ note, favorite, pending }: { note: NoteDto; favorite: boolean; pending: boolean }) {
  const { t } = useTranslation();
  const addFavorite = useAddFavorite();
  const removeFavorite = useRemoveFavorite();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [removing, setRemoving] = useState<RemoveContext | null>(null);

  async function handleClick(): Promise<void> {
    if (pending) return;
    if (favorite) {
      setRemoving(captureRemoveContext(buttonRef.current));
      return;
    }
    try {
      await addFavorite.mutateAsync({ noteId: note.id });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  async function handleConfirmRemove(ctx: RemoveContext): Promise<void> {
    try {
      await removeFavorite.mutateAsync({ noteId: note.id });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
    setRemoving(null);
    focusAfterRemoveLater(ctx);
  }

  return (
    <>
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="icon"
        className={cn("h-6 w-6 shrink-0", favorite ? "text-brand hover:text-brand" : cn("text-muted-foreground hover:text-brand", hoverRevealOnly("noterow")))}
        aria-label={t("note.favorite.label")}
        aria-pressed={favorite}
        aria-disabled={pending ? true : undefined}
        title={favorite ? t("note.menu.removeFavorite") : t("note.menu.addFavorite")}
        onClick={() => void handleClick()}
      >
        <Star aria-hidden="true" className="h-3.5 w-3.5" fill={favorite ? "currentColor" : "none"} />
      </Button>
      {removing !== null && (
        <FavoriteRemoveDialog
          title={note.title}
          open
          pending={removeFavorite.isPending}
          onConfirm={() => void handleConfirmRemove(removing)}
          onOpenChange={(open) => {
            if (open) return;
            setRemoving(null);
            focusAfterRemoveLater(removing);
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
        />
      )}
    </>
  );
}
