import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useDeleteNote, useNotes } from "@/api/notes";
import { matchesNoteRef } from "@/lib/note-ref";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Trash } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { EmptyState } from "@/components/EmptyState";

/** ApiFail → errors.<code>；其餘（網路失敗等）→ errors.fallback。與 LoginPage
 * 逐字同一套對映規則（見 client.ts 的說明）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/** 分享角色徽章——只給非 owner（editor/viewer）的筆記顯示；owner 自己的筆記不需要
 * 徽章（列表本身已隱含「這是你的」），'none' 理論上不會出現在 GET /api/notes 的
 * 結果裡（server 只回傳使用者有權限看的筆記）。 */
function RoleBadge({ role }: { role: NoteDto["role"] }) {
  const { t } = useTranslation();
  if (role !== "editor" && role !== "viewer") return null;
  return (
    <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
      {t(`roles.${role}`)}
    </span>
  );
}

/** owner-only 刪除鈕 + confirm dialog。刻意跟 `<Link>` 平行（同一個 `<li>` 底下的
 * 兄弟節點，不巢狀在 Link 裡面）——`<button>` 巢狀在 `<a>` 裡是不合法 HTML，且點擊
 * 會一併觸發外層 Link 的導航。 */
function DeleteNoteButton({ note }: { note: NoteDto }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { ref } = useParams<{ ref?: string }>();
  const deleteNote = useDeleteNote();
  const [open, setOpen] = useState(false);

  async function handleConfirm(): Promise<void> {
    try {
      await deleteNote.mutateAsync(note.id);
      setOpen(false);
      // 刪掉的正好是右邊開著的那一篇 → 導回 `/`，否則編輯頁會停在一篇已經不存在的
      // 筆記上（共編那條路徑由 close(NOTE_DELETED) 的 `deleted` 終態負責；這裡是
      // 「自己動手刪」的那條，不會有 close 訊息送給發起者以外的自己）。
      if (matchesNoteRef(ref, note)) {
        void navigate("/", { replace: true });
      }
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={t("home.delete")} className="shrink-0">
          <Trash className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("home.deleteTitle")}</DialogTitle>
          <DialogDescription>{t("home.deleteDescription", { title: note.title })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void handleConfirm()}
            disabled={deleteNote.isPending}
          >
            {t("home.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 側欄筆記清單——`GET /api/notes`（Task 10 的 `useNotes`）三態顯式處理：
 * - loading（`isPending`）：`app.loading` 文案，跟 `guards.tsx` 的 `FullScreenLoading`
 *   共用同一把 key。
 * - error（`isError`）：`role="alert"`，ApiFail → `errors.<code>`，否則 `errors.fallback`。
 * - empty（成功但 `data.length === 0`）：`EmptyState` 引導建立第一篇筆記。
 *
 * 每列連到 `canonicalNotePath(note)`——有自訂 slug 用 slug，沒有則 vanity slug + id，
 * 兩者皆空時純 id（三態定義見 `@knotebook/shared` 的 `canonicalNotePath`）。
 * `/notes/:ref` 這條路由本身要到 Task 13 才存在：目前這些連結會落在既有的
 * `/*` catch-all（即 HomePage 本身），這是預期中的過渡狀態，不需要為此先 stub 路由。
 */
export function NoteList() {
  const { t } = useTranslation();
  const { ref } = useParams<{ ref?: string }>();
  const notesQuery = useNotes();

  if (notesQuery.isPending) {
    return <p className="p-2 text-sm text-muted-foreground">{t("app.loading")}</p>;
  }

  if (notesQuery.isError) {
    return (
      <p role="alert" className="p-2 text-sm text-destructive">
        {errorMessage(t, notesQuery.error)}
      </p>
    );
  }

  const notes = notesQuery.data;
  if (notes.length === 0) {
    return <EmptyState title={t("home.empty")} description={t("home.emptyDescription")} />;
  }

  return (
    <ul className="space-y-0.5">
      {notes.map((note) => {
        const active = matchesNoteRef(ref, note);
        return (
          <li
            key={note.id}
            className={cn("group flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-accent", active && "bg-accent")}
          >
            {/* 刻意用 `<Link>` + 自算的 active，不用 `<NavLink>`：標題存檔後網址是靠
                `history.replaceState` 換的，react-router 的 location 不會跟著更新，
                NavLink 的比對會失準（見 `@/lib/note-ref` 的說明）。 */}
            <Link
              to={canonicalNotePath(note)}
              aria-current={active ? "page" : undefined}
              className={cn("min-w-0 flex-1 truncate text-sm", active && "font-medium")}
            >
              {note.title}
            </Link>
            <RoleBadge role={note.role} />
            {note.role === "owner" && <DeleteNoteButton note={note} />}
          </li>
        );
      })}
    </ul>
  );
}
