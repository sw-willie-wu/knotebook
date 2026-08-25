import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { canonicalNotePath, normalizeSlug, validateSlug, type NoteDto, type ShareDto, type ShareRole } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useUpdateNote } from "@/api/notes";
import { useDeleteShare, usePutShare, useShares } from "@/api/shares";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Share, Trash } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { ManualCopyField } from "@/components/ManualCopyField";

/** ApiFail → errors.<code>；其餘 → errors.fallback。與 NoteList/TitleInput 同一套對映（各檔各自一份，
 * 是既有慣例——見那兩處的說明，這裡不再重複抽象）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

const SELECT_CLASS =
  "h-8 shrink-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** 分享名單裡的一列：email/displayName、角色下拉（PUT 的 upsert 語意——改角色跟新增共用
 * 同一支 `usePutShare`）、移除鈕（DELETE，觸發 server 端 `onShareChanged` 重驗）。 */
function ShareRow({ noteId, share }: { noteId: string; share: ShareDto }) {
  const { t } = useTranslation();
  const putShare = usePutShare(noteId);
  const deleteShare = useDeleteShare(noteId);

  async function handleRoleChange(role: ShareRole): Promise<void> {
    try {
      await putShare.mutateAsync({ email: share.email, role });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  async function handleRemove(): Promise<void> {
    try {
      await deleteShare.mutateAsync(share.userId);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <li className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{share.displayName}</p>
        <p className="truncate text-xs text-muted-foreground">{share.email}</p>
      </div>
      <select
        aria-label={t("share.roleLabel", { email: share.email })}
        value={share.role}
        disabled={putShare.isPending}
        onChange={(event) => void handleRoleChange(event.target.value as ShareRole)}
        className={SELECT_CLASS}
      >
        <option value="viewer">{t("roles.viewer")}</option>
        <option value="editor">{t("roles.editor")}</option>
      </select>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("share.remove", { email: share.email })}
        disabled={deleteShare.isPending}
        onClick={() => void handleRemove()}
      >
        <Trash className="h-4 w-4" />
      </Button>
    </li>
  );
}

/** 分享名單 + 新增列。名單載入中／空清單各自的文案，跟 NoteList 的三態慣例一致。 */
function SharesSection({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const sharesQuery = useShares(noteId);
  const putShare = usePutShare(noteId);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ShareRole>("viewer");
  const [addError, setAddError] = useState<string | null>(null);

  async function handleAdd(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAddError(null);
    const trimmed = email.trim();
    if (trimmed.length === 0) return;
    try {
      await putShare.mutateAsync({ email: trimmed, role });
      setEmail("");
      setRole("viewer");
    } catch (err) {
      setAddError(errorMessage(t, err));
    }
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{t("share.peopleTitle")}</h3>

      {sharesQuery.isPending ? (
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      ) : sharesQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, sharesQuery.error)}
        </p>
      ) : sharesQuery.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("share.noShares")}</p>
      ) : (
        <ul className="space-y-2">
          {sharesQuery.data.map((share) => (
            <ShareRow key={share.userId} noteId={noteId} share={share} />
          ))}
        </ul>
      )}

      <form onSubmit={(event) => void handleAdd(event)} className="flex items-center gap-2">
        <Input
          type="email"
          required
          placeholder={t("share.emailPlaceholder")}
          aria-label={t("share.emailPlaceholder")}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="min-w-0 flex-1"
        />
        <select
          aria-label={t("share.newRoleLabel")}
          value={role}
          onChange={(event) => setRole(event.target.value as ShareRole)}
          className={SELECT_CLASS}
        >
          <option value="viewer">{t("roles.viewer")}</option>
          <option value="editor">{t("roles.editor")}</option>
        </select>
        <Button type="submit" size="sm" disabled={putShare.isPending}>
          {t("share.add")}
        </Button>
      </form>
      {addError && (
        <p role="alert" className="text-sm text-destructive">
          {addError}
        </p>
      )}
    </div>
  );
}

/**
 * 複製 canonical 連結到剪貼簿。程式化複製兩條路都不可用時（見 `lib/clipboard.ts`），
 * 就地攤出一個唯讀輸入框讓使用者自己選取——**不能只丟 toast**：Radix 的 toast root
 * 帶行內 `userSelect: "none"`，而且橫向拖曳會被 swipe-to-dismiss 手勢吃掉，等於看得到
 * 卻選不起來。
 */
function CopyLinkButton({ note }: { note: NoteDto }) {
  const { t } = useTranslation();
  const [manualUrl, setManualUrl] = useState<string | null>(null);

  async function handleCopy(): Promise<void> {
    const url = `${window.location.origin}${canonicalNotePath(note)}`;

    if (await copyText(url)) {
      setManualUrl(null);
      toast({ title: t("share.linkCopied") });
      return;
    }
    setManualUrl(url);
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={() => void handleCopy()}>
        {t("share.copyLink")}
      </Button>
      {manualUrl !== null && <ManualCopyField value={manualUrl} />}
    </div>
  );
}

