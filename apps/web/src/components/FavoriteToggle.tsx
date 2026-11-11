import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useAddFavorite, useFavoriteStatus, useRemoveFavorite } from "@/api/favorites";
import { FavoriteRemoveDialog } from "@/components/FavoriteRemoveDialog";
import { Button } from "@/components/ui/button";
import { Star } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * 筆記頁頁首的最愛星號。未加入：點下樂觀加入（不出 toast，星號本身就是回饋）；已加入：點下先開確認框，
 * 確認後移出（同樣不出 toast）。失敗一律出錯誤 toast。
 *
 * - 送出中用 `aria-disabled`＋onClick 直接 return，不用 `disabled`：鍵盤使用者按 Space 時焦點在這顆鈕上，
 *   `disabled` 會讓焦點掉到 body。
 * - 查詢還沒到或失敗時用 `disabled`（還不能操作，也沒有焦點要保）。
 * - 頁首比 18rem 窄時整顆收起（`@max-[18rem]:hidden`，頁首是 `@container`）：星號會把分享或 ⋮ 擠出卡片，
 *   這時改由 ⋮ 選單的同名項目進入。
 */
export function FavoriteToggle({ note }: { note: NoteDto }) {
  const { t } = useTranslation();
  const { ready, favorite, pending } = useFavoriteStatus(note.id);
  const addFavorite = useAddFavorite();
  const removeFavorite = useRemoveFavorite();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);

  async function handleClick(): Promise<void> {
    if (pending) return;
    if (favorite) {
      setConfirming(true);
      return;
    }
    try {
      await addFavorite.mutateAsync({ noteId: note.id });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  async function handleConfirmRemove(): Promise<void> {
    try {
      await removeFavorite.mutateAsync({ noteId: note.id });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
    setConfirming(false);
  }

  return (
    <>
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0 text-brand hover:text-brand aria-disabled:cursor-not-allowed aria-disabled:opacity-50 @max-[18rem]:hidden"
        aria-label={t("note.favorite.label")}
        aria-pressed={favorite}
        aria-disabled={pending ? true : undefined}
        title={favorite ? t("note.menu.removeFavorite") : t("note.menu.addFavorite")}
        disabled={!ready}
        onClick={() => void handleClick()}
      >
        <Star className="h-4 w-4" fill={favorite ? "currentColor" : "none"} />
      </Button>
      <FavoriteRemoveDialog
        title={note.title}
        open={confirming}
        pending={removeFavorite.isPending}
        onConfirm={() => void handleConfirmRemove()}
        onOpenChange={setConfirming}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          buttonRef.current?.focus();
        }}
      />
    </>
  );
}
