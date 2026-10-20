import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { MIN_PASSWORD_LENGTH, ONLINE_WINDOW_MS } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useAuthConfig } from "@/api/authConfig";
import { useSession } from "@/auth/useSession";
import {
  useAdminUsers,
  useCreateAdminUser,
  useDemoteAdminUser,
  useDisableAdminUser,
  useEnableAdminUser,
  usePromoteAdminUser,
  useAssignUserPlan,
  type AdminUserDto,
} from "@/api/admin";
import { useAdminStoragePlans } from "@/api/adminStorage";
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import { PasswordResetAction } from "./PasswordResetDialog";
import { PlanSelect, StorageCell } from "./StorageAdminCells";

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
 * （`MIN_PASSWORD_LENGTH`，鏡射 server 端同名常數，與 `ChangePasswordForm` 同一套模式）——
 * 只是體驗優化，server 一樣會再驗一次（`password_too_short`），不能省。
 *
 * `isAdmin` 一律以明確布林值送出（勾選 true／未勾選 false），不因「false 是預設值」
 * 就省略欄位——讓送出的 body 對呼叫端（測試、未來的除錯）永遠可預期。
 */
function CreateUserDialog() {
  const { t } = useTranslation();
  const createUser = useCreateAdminUser();
  const authConfig = useAuthConfig();
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
        <Button type="button" variant="outline">{t("admin.createUser")}</Button>
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
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
            <p className="text-xs text-muted-foreground">{t("admin.passwordHint", { min: MIN_PASSWORD_LENGTH })}</p>
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
            <Checkbox
              id="admin-create-is-admin"
              checked={isAdmin}
              onCheckedChange={(checked) => setIsAdmin(checked === true)}
            />
            <label htmlFor="admin-create-is-admin" className="text-sm font-medium">
              {t("admin.isAdmin")}
            </label>
          </div>

          <p className="text-xs text-muted-foreground">{t("admin.mustChangePasswordNotice")}</p>
          {authConfig.data?.passwordLogin.enabled === false && (
            // §9.5 表末列：關閉期間代建照常（仍要臨時密碼），但它只用於對方首次 SSO 登入時在連結頁證明本人。
            <p className="text-xs text-muted-foreground">{t("admin.passwordLoginOffNotice")}</p>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" variant="brandDeep" disabled={createUser.isPending}>
              {createUser.isPending ? t("admin.creating") : t("admin.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * #267「最後活動」欄：`now - lastActiveAt` 小於 `ONLINE_WINDOW_MS` →「上線中」（server 至多每 `LAST_ACTIVE_WRITE_INTERVAL_MS` 記一次，
 * 遠短於視窗，持續有活動的人不會掉出來）；更早 → 日期＋時間（與版本面板 `formatVersionTime` 同格式：dateStyle／timeStyle short）；
 * null（從無紀錄）→「尚無紀錄」。`now` 取瀏覽器時鐘、在 render 當下算；沒有計時器重算，停在畫面上的「上線中」要等下次 render（例如列表重新取得）才會變。
 */
function lastActiveLabel(lastActiveAt: string | null, t: (key: string) => string, language: string): string {
  if (lastActiveAt === null) return t("admin.users.lastActiveNone");
  const at = new Date(lastActiveAt);
  if (Date.now() - at.getTime() < ONLINE_WINDOW_MS) return t("admin.users.online");
  return at.toLocaleString(language, { dateStyle: "short", timeStyle: "short" });
}

const SELECT_CLASS =
  "h-8 shrink-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * 角色下拉（#247 §7.0，W27：管理員／一般；升級送 `promote`、降級送 `demote`）。
 * 自己那列 disabled＋`title`（server 另以 400 `cannot_demote_self` 把關）；pending 時 disabled 並顯示剛選的值；
 * 失敗（含 409 `last_site_admin`）下拉自然留在原值（受控於列資料），錯誤交給上層的錯誤列（spec 2026-10-13 settings-table §2.5 末）。
 */
function UserRoleSelect({ row, isSelf, onError }: { row: AdminUserDto; isSelf: boolean; onError: (message: string | null) => void }) {
  const { t } = useTranslation();
  const promote = usePromoteAdminUser();
  const demote = useDemoteAdminUser();
  const [pickedRole, setPickedRole] = useState<"admin" | "user" | null>(null);
  const rolePending = promote.isPending || demote.isPending;
  const roleValue = rolePending && pickedRole !== null ? pickedRole : row.isAdmin ? "admin" : "user";

  async function handleRole(next: "admin" | "user"): Promise<void> {
    if (isSelf || rolePending || next === (row.isAdmin ? "admin" : "user")) return;
    onError(null);
    setPickedRole(next);
    try {
      await (next === "admin" ? promote : demote).mutateAsync(row.id);
    } catch (err) {
      onError(errorMessage(t, err));
    } finally {
      setPickedRole(null);
    }
  }

  return (
    <select
      aria-label={t("admin.users.roleFor", { email: row.email })}
      value={roleValue}
      disabled={isSelf || rolePending}
      title={isSelf ? t("errors.cannot_demote_self") : undefined}
      onChange={(event) => void handleRole(event.target.value as "admin" | "user")}
      className={SELECT_CLASS}
    >
      <option value="admin">{t("admin.roleAdmin")}</option>
      <option value="user">{t("admin.roleUser")}</option>
    </select>
  );
}

/**
 * 啟用 toggle（#247 §7.0）：關 → 先開確認框（停用會踢掉線上 session）、確認才送 `disable`；開 → 直接送 `enable`。
 * 自己那列照常渲染、恆為開，但 `aria-disabled`＋`title`、不送請求；server 的 `cannot_disable_self` 照舊是最後防線。
 * 失敗：toggle 受控於列資料、自然彈回，錯誤交給上層的錯誤列。可及名稱「Enabled ＜email＞」由表格的 aria-labelledby 給。
 */
function UserEnabledSwitch({
  row,
  isSelf,
  labelledBy,
  onError,
}: {
  row: AdminUserDto;
  isSelf: boolean;
  labelledBy: string;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const disableUser = useDisableAdminUser();
  const enableUser = useEnableAdminUser();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const enabled = row.disabledAt === null;

  async function handleEnabled(next: boolean): Promise<void> {
    if (isSelf) return;
    onError(null);
    if (!next) {
      setConfirmOpen(true);
      return;
    }
    try {
      await enableUser.mutateAsync(row.id);
    } catch (err) {
      onError(errorMessage(t, err));
    }
  }

  async function handleDisableConfirm(): Promise<void> {
    try {
      await disableUser.mutateAsync(row.id);
      setConfirmOpen(false);
    } catch (err) {
      setConfirmOpen(false);
      onError(errorMessage(t, err));
    }
  }

  return (
    <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <Switch
        aria-labelledby={labelledBy}
        checked={isSelf ? true : enabled}
        aria-disabled={isSelf || undefined}
        title={isSelf ? t("errors.cannot_disable_self") : undefined}
        className={isSelf ? "cursor-not-allowed opacity-50" : undefined}
        disabled={!isSelf && (enableUser.isPending || disableUser.isPending)}
        onCheckedChange={(next) => void handleEnabled(next)}
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.disableTitle")}</DialogTitle>
          <DialogDescription>{t("admin.disableDescription", { email: row.email })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={() => void handleDisableConfirm()} disabled={disableUser.isPending}>
            {t("admin.disable")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 站台管理 modal 的使用者區（`/admin/users`，#247 §7.0）。歷程：Task 15 獨立頁 → Plan 4 併進設定 modal →
 * 2026-09-30 獨立頁 `/admin/*` → #247 起是站台管理 modal 的第一項（`AdminSections` 聚合 chunk）。
 * 頁首的「建立使用者」是面板層級動作，`outline`（§4.8）；它開出的對話框內送出鈕照舊 `brandDeep`。
 *
 * 使用者表（spec 2026-10-13 settings-table §3 #5）：使用者（名稱、@handle 副標）｜Email｜儲存｜最後活動（#267 的渲染原樣沿用）｜角色｜方案｜操作（重設密碼鈕，#286）｜啟用；
 * 列名與開關名稱都用 email（`nameColumn`）。角色變更與啟用切換的錯誤走錯誤列，狀態以使用者 id 為鍵存在這裡。
 * - 方案下拉即存、失敗 toast（spec §9.3，`PlanSelect`）；停權者照樣可改（S13）。
 * - 標題列的建立鈕走 `SettingsPage` 的 `action` 插槽（見 `SettingsLayout.tsx`）。
 */
export function SettingsUsersSection() {
  const { t, i18n } = useTranslation();
  const { user } = useSession();
  const usersQuery = useAdminUsers();
  const plansQuery = useAdminStoragePlans();
  const assignPlan = useAssignUserPlan();
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const currentUserId = user?.id ?? "";

  function setRowError(id: string, message: string | null): void {
    setRowErrors((prev) => {
      const next = { ...prev };
      if (message === null) delete next[id];
      else next[id] = message;
      return next;
    });
  }

  const columns: SettingsTableColumn[] = [
    { id: "user", header: t("admin.users.user"), kind: "primary", grow: 1 },
    { id: "email", header: t("admin.tableEmail"), kind: "text", grow: 1.5 },
    { id: "storage", header: t("admin.tableStorage"), kind: "fixed" },
    // #267 的表頭 key，逐字沿用
    { id: "lastActive", header: t("admin.users.lastActive"), kind: "fixed" },
    { id: "role", header: t("admin.tableRole"), kind: "control" },
    { id: "plan", header: t("admin.tablePlan"), kind: "control" },
    { id: "actions", header: t("admin.users.tableActions"), kind: "actions", buttons: 1 },
    { id: "enabled", header: t("admin.users.enabled"), kind: "enabled" },
  ];
  const rows: SettingsTableRow[] = (usersQuery.data ?? []).map((row) => {
    const isSelf = row.id === currentUserId;
    return {
      id: row.id,
      primary: { name: row.displayName, subtitles: [`@${row.handle}`] },
      cells: {
        email: row.email,
        storage: <StorageCell storage={row.storage} />,
        // #267 的最後活動渲染式，逐字沿用——判斷與格式都是 #267 的，本線不改
        lastActive: lastActiveLabel(row.lastActiveAt, t, i18n.language),
        role: <UserRoleSelect row={row} isSelf={isSelf} onError={(message) => setRowError(row.id, message)} />,
        plan: (
          <PlanSelect
            label={t("admin.planFor", { email: row.email })}
            planId={row.storage.planId}
            planName={row.storage.planName}
            plans={plansQuery.data?.plans}
            onAssign={(planId) => assignPlan.mutateAsync({ userId: row.id, planId })}
          />
        ),
      },
      // hasPassword 為假時元件回 null（R4），cell 照樣渲染
      actions: <PasswordResetAction row={row} onError={(message) => setRowError(row.id, message)} />,
      enabled: (labelledBy) => (
        <UserEnabledSwitch row={row} isSelf={isSelf} labelledBy={labelledBy} onError={(message) => setRowError(row.id, message)} />
      ),
      error: rowErrors[row.id],
    };
  });

  return (
    <SettingsPage
      title={t("admin.title")}
      description={t("admin.description")}
      // 建立鈕改掛在頁首標題列。原本它自己一行右對齊浮在表格上方，既沒有跟標題
      // 成組、也沒有跟表格成組，是「項次都黏在一起」感覺的來源之一。
      action={<CreateUserDialog />}
    >
      <SettingsGroup>
        {usersQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : usersQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, usersQuery.error)}
          </p>
        ) : (
          <SettingsTable label={t("admin.nav.users")} nameColumn="email" columns={columns} rows={rows} empty={t("admin.empty")} />
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
