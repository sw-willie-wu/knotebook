import { useState } from "react";
import { useTranslation } from "react-i18next";
import { normalizeHandle, validateHandle } from "@knotebook/shared";
import { ChangePasswordForm } from "@/auth/ChangePasswordForm";
import { useUpdateHandle } from "@/api/profile";
import { ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useSession } from "@/auth/useSession";
import { ApiTokensSection } from "./ApiTokensSection";

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
    <div className="space-y-2">
      {/* h2：本區塊的 h1 讓給 changePassword 標題（每個 settings section 一個 h1 的
          既有層級慣例——SettingsAiSection/SettingsUsersSection 同形，讀碼審查 m1） */}
      <h2 className="text-lg font-semibold">{t("settings.account.handleTitle")}</h2>
      <p className="text-sm text-muted-foreground">{t("settings.account.handleDescription")}</p>
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
          size="sm"
          disabled={updateHandle.isPending || shown.trim() === "" || normalizeHandle(shown.trim()) === current}
        >
          {t("settings.account.handleSave")}
        </Button>
      </form>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * 設定 modal 的帳號區（`/settings/account`，所有人可見；spec §13.4）——使用者名
 * 編輯段（#122，兩分支皆渲染）＋自助改密碼。改密成功後**只 toast、不導航**：
 * `navigate("/")` 會關掉 modal，甚至扯掉背景 `/notes/:ref` 的共編 provider，
 * 這裡刻意留在原地（對照 `ChangePasswordPage` 的強制模式 `onSuccess`）。
 *
 * `user.hasPassword === false`（OIDC 自動建帳、從未設過密碼；spec §14.4）→
 * 不渲染改密碼表單（打了也一定 `invalid_credentials`，沒有意義），改渲染
 * `settings.account.ssoOnly` 提示——**但使用者名段照常渲染**（#122 起不再整段
 * 早退）。仍用 `=== false` 明確比對（而非 `!user.hasPassword`），讓「query 尚未
 * 就緒」（`undefined`）預設落在渲染表單那條分支，不誤閃 SSO 提示。
 *
 * `changePassword.title`/`.description` 只在有改密碼表單那個分支渲染——SSO-only
 * 使用者不該同時看到「Change your password」標題與 SSO 提示（fix round 1 MINOR-2）。
 */
export function SettingsAccountSection() {
  const { t } = useTranslation();
  const { user } = useSession();

  return (
    <div className="space-y-6">
      <HandleSection />
      {/* #107：與 HandleSection 同層、在 hasPassword 三元式之外——SSO-only 帳號
          也要能建 PAT。 */}
      <ApiTokensSection />
      {user?.hasPassword === false ? (
        <p className="text-sm text-muted-foreground">{t("settings.account.ssoOnly")}</p>
      ) : (
        <>
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">{t("changePassword.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("changePassword.description")}</p>
          </div>
          <ChangePasswordForm onSuccess={() => toast({ title: t("changePassword.successMessage") })} />
        </>
      )}
    </div>
  );
}
