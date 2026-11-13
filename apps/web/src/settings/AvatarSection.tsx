import { lazy, Suspense, useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { formatBytes, type AvatarCandidateDto, type AvatarRef } from "@knotebook/shared";
import { useIdentities } from "@/api/account";
import { AVATARS_QUERY_KEY, useAvatars, useDeleteAvatar, useRefreshOidcAvatar, useSelectAvatar } from "@/api/avatars";
import { useAuthConfig } from "@/api/authConfig";
import { ApiFail } from "@/api/client";
import { useSession } from "@/auth/useSession";
import { useFillPending, useQuotaFailed } from "@/avatars/filler-hooks";
import { fillKey, registerCropOpen } from "@/avatars/display-filler";
import { Avatar } from "@/components/Avatar";
import { ProviderIcon } from "@/components/ProviderIcon";
import { storageQuotaDescription } from "@/lib/storage-quota-text";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, EllipsisVertical, Pencil, Trash } from "@/components/ui/icons";
import { hoverReveal } from "@/components/ui/reveal";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./SettingsLayout";
import type { AvatarCropSource } from "./AvatarCropDialog";
import "@/i18n/management-strings";

// 裁切框連同它的相依只在使用者真的開框時才下載；解碼與編碼模組又再晚一步（按儲存時才載入）。
const AvatarCropDialog = lazy(() => import("./AvatarCropDialog").then(m => ({ default: m.AvatarCropDialog })));

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 候選格與其 ⋮ 共用的 grid 模板：兩個容器疊在同一格，各格與對應的 ⋮ 落在同一欄同一列。 */
const CELL_GRID = "grid grid-cols-[repeat(auto-fill,minmax(5rem,1fr))] gap-y-2";

/** 一格：「不使用頭貼」（candidate 為 null）或一張候選。 */
interface Cell {
  candidate: AvatarCandidateDto | null;
}

function candidateLabel(t: Translate, language: string, candidate: AvatarCandidateDto): string {
  if (candidate.source === "oidc") {
    return candidate.providerName !== null
      ? t("settings.account.avatar.fromProvider", { provider: candidate.providerName })
      : t("settings.account.avatar.fromDisconnected");
  }
  // 含時間：同一天上傳的幾張要能分得出來（radio 與 ⋮ 的可及名稱、刪除確認框都用這個名字）。
  const date = new Date(candidate.createdAt).toLocaleString(language, { dateStyle: "medium", timeStyle: "medium" });
  return t("settings.account.avatar.uploaded", { date });
}

/** 選用、刪除失敗的分流：404（剛被別的分頁刪掉）→ 重抓清單；忙碌 → 忙碌訊息；其餘 → 一般錯誤。 */
function reportFailure(t: Translate, err: unknown, refetch: () => void): void {
  if (err instanceof ApiFail && err.status === 404) {
    refetch();
    return;
  }
  const code = err instanceof ApiFail && err.code === "server_busy" ? "server_busy" : "internal";
  toast({ title: t(`errors.${code}`), variant: "destructive" });
}

/** 重新取得 OIDC 頭貼失敗的分流：照 `error.code`，其餘一律通用文案。404 由呼叫端處理（重抓清單、不彈錯誤）。 */
function reportRefreshFailure(t: Translate, err: unknown, provider: string): void {
  if (err instanceof ApiFail) {
    switch (err.code) {
      case "storage_quota_exceeded":
        toast({ title: t("errors.storage_quota_exceeded"), description: storageQuotaDescription(err, t), variant: "destructive" });
        return;
      case "server_busy":
      case "too_many_requests":
        toast({ title: t(`errors.${err.code}`), variant: "destructive" });
        return;
      case "avatar_fetch_failed":
        toast({ title: t("settings.account.avatar.refreshFailed", { provider }), variant: "destructive" });
        return;
    }
  }
  toast({ title: t("errors.internal"), variant: "destructive" });
}

