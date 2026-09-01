import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { canonicalNotePath, normalizeSlug, validateSlug, type NoteDto, type ShareDto, type ShareRole } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useUpdateNote } from "@/api/notes";
import { useDeleteShare, usePutShare, useShares } from "@/api/shares";
import { useCreatePublicLink, useDeletePublicLink, usePublicLink } from "@/api/public-link";
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

type AccessLevel = "private" | "members" | "public";

/** 三態的 derive（僅供 latch 初值與顯式重算點——不是持續同步）。 */
function deriveAccess(token: string | null, shares: ShareDto[]): AccessLevel {
  return token ? "public" : shares.length > 0 ? "members" : "private";
}

/**
 * 分享三態（#72，spec §4）：私人🔒／限定成員👥／公開連結🌐。
 *
 * **radio 是 sticky 的 UI state（latch）**：兩個 query（shares＋public-link）首次
 * 都拿到資料時 derive 一次初值；之前顯示 loading、**不選中任何 radio**——dialog
 * 內容是開啟才掛載、query 開啟當下必為 undefined，字面的「開啟時 derive」會讓
 * 已公開的筆記永遠顯示私人（安全性誤述，spec B4）。之後**使用者的選擇活到
 * dialog 關閉為止**（關閉即 unmount、重開重新 latch——由 ShareDialog 的
 * `open &&` 掛載結構保證，有測試釘住），沒有「資料變動時重算」的全域規則
 * （有的話「公開→限定成員（零成員）」與「移除最後一位成員」都會被 refetch 彈回
 * 私人）。
 *
 * **顯式重算點只有三個**（除此之外選擇不被覆寫）：
 *   ① mutation 失敗的復原（`recoverFromError`）：radio 已樂觀切走、動作卻沒成——
 *      不復原就是「畫面說已撤銷、連結還活著」的安全性誤述，且 sticky 讓它永遠
 *      不會自己修正；
 *   ② 私人確認流的取消鈕：什麼都沒動，radio 回實況；
 *   ③ 私人確認流中止（部分失敗）：refetch 後依新資料重算。
 *
 * 成員名單與加人表單在**三態都渲染**（SharesSection 原樣）——radio 只是動作
 * 觸發器：在「私人」態加人不會重算 selection（刻意）。**確認流懸掛中**成員被
 * 名單那側清空時，effect 會替使用者把剩下的「撤連結」做完（否則動作憑空蒸發：
 * radio 顯示私人、連結還活著——審查探針實測過的路徑）。
 *
 * 私人確認流（D3）：行內確認列出將移除成員數；確認後**先 DELETE public-link、
 * 再循序 DELETE shares**（順序承重：中止時最壞是「還剩幾位成員」，不是「連結
 * 還開著」）。
 */
