import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { MIN_PASSWORD_LENGTH } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useSession } from "@/auth/useSession";
import {
  useAdminUsers,
  useCreateAdminUser,
  useDisableAdminUser,
  useEnableAdminUser,
  usePromoteAdminUser,
  type AdminUserDto,
} from "@/api/admin";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { toast } from "@/components/ui/toast";

/** ApiFail → errors.<code>；其餘 → errors.fallback。與 NoteList/ShareDialog 同一套對映
 * （各檔各自一份，是既有慣例——見那兩處的說明）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * 建立使用者 dialog。密碼長度在送出前先做客戶端 pre-validation
 * （`MIN_PASSWORD_LENGTH`，鏡射 server 端同名常數，與 `SetupPage` 同一套模式）——
 * 只是體驗優化，server 一樣會再驗一次（`password_too_short`），不能省。
 *
 * `isAdmin` 一律以明確布林值送出（勾選 true／未勾選 false），不因「false 是預設值」
 * 就省略欄位——讓送出的 body 對呼叫端（測試、未來的除錯）永遠可預期。
 */
function CreateUserDialog() {
  const { t } = useTranslation();
  const createUser = useCreateAdminUser();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetForm(): void {
    setEmail("");
    setPassword("");
    setDisplayName("");
    setIsAdmin(false);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t("errors.password_too_short"));
      return;
    }

    try {
      await createUser.mutateAsync({ email, password, displayName, isAdmin });
      resetForm();
      setOpen(false);
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetForm();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button">{t("admin.createUser")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.createUser")}</DialogTitle>
          <DialogDescription>{t("admin.createUserDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="admin-create-email" className="text-sm font-medium">
              {t("admin.email")}
            </label>
            <Input
              id="admin-create-email"
              type="email"
              autoComplete="off"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="admin-create-password" className="text-sm font-medium">
              {t("admin.password")}
            </label>
            <Input
              id="admin-create-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("admin.passwordHint")}</p>
          </div>

          <div className="space-y-1">
            <label htmlFor="admin-create-display-name" className="text-sm font-medium">
              {t("admin.displayName")}
            </label>
            <Input
              id="admin-create-display-name"
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              id="admin-create-is-admin"
              type="checkbox"
              checked={isAdmin}
              onChange={(event) => setIsAdmin(event.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            <label htmlFor="admin-create-is-admin" className="text-sm font-medium">
              {t("admin.isAdmin")}
            </label>
          </div>

          <p className="text-xs text-muted-foreground">{t("admin.mustChangePasswordNotice")}</p>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={createUser.isPending}>
              {createUser.isPending ? t("admin.creating") : t("admin.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 一列使用者的操作區：disable/enable 依 `disabledAt` 互斥（同一時間只會出現其中一顆），
 * promote 只在非 admin 時出現（已是 admin 不需要再升級）。
 *
 * disable 對自己那列（`user.id === currentUserId`）刻意整顆按鈕都不渲染——server 端
 * `cannot_disable_self` 反正會擋，但讓 UI 一開始就不給這個選項，體驗上更清楚（brief
 * 允許「隱藏或停用」擇一，這裡選隱藏）。enable/promote 沒有這個限制：對自己 promote
 * 沒有意義但無害，也不會發生（自己已經是 admin 才看得到這頁）；enable 只會出現在
 * disabled 的列，而 disable-self 已被擋下，自己不可能出現在 disabled 列。
 */
function UserActions({ user, currentUserId }: { user: AdminUserDto; currentUserId: string }) {
  const { t } = useTranslation();
  const disableUser = useDisableAdminUser();
  const enableUser = useEnableAdminUser();
  const promoteUser = usePromoteAdminUser();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const isDisabled = user.disabledAt !== null;
  const isSelf = user.id === currentUserId;

  async function handleDisableConfirm(): Promise<void> {
    try {
      await disableUser.mutateAsync(user.id);
      setConfirmOpen(false);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  async function handleEnable(): Promise<void> {
    try {
      await enableUser.mutateAsync(user.id);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  async function handlePromote(): Promise<void> {
    try {
      await promoteUser.mutateAsync(user.id);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <div className="flex items-center justify-end gap-2">
      {!user.isAdmin && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handlePromote()}
          disabled={promoteUser.isPending}
        >
          {t("admin.promote")}
        </Button>
      )}

      {isDisabled && (
        <Button type="button" variant="outline" size="sm" onClick={() => void handleEnable()} disabled={enableUser.isPending}>
          {t("admin.enable")}
        </Button>
      )}

      {!isDisabled && !isSelf && (
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="destructive" size="sm">
              {t("admin.disable")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("admin.disableTitle")}</DialogTitle>
              <DialogDescription>{t("admin.disableDescription", { email: user.email })}</DialogDescription>
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
                onClick={() => void handleDisableConfirm()}
                disabled={disableUser.isPending}
              >
                {t("admin.disable")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/**
 * Admin 使用者管理頁（`/admin/users`，掛在 `<RequireAdmin>` 底下——非 admin 一律
 * 導向 `/`，見 `App.tsx`）。`GET /api/admin/users` 三態（loading/error/empty）與
 * `NoteList` 同一套慣例。
 *
 * 包在 `<AppShell>` 裡（同 `HomePage`/`NotePage`）——不這樣做的話，從 `UserMenu`
 * 的「Manage users」點進來會整個丟失側欄（含 `UserMenu` 自己），只能靠瀏覽器上一頁
 * 才逃得出去，等於一條導覽死路（Task 15 review Important 2）。`AppShell` 本身已經
 * 是 `<main>`，這裡內容改用 `<div>` 包，避免巢狀兩層 `<main>`。
 */
export default function AdminUsersPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const usersQuery = useAdminUsers();
  const currentUserId = user?.id ?? "";

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-6 p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{t("admin.title")}</h1>
          <CreateUserDialog />
        </div>

        {usersQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : usersQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, usersQuery.error)}
          </p>
        ) : usersQuery.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin.empty")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 font-medium">{t("admin.tableEmail")}</th>
                <th className="py-2 font-medium">{t("admin.tableDisplayName")}</th>
                <th className="py-2 font-medium">{t("admin.tableRole")}</th>
                <th className="py-2 font-medium">{t("admin.tableStatus")}</th>
                <th className="py-2 font-medium text-right">{t("admin.tableActions")}</th>
              </tr>
            </thead>
            <tbody>
              {usersQuery.data.map((row) => (
                <tr key={row.id} className="border-b border-border">
                  <td className="py-2">{row.email}</td>
                  <td className="py-2">{row.displayName}</td>
                  <td className="py-2">{row.isAdmin ? t("admin.roleAdmin") : t("admin.roleUser")}</td>
                  <td className="py-2">{row.disabledAt ? t("admin.statusDisabled") : t("admin.statusActive")}</td>
                  <td className="py-2">
                    <UserActions user={row} currentUserId={currentUserId} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}