function CandidateMenu({
  label,
  onRecrop,
  onDelete,
}: {
  label: string;
  onRecrop: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("settings.account.avatar.more", { candidate: label })}
          className={cn(
            "pointer-events-auto relative h-6 w-6 shrink-0 self-start justify-self-end",
            // 觸控裝置：視覺維持 24px，點擊區擴到 40×44。
            "pointer-coarse:before:absolute pointer-coarse:before:-inset-x-2 pointer-coarse:before:-inset-y-2.5 pointer-coarse:before:content-['']",
            hoverReveal("avatarcell"),
          )}
        >
          <EllipsisVertical aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={event => {
            event.preventDefault();
            setOpen(false);
            onRecrop();
          }}
        >
          <Pencil aria-hidden="true" className="mr-2 h-4 w-4" />
          {t("settings.account.avatar.recrop")}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={event => {
            event.preventDefault();
            setOpen(false);
            onDelete();
          }}
        >
          <Trash aria-hidden="true" className="mr-2 h-4 w-4" />
          {t("settings.account.avatar.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DeleteDialog({
  candidate,
  label,
  pending,
  onConfirm,
  onOpenChange,
}: {
  candidate: AvatarCandidateDto;
  label: string;
  pending: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.account.avatar.deleteTitle")}</DialogTitle>
          <DialogDescription>
            {t("settings.account.avatar.deleteDescription", { size: formatBytes(candidate.originalSize + candidate.displaySize) })}
          </DialogDescription>
          <p className="text-sm font-medium">{label}</p>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={pending}>
            {t("settings.account.avatar.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 設定頁的「頭貼」區塊：目前頭貼預覽、上傳、候選格（單選：不使用頭貼＋候選新到舊）、
 * 每張候選的「調整裁切」「刪除」。
 *
 * 候選格是 `role="radiogroup"`，只有一格在 Tab 序裡（roving tabindex；焦點離開群組後回到選中的那格），方向鍵／Home／End 移動焦點，
 * 選用靠點擊或空白鍵（按鈕的原生行為）。⋮ 不放在 `role="radio"` 裡（radio 的子孫是 presentational），
 * 而是第二個與 radiogroup 同模板的 grid、疊在同一格，各自指定同一欄同一列；Tab 序是 radiogroup 一次、再各 ⋮。
 * 外框的主題色用 CSS 變數（`Avatar` 的 `ringColor`），不用 `ring-brand` utility。
 */
export function AvatarSection() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const list = useAvatars();
  const maxUploadBytes = useAuthConfig().data?.maxUploadBytes;
  const select = useSelectAvatar();
  const remove = useDeleteAvatar();
  const refresh = useRefreshOidcAvatar();
  const identities = useIdentities();
  const quotaFailed = useQuotaFailed();
  const refreshButtons = useRef(new Map<string, HTMLButtonElement>());
  const [focusAfterRefresh, setFocusAfterRefresh] = useState<string | null>(null);
  const noSpaceId = useId();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const uploadButton = useRef<HTMLButtonElement | null>(null);
  const [focusAfterDelete, setFocusAfterDelete] = useState<{ id: string; index: number } | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [cropSource, setCropSource] = useState<AvatarCropSource | null>(null);
  const [deleting, setDeleting] = useState<AvatarCandidateDto | null>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);

  const displayName = user?.displayName ?? "";
  const candidates = list.data?.candidates ?? [];
  const cells: Cell[] = [{ candidate: null }, ...candidates.map(candidate => ({ candidate }))];
  const checkedIndex = Math.max(0, cells.findIndex(cell => cell.candidate?.current === true));
  const rovingIndex = Math.min(focusIndex ?? checkedIndex, cells.length - 1);
  const previewRef: AvatarRef | null = user?.avatar ? { id: user.avatar.id, v: user.avatar.v } : null;

  // 一選了要調整的候選就登記（裁切框是 lazy chunk，等它載入完才登記會漏掉這段時間）：背景補產不碰這張，已在跑的那張也不送出。
  const croppingId = cropSource?.kind === "existing" ? cropSource.candidate.id : null;
  useEffect(() => {
    if (croppingId === null) return;
    return registerCropOpen(croppingId);
  }, [croppingId]);

  // 清單裡待補顯示圖的候選也交給背景補產（同一版只處理一次）。
  useFillPending(candidates.filter(c => c.pending).map(c => ({ id: c.id, v: c.avatar.v })));
  const noSpaceKeys = candidates.filter(c => c.pending && quotaFailed.has(fillKey({ id: c.id, v: c.avatar.v }))).map(c => c.id);

  // 重新取得成功、那顆按鈕消失之後（清單不再列它），焦點交給目前選中的那格；按鈕還在就留在原處。
  useEffect(() => {
    if (focusAfterRefresh === null || list.data === undefined) return;
    setFocusAfterRefresh(null);
    const stillThere = list.data.refreshable.some(r => r.identityId === focusAfterRefresh);
    (stillThere ? refreshButtons.current.get(focusAfterRefresh) : radios.current[checkedIndex])?.focus();
  }, [focusAfterRefresh, list.data, checkedIndex]);

  // 刪除成功、清單不再含那張之後，把焦點交給原位置的下一格（刪的是最後一格就是上一格）；沒有候選了就交給上傳鈕。
  // 被刪候選的 ⋮ 已從 DOM 移除，不處理的話焦點會掉到 body。
  useEffect(() => {
    if (focusAfterDelete === null || list.data === undefined) return;
    if (list.data.candidates.some(c => c.id === focusAfterDelete.id)) return;
    const remaining = list.data.candidates.length;
    const target = remaining === 0 ? uploadButton.current : radios.current[Math.min(focusAfterDelete.index, remaining)];
    setFocusAfterDelete(null);
    if (remaining > 0) setFocusIndex(Math.min(focusAfterDelete.index, remaining));
    target?.focus();
  }, [focusAfterDelete, list.data]);

  function refetchList(): Promise<void> {
    return queryClient.invalidateQueries({ queryKey: AVATARS_QUERY_KEY });
  }

  function choose(cell: Cell, index: number): void {
    setFocusIndex(index);
    if (index === checkedIndex || select.isPending) return;
    select.mutate(cell.candidate === null ? null : cell.candidate.id, {
      onSuccess: () => toast({ title: t("settings.account.avatar.changed") }),
      onError: err => reportFailure(t, err, refetchList),
    });
  }

  function refreshFrom(identityId: string, provider: string): void {
    // aria-disabled 而不是 disabled：握著焦點的按鈕被停用時，Chromium 會把焦點丟到 body。
    if (refresh.isPending) return;
    refresh.mutate(identityId, {
      onSuccess: () => {
        toast({ title: t("settings.account.avatar.changed") });
        setFocusAfterRefresh(identityId);
      },
      onError: err => {
        if (err instanceof ApiFail && err.status === 404) {
          // 身分剛被解除連結：重抓清單，那顆按鈕會消失，焦點交給選中的那格；不彈錯誤。
          void refetchList().then(() => setFocusAfterRefresh(identityId));
          return;
        }
        reportRefreshFailure(t, err, provider);
      },
    });
  }

  /** 候選右下角的登入服務圖示：用候選的顯示名對到目前啟用中的服務；解除連結（`providerName` 為 null）或對不到就不疊。 */
  function sourceIcon(candidate: AvatarCandidateDto) {
    if (candidate.source !== "oidc" || candidate.providerName === null) return undefined;
    return identities.data?.identities.flatMap(identity => identity.providers).find(p => p.displayName === candidate.providerName)?.icon ?? undefined;
  }

  function onRadioKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const last = cells.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = Math.min(index + 1, last);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = Math.max(index - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    setFocusIndex(next);
    radios.current[next]?.focus();
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    // 清掉選取：同一個檔案被取消後再選一次，change 才會再觸發。
    event.target.value = "";
    if (file === undefined) return;
    if (maxUploadBytes !== undefined && file.size > maxUploadBytes) {
      setSizeError(t("settings.account.avatar.tooLarge", { size: formatBytes(maxUploadBytes) }));
      return;
    }
    setSizeError(null);
    setCropSource({ kind: "new", file });
  }

  function confirmDelete(candidate: AvatarCandidateDto): void {
    const index = cells.findIndex(cell => cell.candidate?.id === candidate.id);
    remove.mutate(candidate.id, {
      onSuccess: () => {
        setFocusAfterDelete({ id: candidate.id, index });
        toast({ title: candidate.current ? t("settings.account.avatar.deletedCurrent") : t("settings.account.avatar.deleted") });
      },
      onError: err => reportFailure(t, err, refetchList),
      onSettled: () => setDeleting(null),
    });
  }

  return (
    <SettingsGroup title={t("settings.account.avatar.title")} description={t("settings.account.avatar.description")}>
      <div className="flex items-center gap-4">
        <Avatar name={displayName} avatar={previewRef} size={64} offsetColor="var(--color-background)" />
        <Button ref={uploadButton} type="button" variant="outline" onClick={() => fileInput.current?.click()}>
          {t("settings.account.avatar.upload")}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          data-testid="avatar-file-input"
          onChange={onFileChange}
        />
      </div>
      {sizeError !== null && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {sizeError}
        </p>
      )}

      {list.isPending && <p className="mt-4 text-sm text-muted-foreground">{t("settings.account.avatar.loading")}</p>}
      {list.isError && (
        <div className="mt-4 flex items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {t("settings.account.avatar.loadFailed")}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void list.refetch()}>
            {t("app.retry")}
          </Button>
        </div>
      )}
      {list.data !== undefined && (
        <>
          <div className="group/avatarcell mt-4 grid">
            <div role="radiogroup"
              aria-label={t("settings.account.avatar.listLabel")}
              className={cn(CELL_GRID, "col-start-1 row-start-1")}
              onBlur={event => {
                // 焦點離開群組：Tab 停點回到選中的那格（群組內移動不算）。
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusIndex(null);
              }}
            >
              {cells.map((cell, index) => {
                const checked = index === checkedIndex;
                const label = cell.candidate === null ? t("settings.account.avatar.none") : candidateLabel(t, i18n.language, cell.candidate);
                const icon = cell.candidate === null ? undefined : sourceIcon(cell.candidate);
                const noSpace = cell.candidate !== null && noSpaceKeys.includes(cell.candidate.id);
                return (
                  <button
                    key={cell.candidate?.id ?? "none"}
                    ref={node => {
                      radios.current[index] = node;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-label={label}
                    title={label}
                    aria-describedby={noSpace ? noSpaceId : undefined}
                    tabIndex={index === rovingIndex ? 0 : -1}
                    onClick={() => choose(cell, index)}
                    onKeyDown={event => onRadioKeyDown(event, index)}
                    className="relative flex h-14 w-14 items-center justify-center justify-self-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <Avatar
                      name={displayName}
                      avatar={cell.candidate === null ? null : cell.candidate.avatar}
                      size={48}
                      ringColor={checked ? "var(--color-brand)" : undefined}
                      offsetColor="var(--color-background)"
                    />
                    {icon != null && (
                      <span
                        aria-hidden="true"
                        data-testid="avatar-source-icon"
                        className="absolute bottom-0 left-0 flex h-4 w-4 items-center justify-center rounded-full bg-background ring-1 ring-border"
                      >
                        <ProviderIcon icon={icon} className="h-3 w-3" />
                      </span>
                    )}
                    {checked && (
                      <span
                        aria-hidden="true"
                        className="absolute bottom-0 right-0 flex h-4 w-4 items-center justify-center rounded-full bg-brand text-brand-fg"
                      >
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className={cn(CELL_GRID, "pointer-events-none col-start-1 row-start-1")}>
              {cells.map(cell => {
                if (cell.candidate === null) return <span key="none" aria-hidden="true" />;
                const candidate = cell.candidate;
                return (
                  <CandidateMenu
                    key={candidate.id}
                    label={candidateLabel(t, i18n.language, candidate)}
                    onRecrop={() => setCropSource({ kind: "existing", candidate })}
                    onDelete={() => setDeleting(candidate)}
                  />
                );
              })}
            </div>
          </div>
          {candidates.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t("settings.account.avatar.empty")}</p>}
          {noSpaceKeys.length > 0 && (
            <p id={noSpaceId} className="mt-2 text-sm text-muted-foreground">
              {t("settings.account.avatar.noSpace")}
            </p>
          )}
          {list.data.refreshable.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {list.data.refreshable.map(r => (
                <Button
                  key={r.identityId}
                  ref={node => {
                    if (node === null) refreshButtons.current.delete(r.identityId);
                    else refreshButtons.current.set(r.identityId, node);
                  }}
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-disabled={refresh.isPending || undefined}
                  className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                  onClick={() => refreshFrom(r.identityId, r.providerName)}
                >
                  {t("settings.account.avatar.useProvider", { provider: r.providerName })}
                </Button>
              ))}
            </div>
          )}
        </>
      )}
      <p className="mt-4 text-sm text-muted-foreground">{t("settings.account.avatar.usage")}</p>

      {cropSource !== null && (
        <Suspense fallback={null}>
          <AvatarCropDialog
            open
            source={cropSource}
            onOpenChange={open => {
              if (!open) setCropSource(null);
            }}
            onSaved={() => undefined}
          />
        </Suspense>
      )}
      {deleting !== null && (
        <DeleteDialog
          candidate={deleting}
          label={candidateLabel(t, i18n.language, deleting)}
          pending={remove.isPending}
          onConfirm={() => confirmDelete(deleting)}
          onOpenChange={open => {
            if (!open) setDeleting(null);
          }}
        />
      )}
    </SettingsGroup>
  );
}
