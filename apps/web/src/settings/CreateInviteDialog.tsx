import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { MAX_INVITE_LABEL_LENGTH } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useAuthConfig } from "@/api/authConfig";
import { useCreateInvite } from "@/api/admin";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { OneTimeLinkResult } from "./OneTimeLinkResult";
import "@/i18n/management-strings";

/** 逐檔複製的既有慣例（同 PasswordResetDialog）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/** 與 `PasswordResetDialog` 的 `SELECT_CLASS` 同一份（各檔各自宣告是既有慣例，見 ApiTokensSection）。 */
const SELECT_CLASS =
  "h-8 shrink-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const DAY_OPTIONS = [1, 2, 3, 4, 5, 6, 7];

interface Created {
  token: string;
  expiresAt: string;
}

/**
 * 對話框內容：表單與結果兩階段。`useAuthConfig()` 與 `useCreateInvite()` 都只在這裡呼叫——Radix 關閉時會卸載它，
 * 所以頁首的觸發鈕初次渲染不會多打一次 `/api/auth/config`，重開也不會繼承上一次的 pending 狀態。
 */
function CreateInviteDialogBody({
  days,
  setDays,
  label,
  setLabel,
  labelError,
  setLabelError,
  error,
  setError,
  created,
  generation,
  onCreated,
  onFail,
}: {
  days: number;
  setDays: (days: number) => void;
  label: string;
  setLabel: (label: string) => void;
  labelError: boolean;
  setLabelError: (labelError: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
  created: Created | null;
  /** 送出當下的開啟代數；回呼帶回去，讓外層丟掉上一次開啟送出的結果。 */
  generation: () => number;
  onCreated: (generation: number, created: Created) => void;
  onFail: (generation: number, message: string) => void;
}) {
  const { t } = useTranslation();
  const authConfig = useAuthConfig();
  const create = useCreateInvite();
  const passwordLoginOff = authConfig.data?.passwordLogin.enabled === false;

  if (created !== null) {
    return (
      <OneTimeLinkResult
        title={t("admin.invites.createdTitle")}
        url={`${window.location.origin}/register#invite=${created.token}`}
        expiresAt={created.expiresAt}
      />
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if ([...label.trim()].length > MAX_INVITE_LABEL_LENGTH) {
      setLabelError(true);
      return;
    }
    setLabelError(false);
    const gen = generation();
    try {
      // trim 由 server 做；這裡只決定帶不帶（trim 後為空就不帶）。
      const res = await create.mutateAsync({ expiresInDays: days, label: label.trim() === "" ? "" : label });
      onCreated(gen, { token: res.token, expiresAt: res.invite.expiresAt });
    } catch (err) {
      onFail(gen, errorMessage(t, err));
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{t("admin.invites.createTitle")}</DialogTitle>
        <DialogDescription>{t("admin.invites.createDescription")}</DialogDescription>
      </DialogHeader>
      {passwordLoginOff && <p className="text-sm text-muted-foreground">{t("admin.invites.passwordLoginOff")}</p>}
      <div className="space-y-1">
        <label htmlFor="admin-invite-days" className="text-sm font-medium">
          {t("admin.invites.expiresField")}
        </label>
        <div>
          <select id="admin-invite-days" className={SELECT_CLASS} value={days} onChange={(event) => setDays(Number(event.target.value))}>
            {DAY_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {t("admin.invites.days", { count: n })}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-1">
        <label htmlFor="admin-invite-label" className="text-sm font-medium">
          {t("admin.invites.labelField")}
        </label>
        <Input
          id="admin-invite-label"
          autoComplete="off"
          aria-describedby="admin-invite-label-hint"
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
            setLabelError(false);
          }}
        />
        <p id="admin-invite-label-hint" className="text-xs text-muted-foreground">
          {t("admin.invites.labelHint")}
        </p>
        {labelError && (
          <p role="alert" className="text-sm text-destructive">
            {t("admin.invites.labelTooLong")}
          </p>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" variant="brandDeep" disabled={passwordLoginOff || create.isPending}>
          {create.isPending ? t("admin.invites.submitting") : t("admin.invites.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * 頁首的「建立邀請」（#285）。對話框關閉時本地狀態全部重設——產生的明文 token 只活在這裡的 state 與結果畫面的 DOM。
 * 送出後關掉（或關掉再重開）對話框：回應回來時開啟代數已變就丟棄，明文與舊錯誤都不回到畫面（形同 `PasswordResetAction`）。
 */
export function CreateInviteDialog() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(3);
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  // 每次開啟／關閉遞增；送出時記下當下的值，回應回來不相符就丟棄。
  const generationRef = useRef(0);

  function reset(): void {
    setDays(3);
    setLabel("");
    setLabelError(false);
    setError(null);
    setCreated(null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        generationRef.current += 1;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          {t("admin.invites.create")}
        </Button>
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
        <CreateInviteDialogBody
          days={days}
          setDays={setDays}
          label={label}
          setLabel={setLabel}
          labelError={labelError}
          setLabelError={setLabelError}
          error={error}
          setError={setError}
          created={created}
          generation={() => generationRef.current}
          onCreated={(gen, next) => {
            if (generationRef.current === gen) setCreated(next);
          }}
          onFail={(gen, message) => {
            if (generationRef.current === gen) setError(message);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
