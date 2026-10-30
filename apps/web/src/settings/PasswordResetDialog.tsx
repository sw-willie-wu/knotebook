import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiFail } from "@/api/client";
import { useAuthConfig } from "@/api/authConfig";
import { useCancelPasswordReset, useCreatePasswordReset, type AdminUserDto } from "@/api/admin";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { KeyRound } from "@/components/ui/icons";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { OneTimeLinkResult } from "./OneTimeLinkResult";
import "@/i18n/management-strings";

/** 逐檔複製的既有慣例（同 SettingsUsersSection）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/** 與 `SettingsUsersSection` 的 `SELECT_CLASS` 同一份（各檔各自宣告是既有慣例，見 ApiTokensSection）。 */
const SELECT_CLASS =
  "h-8 shrink-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i + 1);

interface Created {
  token: string;
  expiresAt: string;
}

/**
 * 對話框內容：表單與結果兩階段。`useAuthConfig()` 只在這裡呼叫——Radix 關閉時會卸載它，
 * 所以使用者表每一列初次渲染不會各打一次 `/api/auth/config`。
 */
function PasswordResetDialogBody({
  row,
  hours,
  setHours,
  created,
  generation,
  onCreated,
  onFail,
  onError,
}: {
  row: AdminUserDto;
  hours: number;
  setHours: (hours: number) => void;
  created: Created | null;
  /** 送出當下的開啟代數；回呼帶回去，讓外層丟掉上一次開啟送出的結果。 */
  generation: () => number;
  onCreated: (generation: number, created: Created) => void;
  onFail: (generation: number, message: string) => void;
  onError: (message: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const authConfig = useAuthConfig();
  const create = useCreatePasswordReset();
  const cancel = useCancelPasswordReset();
  const passwordLoginOff = authConfig.data?.passwordLogin.enabled === false;

  if (created !== null) {
    return (
      <OneTimeLinkResult
        title={t("admin.passwordReset.createdTitle")}
        url={`${window.location.origin}/reset-password#token=${created.token}`}
        expiresAt={created.expiresAt}
      />
    );
  }

  const pendingWhen =
    row.passwordResetExpiresAt === null
      ? null
      : new Date(row.passwordResetExpiresAt).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    onError(null);
    const gen = generation();
    try {
      onCreated(gen, await create.mutateAsync({ userId: row.id, expiresInHours: hours }));
    } catch (err) {
      onFail(gen, errorMessage(t, err));
    }
  }

  async function handleCancel(): Promise<void> {
    onError(null);
    const gen = generation();
    try {
      await cancel.mutateAsync(row.id);
    } catch (err) {
      onFail(gen, errorMessage(t, err));
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{t("admin.passwordReset.title")}</DialogTitle>
        <DialogDescription>{t("admin.passwordReset.description", { email: row.email })}</DialogDescription>
      </DialogHeader>
      {passwordLoginOff && <p className="text-sm text-muted-foreground">{t("admin.passwordReset.passwordLoginOff")}</p>}
      {pendingWhen !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">
            {t(passwordLoginOff ? "admin.passwordReset.pendingSuspended" : "admin.passwordReset.pending", { when: pendingWhen })}
          </p>
          <Button type="button" variant="outline" size="sm" disabled={cancel.isPending || create.isPending} onClick={() => void handleCancel()}>
            {t("admin.passwordReset.cancelPending")}
          </Button>
        </div>
      )}
      <div className="space-y-1">
        <label htmlFor="admin-password-reset-hours" className="text-sm font-medium">
          {t("admin.passwordReset.expiresField")}
        </label>
        <div>
          <select
            id="admin-password-reset-hours"
            className={SELECT_CLASS}
            value={hours}
            onChange={(event) => setHours(Number(event.target.value))}
          >
            {HOUR_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {t("admin.passwordReset.hours", { count: n })}
              </option>
            ))}
          </select>
        </div>
      </div>
      <DialogFooter>
        <Button type="submit" variant="brandDeep" disabled={passwordLoginOff || create.isPending || cancel.isPending}>
          {create.isPending ? t("admin.passwordReset.submitting") : t("admin.passwordReset.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * 使用者表列內的「重設密碼」（#286）：沒有密碼的帳號不渲染（R4）；已停用的帳號 `softDisabled`（R3）。
 * 對話框關閉時本地狀態全部重設——產生的明文連結只活在這裡的 state 與結果畫面的 DOM。
 * 產生或取消失敗：關閉對話框、錯誤交給列錯誤（spec §5.1）。
 */
export function PasswordResetAction({ row, onError }: { row: AdminUserDto; onError: (message: string | null) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState(1);
  const [created, setCreated] = useState<Created | null>(null);
  // 每次開啟遞增的代數；關著時為 null。產生請求進行中關掉對話框：回應回來時已關著就丟棄，不寫進 state
  // （關閉後明文不留在記憶體）；關掉又重開：上一次開啟送出的結果（成功或失敗）都不碰這次的對話框。
  const generationRef = useRef(0);
  const openGenerationRef = useRef<number | null>(null);

  if (!row.hasPassword) return null;

  function reset(): void {
    setHours(1);
    setCreated(null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) generationRef.current += 1;
        openGenerationRef.current = next ? generationRef.current : null;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <RowIconButton
          label={t("admin.passwordReset.actionLabel", { email: row.email })}
          icon={<KeyRound className="h-4 w-4" />}
          softDisabled={row.disabledAt !== null}
          softDisabledReason={t("errors.user_disabled")}
        />
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
        <PasswordResetDialogBody
          row={row}
          hours={hours}
          setHours={setHours}
          created={created}
          generation={() => generationRef.current}
          onCreated={(gen, next) => {
            if (openGenerationRef.current === gen) setCreated(next);
          }}
          onFail={(gen, message) => {
            if (openGenerationRef.current !== null && openGenerationRef.current !== gen) return;
            openGenerationRef.current = null;
            setOpen(false);
            reset();
            onError(message);
          }}
          onError={onError}
        />
      </DialogContent>
    </Dialog>
  );
}