function AccessSection({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const sharesQuery = useShares(noteId);
  const linkQuery = usePublicLink(noteId);
  const createLink = useCreatePublicLink(noteId);
  const deleteLink = useDeletePublicLink(noteId);
  const deleteShare = useDeleteShare(noteId);

  const [selection, setSelection] = useState<AccessLevel | null>(null); // null＝尚未 latch
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const latched = selection !== null;
  const token = linkQuery.data?.token ?? null;
  const shares = sharesQuery.data ?? [];
  const queriesFailed = linkQuery.isError || sharesQuery.isError;

  useEffect(() => {
    if (selection === null && linkQuery.data !== undefined && sharesQuery.data !== undefined) {
      setSelection(deriveAccess(linkQuery.data.token, sharesQuery.data));
    }
  }, [selection, linkQuery.data, sharesQuery.data]);

  /** 顯式重算點①：mutation 失敗——toast、refetch 兩個 query、radio 依新資料重算。 */
  async function recoverFromError(err: unknown): Promise<void> {
    toast({ title: errorMessage(t, err), variant: "destructive" });
    const [freshShares, freshLink] = await Promise.all([sharesQuery.refetch(), linkQuery.refetch()]);
    setSelection(deriveAccess(freshLink.data?.token ?? null, freshShares.data ?? []));
  }

  /** 撤銷公開連結（失敗即復原——裸 mutate 的靜默失敗是審查抓到的安全性誤述）。 */
  async function revokeLink(): Promise<void> {
    try {
      await deleteLink.mutateAsync();
    } catch (err) {
      await recoverFromError(err);
    }
  }

  /** 產生／重生公開連結（同上，失敗即復原）。 */
  async function mintLink(): Promise<void> {
    try {
      await createLink.mutateAsync();
    } catch (err) {
      await recoverFromError(err);
    }
  }

  // 確認流懸掛中成員被名單那側清空（同面板兩公分外的移除鈕）→ 替使用者把
  // 「撤連結」補完，不讓動作蒸發。sharesQuery.data 檢查：refetch 期間 shares 的
  // fallback [] 不算「清空了」。
  useEffect(() => {
    if (!confirming || sharesQuery.data === undefined || sharesQuery.data.length > 0) return;
    setConfirming(false);
    if (token) void revokeLink();
    // revokeLink/token 刻意不進 deps：這個 effect 只該在「確認中＋名單變空」的
    // 邊緣觸發一次，token 翻 null（撤銷完成）不該再跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirming, sharesQuery.data]);

  function pick(next: AccessLevel): void {
    if (!latched || busy) return;
    setConfirming(false);
    if (next === "public") {
      setSelection("public");
      // token 已存在不重生（PUT＝重生、非冪等——重生只走 Regenerate 鈕）。
      if (!token) void mintLink();
      return;
    }
    if (next === "members") {
      setSelection("members");
      if (token) void revokeLink();
      return;
    }
    setSelection("private");
    if (shares.length > 0) {
      setConfirming(true); // 有成員：行內確認後才動手
    } else if (token) {
      void revokeLink();
    }
  }

  async function confirmPrivate(): Promise<void> {
    setBusy(true);
    try {
      // 順序承重：先撤連結再清成員——中止時最壞是「還剩幾位成員」。
      if (token) await deleteLink.mutateAsync();
      for (const share of shares) {
        await deleteShare.mutateAsync(share.userId);
      }
      setConfirming(false);
    } catch (err) {
      // 顯式重算點③：中止＋依 refetch 後資料重算，殘餘名單如實呈現。
      await recoverFromError(err);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  const publicUrl = token ? `${window.location.origin}/p/${token}` : null;
  const options: Array<{ value: AccessLevel; label: string; desc: string }> = [
    { value: "private", label: t("share.access.private"), desc: t("share.access.privateDesc") },
    { value: "members", label: t("share.access.members"), desc: t("share.access.membersDesc") },
    { value: "public", label: t("share.access.public"), desc: t("share.access.publicDesc") },
  ];

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{t("share.access.title")}</h3>

      {queriesFailed && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, linkQuery.error ?? sharesQuery.error)}
        </p>
      )}

      <div role="radiogroup" aria-label={t("share.access.title")} aria-busy={!latched} className="space-y-1">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-start gap-2 rounded-md p-2 hover:bg-accent/60"
          >
            <input
              type="radio"
              name="share-access"
              className="mt-1"
              checked={selection === option.value}
              disabled={!latched || busy}
              onChange={() => pick(option.value)}
            />
            <span className="flex flex-col">
              <span className="text-sm">{option.label}</span>
              <span className="text-xs text-muted-foreground">{option.desc}</span>
            </span>
          </label>
        ))}
      </div>

      {!latched && !queriesFailed && <p className="text-sm text-muted-foreground">{t("app.loading")}</p>}

      {confirming && shares.length > 0 && (
        // role="alert"：破壞性確認憑空長出來，鍵盤/AT 使用者按下 radio 後要被告知。
        <div role="alert" className="space-y-2 rounded-md border border-destructive/40 p-2">
          <p className="text-sm">
            {token
              ? t("share.access.confirmHintWithLink", { count: shares.length })
              : t("share.access.confirmHint", { count: shares.length })}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void confirmPrivate()}>
              {t("share.access.confirmPrivate", { count: shares.length })}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                // 顯式重算點②：取消＝什麼都沒動，radio 回實況（沒有這行會停在
                // 「私人」而連結還活著——載重，別當成可省的糖）。
                setConfirming(false);
                setSelection(deriveAccess(token, shares));
              }}
            >
              {t("share.access.confirmCancel")}
            </Button>
          </div>
        </div>
      )}

      {selection === "public" && publicUrl && (
        <div className="space-y-2">
          <Input readOnly value={publicUrl} aria-label={t("share.access.publicUrlLabel")} className="text-xs" />
          <div className="flex gap-2">
            <PublicCopyButton url={publicUrl} />
            <Button type="button" variant="ghost" size="sm" disabled={createLink.isPending} onClick={() => void mintLink()}>
              {t("share.access.regenerate")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 複製公開連結（與 CopyLinkButton 同一套 clipboard 三段退路，語意分明：這顆複製
 * 的是免登入的 /p/ 連結，不是內部 canonical 連結）。 */
function PublicCopyButton({ url }: { url: string }) {
  const { t } = useTranslation();
  const [manualUrl, setManualUrl] = useState<string | null>(null);

  async function handleCopy(): Promise<void> {
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
        {t("share.copyPublicLink")}
      </Button>
      {manualUrl !== null && <ManualCopyField value={manualUrl} />}
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
        {t("share.copyInternalLink")}
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
        {/* text-brand 必須放在 Button 的 className（不是掛在 <Share/> icon 上）：
            twMerge 對 ghost variant 的 hover:text-accent-foreground 互斥掉這裡的
            hover:text-brand，只在同一次 cn() 呼叫內才成立——掛在 icon 上是不同
            元素、不同 cn() 呼叫，機制不會生效。hover:bg-accent 底變化沿用 ghost
            variant，不動。 */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("share.button")}
          className="text-brand hover:text-brand"
        >
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
            <AccessSection noteId={note.id} />
            <CopyLinkButton note={note} />
            <SharesSection noteId={note.id} />
            <SlugField note={note} cacheRef={cacheRef} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
