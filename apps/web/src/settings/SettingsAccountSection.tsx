import { useState } from "react";
import { useTranslation } from "react-i18next";
import { normalizeHandle, validateHandle } from "@knotebook/shared";
import { ChangePasswordForm } from "@/auth/ChangePasswordForm";
import { useIdentities } from "@/api/account";
import { useUpdateHandle } from "@/api/profile";
import { useStorageUsage } from "@/api/storage";
import { ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useSession } from "@/auth/useSession";
import { ApiTokensSection } from "./ApiTokensSection";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import { SetPasswordForm } from "./SetPasswordForm";
import { SignInMethodsSection } from "./SignInMethodsSection";
import { StorageUsageGroup } from "./StorageUsageGroup";

/** 逐檔複製的既有慣例（無共用 helper——比照 ShareDialog/SettingsUsersSection）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * 使用者名（handle，#122）編輯段——**兩個帳號分支（有密碼／SSO-only）都渲染**
 * （plan gate M5：SSO 使用者正是 handle 派生自 preferred_username、最可能想改名的
 * 族群；原本的 hasPassword 早退分支已重構）。
 *
 * - 送出前在前端先 normalize＋validate（非法格式就地呈現、不打 API）；伺服器仍是
 *   最終裁決（409 handle_taken／429 額度）。
 * - 警語文案刻意含 `/n/`、`/p/` 網址形（PR2/3 緊隨，文案一次寫全——非 drift）。
 * - 成功後 useUpdateHandle 的 onSuccess 先 setQueryData 更新 session、再 invalidateQueries 全清（見 api/profile.ts 的取捨說明）。
 */
function HandleSection() {
  const { t } = useTranslation();
  const { user } = useSession();
  const updateHandle = useUpdateHandle();
  const [value, setValue] = useState<string | null>(null); // null＝未編輯，顯示現值
  const [error, setError] = useState<string | null>(null);

  const current = user?.handle ?? "";
  const shown = value ?? current;

  async function save(): Promise<void> {
    const normalized = normalizeHandle(shown.trim());
    if (validateHandle(normalized) !== null) {
      setError(t("settings.account.handleInvalid"));
      return;
    }
    setError(null);
    try {
      await updateHandle.mutateAsync({ handle: normalized });
      setValue(null); // 回「顯示現值」——onSuccess 已 setQueryData 寫入新 session，current 即新值（不靠重抓）
      toast({ title: t("settings.account.handleSaved") });
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <SettingsGroup
      title={t("settings.account.handleTitle")}
      description={t("settings.account.handleDescription")}
    >
      {/* form＋type=submit（讀碼審查 m3）：單欄位表單使用者必按 Enter——比照
          ShareDialog/ChangePasswordForm 的既有形 */}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Input
          value={shown}
          aria-label={t("settings.account.handleLabel")}
          onChange={(event) => setValue(event.target.value)}
          className="max-w-xs"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={updateHandle.isPending || shown.trim() === "" || normalizeHandle(shown.trim()) === current}
        >
          {t("settings.account.handleSave")}
        </Button>
      </form>
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </SettingsGroup>
  );
}

/**
 * 設定 modal 的帳號區（`/settings/account`，所有人可見；spec §13.4）——使用者名
 * 編輯段（#122，兩分支皆渲染）＋自助改密碼。改密成功後**只 toast、不導航**：
 * `navigate("/")` 會關掉 modal，甚至扯掉背景 `/notes/:ref` 的共編 provider，
 * 這裡刻意留在原地（對照 `ChangePasswordPage` 的強制模式 `onSuccess`）。
 *
 * 密碼群組三形（#187 §8.5）：
 * - `hasPassword === false`（OIDC 自動建帳、從未設過密碼；spec §14.4）＋帳密登入有效值開
 *   → 「加上密碼」表單（`SetPasswordForm`）；不渲染改密碼表單（打了也一定 `invalid_credentials`）。
 * - `hasPassword === false`＋有效值關（B22）→ 只有說明、沒有表單。
 * - 有密碼 → 改密碼表單；有效值關時多一句說明。
 * 使用者名段在三形都照常渲染；最後一組是儲存空間用量（spec §9.2；只顯示）。`hasPassword` 仍用 `=== false` 明確比對（而非 `!user.hasPassword`），
 * 讓「query 尚未就緒」（`undefined`）預設落在改密碼表單那條分支，不誤閃加密碼表單；
 * `passwordLoginEnabled` 同理以 `!== false` 預設為開（identities 尚未載入時不誤閃「關」說明）。
 *
 * `changePassword.title`/`.description` 只在有改密碼表單那個分支渲染（fix round 1 MINOR-2）。
 */
export function SettingsAccountSection() {
  const { t } = useTranslation();
  const { user } = useSession();
  const identities = useIdentities();
  const storage = useStorageUsage();
  const passwordLoginEnabled = identities.data?.passwordLoginEnabled !== false;

  return (
    <SettingsPage title={t("settings.nav.account")} description={t("settings.account.description")}>
      <HandleSection />
      <SignInMethodsSection />
      {/* #107：與 HandleSection 同層、在 hasPassword 三元式之外——SSO-only 帳號
          也要能建 PAT。 */}
      <ApiTokensSection />
      {user?.hasPassword === false ? (
        passwordLoginEnabled ? (
          <SettingsGroup title={t("settings.account.setPassword.title")} description={t("settings.account.setPassword.description")}>
            <SetPasswordForm onSuccess={() => toast({ title: t("settings.account.setPassword.success") })} />
          </SettingsGroup>
        ) : (
          // B22：有效值關時不給加密碼表單。
          <SettingsGroup>
            <p className="max-w-prose text-sm text-muted-foreground">{t("settings.account.setPassword.ssoOnlyNotice")}</p>
          </SettingsGroup>
        )
      ) : (
        <SettingsGroup title={t("changePassword.title")} description={t("changePassword.description")}>
          {!passwordLoginEnabled && <p className="mb-3 max-w-prose text-sm text-muted-foreground">{t("settings.account.passwordLoginOffNote")}</p>}
          {/* 設定 modal 內：tone="panel" → brandDeep（同一元件在 /change-password 整頁用預設 "page" → brandSolid） */}
          <ChangePasswordForm tone="panel" onSuccess={() => toast({ title: t("changePassword.successMessage") })} />
        </SettingsGroup>
      )}
      <StorageUsageGroup title={t("settings.account.storage")} query={storage} />
    </SettingsPage>
  );
}
