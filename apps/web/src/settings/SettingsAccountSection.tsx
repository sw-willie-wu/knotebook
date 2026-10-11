import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_REGISTER_DISPLAY_NAME_LENGTH, normalizeHandle, validateHandle } from "@knotebook/shared";
import { useUpdateDisplayName, useUpdateHandle } from "@/api/profile";
import { ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useSession } from "@/auth/useSession";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";

/** 逐檔複製的既有慣例（無共用 helper——比照 ShareDialog/SettingsUsersSection）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * 顯示名稱（#247 §5.2、W19）：別人在分享面板、版本歷史、群組成員表看到的名字。與網址名稱分開兩個區塊。
 * 送出前 client 端只擋「trim 後空白」與「超過 100 個 code point」（`[...s].length`，不是 `.length`——
 * emoji 一個字佔兩個 UTF-16 單位）；其餘（NUL、落單代理）交給 server 400 `invalid_body`。
 */
function DisplayNameSection() {
  const { t } = useTranslation();
  const { user } = useSession();
  const update = useUpdateDisplayName();
  const [value, setValue] = useState<string | null>(null); // null＝未編輯，顯示現值
  const [error, setError] = useState<string | null>(null);

  const current = user?.displayName ?? "";
  const shown = value ?? current;
  const trimmed = shown.trim();

  async function save(): Promise<void> {
    if (trimmed === "" || [...trimmed].length > MAX_REGISTER_DISPLAY_NAME_LENGTH) {
      setError(t("settings.account.displayName.invalid"));
      return;
    }
    setError(null);
    try {
      await update.mutateAsync({ displayName: trimmed });
      setValue(null);
      toast({ title: t("settings.account.displayName.saved") });
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <SettingsGroup title={t("settings.account.displayName.title")} description={t("settings.account.displayName.description")}>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Input
          value={shown}
          aria-label={t("settings.account.displayName.label")}
          onChange={(event) => setValue(event.target.value)}
          className="max-w-xs"
        />
        <Button type="submit" variant="outline" disabled={update.isPending || trimmed === "" || trimmed === current}>
          {t("settings.account.displayName.save")}
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
 * 網址名稱（handle，#122；#247 起 UI 稱『網址名稱』）編輯段——**兩個帳號分支（有密碼／SSO-only）都渲染**
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
 * 個人設定「帳戶資訊」（`/settings/account`，#247 §5.2、W19）：顯示名稱與網址名稱兩區塊。密碼與已連結登入方式
 * 在「登入」頁、API token 在「授權」頁、用量與自動版本在「儲存空間」頁。
 */
export function SettingsAccountSection() {
  const { t } = useTranslation();
  return (
    <SettingsPage title={t("settings.nav.account")} description={t("settings.account.description")}>
      <DisplayNameSection />
      <HandleSection />
    </SettingsPage>
  );
}