/**
 * owner-only「自訂連結」欄。與 `TitleInput` 相同的存檔+`replaceState`模式（見該檔說明），
 * 差別是這裡先在 client 端用 `normalizeSlug`/`validateSlug`（與 server 的
 * `prepareSlugForPatch` 同源，見 `apps/server/src/notes/slug.ts`）擋掉明顯不合法的輸入，
 * 不必往返一趟才知道錯在哪；409 `slug_taken`／429 `too_many_requests` 這類「client 端
 * 判斷不出來、要打了才知道」的錯誤，仍走 server 回應 + `errors.<code>` 顯示。
 */
function SlugField({ note, cacheRef }: { note: NoteDto; cacheRef: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const updateNote = useUpdateNote();

  const [value, setValue] = useState(note.slug ?? "");
  const [serverError, setServerError] = useState<string | null>(null);

  const trimmed = value.trim();
  const normalized = trimmed.length > 0 ? normalizeSlug(trimmed) : "";
  const localReason = trimmed.length > 0 ? validateSlug(normalized) : null;
  const localError = localReason ? t(`share.slugError.${localReason}`) : null;
  const dirty = trimmed !== (note.slug ?? "");

  async function persist(next: string | null): Promise<void> {
    setServerError(null);
    try {
      const updated = await updateNote.mutateAsync({ id: note.id, slug: next });
      queryClient.setQueryData(["note", cacheRef], updated);
      window.history.replaceState(window.history.state, "", canonicalNotePath(updated));
      setValue(updated.slug ?? "");
    } catch (err) {
      setServerError(errorMessage(t, err));
    }
  }

  async function handleSave(): Promise<void> {
    if (localError || trimmed.length === 0 || !dirty) return;
    await persist(normalized);
  }

  async function handleClear(): Promise<void> {
    await persist(null);
  }

  return (
    <div className="space-y-1">
      <label htmlFor="share-slug" className="text-sm font-medium">
        {t("share.customLink")}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id="share-slug"
          value={value}
          placeholder={t("share.slugPlaceholder")}
          onChange={(event) => {
            setValue(event.target.value);
            setServerError(null);
          }}
          className="min-w-0 flex-1"
        />
        <Button
          type="button"
          size="sm"
          onClick={() => void handleSave()}
          disabled={!dirty || trimmed.length === 0 || localError !== null || updateNote.isPending}
        >
          {t("share.slugSave")}
        </Button>
        {note.slug && (
          <Button type="button" size="sm" variant="outline" onClick={() => void handleClear()} disabled={updateNote.isPending}>
            {t("share.slugClear")}
          </Button>
        )}
      </div>
      {localError && (
        <p role="alert" className="text-sm text-destructive">
          {localError}
        </p>
      )}
      {!localError && serverError && (
        <p role="alert" className="text-sm text-destructive">
          {serverError}
        </p>
      )}
    </div>
  );
}

export interface ShareDialogProps {
  note: NoteDto;
  /** 這個頁面實際讀的 `useNote` 快取鍵（同 `TitleInput` 的 `cacheRef`——slug 存檔成功後
   * 要把回應寫回本頁真正讀的那把 `['note', cacheRef]`，見該檔說明）。 */
  cacheRef: string;
}

/**
 * 分享管理 dialog（spec：owner-only）。非 owner（editor/viewer）完全不渲染——連觸發鈕
 * 都不出現，不只是「按了也沒用」而已。
 *
 * 內容只在實際開啟時掛載（`open && <...>`），分享名單的查詢因此也只在開啟時才打
 * `GET /api/notes/:id/shares`，不會在頁面一載入就多打一支用不到的 API。
 *
 * PR2（D.3）：觸發鈕改成 icon-only（原本是帶文字的按鈕）——`aria-label={t("share.button")}`
 * 頂住 accessible name，`ShareDialog.test.tsx` 既有的 `getByRole("button",{name:"Share"})`
 * 查詢不受影響（文字不變，只是從內容搬進 aria-label）。面板內容（`DialogContent` 以下）
 * 零改動。
 */
export function ShareDialog({ note, cacheRef }: ShareDialogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (note.role !== "owner") return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={t("share.button")}>
          <Share className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("share.title")}</DialogTitle>
          <DialogDescription>{t("share.description")}</DialogDescription>
        </DialogHeader>
        {open && (
          <div className="space-y-4">
            <CopyLinkButton note={note} />
            <SharesSection noteId={note.id} />
            <SlugField note={note} cacheRef={cacheRef} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
