import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AdminAuthProbeResultDto, AdminAuthProviderDto, AuthProviderTemplate } from "@knotebook/shared";
import { useCreateAuthProvider, useDiscoverAuthProvider, usePatchAuthProvider, type PatchAuthProviderBody } from "@/api/adminAuth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { authErrorMessage } from "./auth-error-message";

const SELECT_CLASS =
  "h-8 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** W1：範本只預填 issuer 與顯示名（GitLab 可改成自架網址）。Microsoft 不做（W17）。 */
const TEMPLATE_DEFAULTS: Record<AuthProviderTemplate, { displayName: string; issuerUrl: string }> = {
  gitlab: { displayName: "GitLab", issuerUrl: "https://gitlab.com" },
  google: { displayName: "Google", issuerUrl: "https://accounts.google.com" },
  oidc: { displayName: "", issuerUrl: "" },
};

/**
 * 欄位檢查，逐條對齊 server 的 `apps/server/src/auth/admin-provider-input.ts`（zod）——web 先擋、給欄位旁的具體錯誤，server 仍是權威。
 * 長度一律以 code point 計（`[...s].length`，同 server 與 0014 的 `char_length`）；不用 `<input maxLength>`（那是 UTF-16，emoji 算 2）。
 * issuer scheme 大小寫敏感（`HTTPS://` 被拒；`new URL` 會正規化掉大小寫，不能拿它判 scheme）。回傳 i18n key（`admin.auth.validation.*`）或 null。
 */
const UNSTORABLE = /[\0]|\p{Surrogate}/u;
const ISSUER_SCHEME = /^https?:\/\//;
const MAX_DISPLAY_NAME_LENGTH = 40;
const MAX_ISSUER_LENGTH = 512;
const MAX_CLIENT_ID_LENGTH = 512;
const MAX_CLIENT_SECRET_LENGTH = 4096;
const MAX_SORT_ORDER = 100_000;
const codePoints = (s: string): number => [...s].length;

type FieldErrors = Partial<Record<"displayName" | "issuerUrl" | "clientId" | "clientSecret" | "sortOrder", string>>;

function checkDisplayName(raw: string): string | null {
  const s = raw.trim();
  if (UNSTORABLE.test(s)) return "unstorable";
  if (codePoints(s) === 0) return "displayNameRequired";
  if (codePoints(s) > MAX_DISPLAY_NAME_LENGTH) return "displayNameTooLong";
  return null;
}

function checkIssuerUrl(raw: string): string | null {
  const s = raw.trim();
  if (UNSTORABLE.test(s)) return "unstorable";
  if (!ISSUER_SCHEME.test(s)) return "issuerScheme";
  if (s.length > MAX_ISSUER_LENGTH) return "issuerTooLong";
  try {
    new URL(s);
  } catch {
    return "issuerInvalid";
  }
  return null;
}

function checkClientId(raw: string): string | null {
  const s = raw.trim();
  if (UNSTORABLE.test(s)) return "unstorable";
  if (codePoints(s) === 0) return "clientIdRequired";
  if (codePoints(s) > MAX_CLIENT_ID_LENGTH) return "clientIdTooLong";
  return null;
}

/** secret 不 trim、原樣送出；空字串＝不送（建立：之後用編輯補；編輯：不變更）。只有空白 → 錯誤（不默默丟掉）。 */
function checkClientSecret(s: string): string | null {
  if (s === "") return null;
  if (UNSTORABLE.test(s)) return "unstorable";
  if (s.trim().length === 0) return "secretBlank";
  if (s.length > MAX_CLIENT_SECRET_LENGTH) return "secretTooLong";
  return null;
}

function collectErrors(checks: Array<[keyof FieldErrors, string | null]>): FieldErrors {
  const errors: FieldErrors = {};
  for (const [field, key] of checks) if (key !== null) errors[field] = key;
  return errors;
}

/** 欄位旁的錯誤；`id` 給輸入框的 `aria-describedby`。 */
function FieldError({ id, errorKey }: { id: string; errorKey: string | undefined }) {
  const { t } = useTranslation();
  if (errorKey === undefined) return null;
  return (
    <p id={id} className="text-xs text-destructive">
      {errorKey === "sortOrderInvalid" ? t("admin.auth.edit.sortOrderInvalid") : t(`admin.auth.validation.${errorKey}`)}
    </p>
  );
}

/** 有錯時把輸入框標成 invalid 並指向錯誤文字。 */
function invalidProps(errorId: string, errorKey: string | undefined) {
  return errorKey === undefined ? {} : { "aria-invalid": true as const, "aria-describedby": errorId };
}

type ProbeState = { ok: true; result: AdminAuthProbeResultDto } | { ok: false; message: string } | null;

function ProbeResult({ probe }: { probe: ProbeState }) {
  const { t } = useTranslation();
  if (probe === null) return null;
  if (!probe.ok) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {probe.message}
      </p>
    );
  }
  return (
    <div role="status" className="space-y-1 text-xs">
      <p>{t("admin.auth.create.checkOk", { issuer: probe.result.issuer })}</p>
      {probe.result.warnings.map(warning => (
        <p key={warning} className="text-destructive">
          {t(`admin.auth.warnings.${warning}`)}
        </p>
      ))}
    </div>
  );
}

/** 建立後的設定步驟（§9.4）：貼回呼網址、scope、confidential＋client_secret_post、填 secret、測試、啟用。 */
function SetupSteps({ provider, onDone }: { provider: AdminAuthProviderDto; onDone: () => void }) {
  const { t } = useTranslation();
  const titleRef = useRef<HTMLHeadingElement>(null);
  // 送出鈕隨表單一起卸載、焦點會掉到 body；切到設定步驟時把焦點放到標題，螢幕閱讀器從這一步開始讀。
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  function handleCopy(): void {
    void copyText(provider.callbackUrl).then(ok =>
      toast(ok ? { title: t("admin.auth.callbackCopied") } : { title: t("admin.auth.callbackCopyFailed"), variant: "destructive" }),
    );
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
          {t("admin.auth.steps.title")}
        </DialogTitle>
        <DialogDescription>{t("admin.auth.steps.intro")}</DialogDescription>
      </DialogHeader>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          <p>{t("admin.auth.steps.callback")}</p>
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 break-all text-xs">{provider.callbackUrl}</code>
            <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
              {t("admin.auth.copyCallback")}
            </Button>
          </div>
        </li>
        <li>{t("admin.auth.steps.scopes")}</li>
        <li>{t("admin.auth.steps.client")}</li>
        {!provider.hasSecret && <li>{t("admin.auth.steps.secret")}</li>}
        <li>{t("admin.auth.steps.finish")}</li>
      </ol>
      <DialogFooter>
        <Button type="button" variant="brandDeep" onClick={onDone}>
          {t("admin.auth.steps.done")}
        </Button>
      </DialogFooter>
    </>
  );
}

export function CreateProviderDialog() {
  const { t } = useTranslation();
  const create = useCreateAuthProvider();
  const discover = useDiscoverAuthProvider();
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState<AuthProviderTemplate>("gitlab");
  const [displayName, setDisplayName] = useState(TEMPLATE_DEFAULTS.gitlab.displayName);
  const [issuerUrl, setIssuerUrl] = useState(TEMPLATE_DEFAULTS.gitlab.issuerUrl);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [probe, setProbe] = useState<ProbeState>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<AdminAuthProviderDto | null>(null);

  function reset(): void {
    setTemplate("gitlab");
    setDisplayName(TEMPLATE_DEFAULTS.gitlab.displayName);
    setIssuerUrl(TEMPLATE_DEFAULTS.gitlab.issuerUrl);
    setClientId("");
    setClientSecret("");
    setProbe(null);
    setFieldErrors({});
    setError(null);
    setCreated(null);
  }

  /** 任何關閉（取消、Esc、點外面、完成）都 reset——secret 不留在 state 裡等下次打開。 */
  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) reset();
  }

  function chooseTemplate(next: AuthProviderTemplate): void {
    setTemplate(next);
    setDisplayName(TEMPLATE_DEFAULTS[next].displayName);
    setIssuerUrl(TEMPLATE_DEFAULTS[next].issuerUrl);
    setProbe(null);
  }

  async function handleCheck(): Promise<void> {
    setProbe(null);
    const issuerError = checkIssuerUrl(issuerUrl);
    setFieldErrors(prev => ({ ...prev, issuerUrl: issuerError ?? undefined }));
    if (issuerError !== null) return;
    try {
      setProbe({ ok: true, result: await discover.mutateAsync(issuerUrl.trim()) });
    } catch (err) {
      setProbe({ ok: false, message: authErrorMessage(t, err) });
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const errors = collectErrors([
      ["displayName", checkDisplayName(displayName)],
      ["issuerUrl", checkIssuerUrl(issuerUrl)],
      ["clientId", checkClientId(clientId)],
      ["clientSecret", checkClientSecret(clientSecret)],
    ]);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    try {
      // secret 空字串＝不帶這個鍵（之後可用「編輯」補）；有內容就**原樣**送出——server 不 trim secret（IdP 給的就是那串），
      // web 也不 trim（gate r1-t8-12 Minor 3）。只有空白的已在上面擋成欄位錯誤（不默默丟掉）。
      setCreated(
        await create.mutateAsync({
          template,
          displayName: displayName.trim(),
          issuerUrl: issuerUrl.trim(),
          clientId: clientId.trim(),
          ...(clientSecret !== "" ? { clientSecret } : {}),
        }),
      );
      setClientSecret("");
    } catch (err) {
      setError(authErrorMessage(t, err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {t("admin.auth.create.button")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        {created !== null ? (
          <SetupSteps provider={created} onDone={() => handleOpenChange(false)} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("admin.auth.create.title")}</DialogTitle>
              <DialogDescription>{t("admin.auth.create.startsOff")}</DialogDescription>
            </DialogHeader>
            <form noValidate onSubmit={event => void handleSubmit(event)} className="space-y-4">
              <div className="space-y-1">
                <label htmlFor="auth-provider-template" className="text-sm font-medium">
                  {t("admin.auth.create.template")}
                </label>
                <select
                  id="auth-provider-template"
                  value={template}
                  onChange={event => chooseTemplate(event.target.value as AuthProviderTemplate)}
                  className={SELECT_CLASS}
                >
                  <option value="gitlab">{t("admin.auth.template.gitlab")}</option>
                  <option value="google">{t("admin.auth.template.google")}</option>
                  <option value="oidc">{t("admin.auth.template.oidc")}</option>
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="auth-provider-display-name" className="text-sm font-medium">
                  {t("admin.auth.create.displayName")}
                </label>
                <Input
                  id="auth-provider-display-name"
                  aria-required
                  value={displayName}
                  onChange={event => setDisplayName(event.target.value)}
                  {...invalidProps("auth-provider-display-name-error", fieldErrors.displayName)}
                />
                <FieldError id="auth-provider-display-name-error" errorKey={fieldErrors.displayName} />
              </div>
              <div className="space-y-1">
                <label htmlFor="auth-provider-issuer" className="text-sm font-medium">
                  {t("admin.auth.create.issuerUrl")}
                </label>
                <div className="flex gap-2">
                  <Input
                    id="auth-provider-issuer"
                    aria-required
                    value={issuerUrl}
                    onChange={event => {
                      setIssuerUrl(event.target.value);
                      setProbe(null);
                    }}
                    {...invalidProps("auth-provider-issuer-error", fieldErrors.issuerUrl)}
                  />
                  <Button type="button" variant="outline" onClick={() => void handleCheck()} disabled={discover.isPending || issuerUrl.trim() === ""}>
                    {discover.isPending ? t("admin.auth.create.checking") : t("admin.auth.create.check")}
                  </Button>
                </div>
                <FieldError id="auth-provider-issuer-error" errorKey={fieldErrors.issuerUrl} />
                <ProbeResult probe={probe} />
              </div>
              <div className="space-y-1">
                <label htmlFor="auth-provider-client-id" className="text-sm font-medium">
                  {t("admin.auth.create.clientId")}
                </label>
                <Input
                  id="auth-provider-client-id"
                  aria-required
                  value={clientId}
                  onChange={event => setClientId(event.target.value)}
                  {...invalidProps("auth-provider-client-id-error", fieldErrors.clientId)}
                />
                <FieldError id="auth-provider-client-id-error" errorKey={fieldErrors.clientId} />
              </div>
              <div className="space-y-1">
                <label htmlFor="auth-provider-client-secret" className="text-sm font-medium">
                  {t("admin.auth.create.clientSecret")}
                </label>
                <Input
                  id="auth-provider-client-secret"
                  type="password"
                  autoComplete="off"
                  value={clientSecret}
                  onChange={event => setClientSecret(event.target.value)}
                  {...invalidProps("auth-provider-client-secret-error", fieldErrors.clientSecret)}
                />
                <FieldError id="auth-provider-client-secret-error" errorKey={fieldErrors.clientSecret} />
              </div>
              {error !== null && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button type="submit" variant="brandDeep" disabled={create.isPending}>
                  {create.isPending ? t("admin.auth.create.submitting") : t("admin.auth.create.submit")}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 開 dialog 當下的欄位值——PATCH 只送與它不同的欄位（fix round 1 I1）。 */
interface EditBaseline {
  displayName: string;
  issuerUrl: string;
  clientId: string;
  sortOrder: number;
}

const baselineOf = (provider: AdminAuthProviderDto): EditBaseline => ({
  displayName: provider.displayName,
  issuerUrl: provider.issuerUrl,
  clientId: provider.clientId,
  sortOrder: provider.sortOrder,
});

/**
 * 編輯（§9.4）：secret **唯寫**——欄位永遠從空白開始、`hasSecret` 時以 placeholder 說明「已儲存、留空不變」；留空送出時
 * PATCH body **沒有** `clientSecret` 鍵（RF5；空字串 server 會 400，且「不改」與「清除」是兩件事、不提供清除）。
 * PATCH **只送改過的欄位**（與開 dialog 當下的值比）：沒碰 issuer 就不帶 issuer——否則另一位管理員剛改過 issuer 時，這邊帶著
 * 舊 issuer 送出會被 §5.2 的 CASE 當成「改 issuer」，把對方的 issuer 改回去、清掉對方剛存的 secret 並停用；也不留 from==to 的稽核行。
 * 什麼都沒改就不發請求、直接關閉。任何關閉都清掉 secret 欄。
 */
export function EditProviderDialog({ provider }: { provider: AdminAuthProviderDto }) {
  const { t } = useTranslation();
  const patch = usePatchAuthProvider();
  const [open, setOpen] = useState(false);
  const [baseline, setBaseline] = useState<EditBaseline>(() => baselineOf(provider));
  const [displayName, setDisplayName] = useState(provider.displayName);
  const [issuerUrl, setIssuerUrl] = useState(provider.issuerUrl);
  const [clientId, setClientId] = useState(provider.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [sortOrder, setSortOrder] = useState(String(provider.sortOrder));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    // 關閉（取消、Esc、點外面、成功送出）就清 secret——不留在 state 裡等下次打開；初值也是空，所以重開必為空。
    if (!next) setClientSecret("");
    if (next) {
      setBaseline(baselineOf(provider));
      setDisplayName(provider.displayName);
      setIssuerUrl(provider.issuerUrl);
      setClientId(provider.clientId);
      setSortOrder(String(provider.sortOrder));
      setFieldErrors({});
      setError(null);
    }
  }

  // 「有沒有改」一律拿**原始輸入**與 baseline 比（送出時才 trim）：env 匯入的 issuer 可能帶尾端空白，拿 trim 後的值比會讓
  // 什麼都沒動的存檔也送出 issuer → server 依 §5.2 清 secret 並停用。
  const issuerChanged = issuerUrl !== baseline.issuerUrl;
  const secretEntered = clientSecret !== "";
  // §5.2：改 issuer 會清 secret（除非同一次帶了新 secret）並停用；停用中的服務沒有「會停用」可說（fix round 1 Minor 2）。
  const issuerWarning = !issuerChanged
    ? null
    : provider.hasSecret && !secretEntered
      ? provider.enabled
        ? t("admin.auth.edit.issuerChangeClearsSecret")
        : t("admin.auth.edit.issuerChangeClearsSecretOnly")
      : provider.enabled
        ? t("admin.auth.edit.issuerChangeTurnsOff")
        : null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const orderText = sortOrder.trim();
    const order = Number(orderText);
    const errors = collectErrors([
      ["displayName", checkDisplayName(displayName)],
      ["issuerUrl", checkIssuerUrl(issuerUrl)],
      ["clientId", checkClientId(clientId)],
      ["clientSecret", checkClientSecret(clientSecret)],
      ["sortOrder", /^\d+$/.test(orderText) && order <= MAX_SORT_ORDER ? null : "sortOrderInvalid"],
    ]);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const body: PatchAuthProviderBody = {};
    if (displayName !== baseline.displayName) body.displayName = displayName.trim();
    if (issuerChanged) body.issuerUrl = issuerUrl.trim();
    if (clientId !== baseline.clientId) body.clientId = clientId.trim();
    if (order !== baseline.sortOrder) body.sortOrder = order;
    if (secretEntered) body.clientSecret = clientSecret;
    if (Object.keys(body).length === 0) {
      handleOpenChange(false);
      return;
    }
    try {
      const wasEnabled = provider.enabled;
      const updated = await patch.mutateAsync({ id: provider.id, body });
      handleOpenChange(false);
      if (wasEnabled && !updated.enabled) toast({ title: t("admin.auth.turnedOff") });
    } catch (err) {
      setError(authErrorMessage(t, err));
    }
  }

  const fieldId = (field: string): string => `auth-provider-edit-${field}-${provider.id}`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          {t("admin.auth.edit.button")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.auth.edit.title")}</DialogTitle>
          <DialogDescription>{t("admin.auth.edit.description")}</DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={event => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={fieldId("name")} className="text-sm font-medium">
              {t("admin.auth.create.displayName")}
            </label>
            <Input
              id={fieldId("name")}
              aria-required
              value={displayName}
              onChange={event => setDisplayName(event.target.value)}
              {...invalidProps(fieldId("name-error"), fieldErrors.displayName)}
            />
            <FieldError id={fieldId("name-error")} errorKey={fieldErrors.displayName} />
          </div>
          <div className="space-y-1">
            <label htmlFor={fieldId("issuer")} className="text-sm font-medium">
              {t("admin.auth.create.issuerUrl")}
            </label>
            <Input
              id={fieldId("issuer")}
              aria-required
              value={issuerUrl}
              onChange={event => setIssuerUrl(event.target.value)}
              {...invalidProps(fieldId("issuer-error"), fieldErrors.issuerUrl)}
            />
            <FieldError id={fieldId("issuer-error")} errorKey={fieldErrors.issuerUrl} />
            {issuerWarning !== null && <p className="text-sm text-muted-foreground">{issuerWarning}</p>}
          </div>
          <div className="space-y-1">
            <label htmlFor={fieldId("client-id")} className="text-sm font-medium">
              {t("admin.auth.create.clientId")}
            </label>
            <Input
              id={fieldId("client-id")}
              aria-required
              value={clientId}
              onChange={event => setClientId(event.target.value)}
              {...invalidProps(fieldId("client-id-error"), fieldErrors.clientId)}
            />
            <FieldError id={fieldId("client-id-error")} errorKey={fieldErrors.clientId} />
          </div>
          <div className="space-y-1">
            <label htmlFor={fieldId("secret")} className="text-sm font-medium">
              {t("admin.auth.create.clientSecret")}
            </label>
            <Input
              id={fieldId("secret")}
              type="password"
              autoComplete="off"
              placeholder={provider.hasSecret ? t("admin.auth.edit.secretPlaceholderSaved") : undefined}
              value={clientSecret}
              onChange={event => setClientSecret(event.target.value)}
              {...invalidProps(fieldId("secret-error"), fieldErrors.clientSecret)}
            />
            <FieldError id={fieldId("secret-error")} errorKey={fieldErrors.clientSecret} />
          </div>
          <div className="space-y-1">
            <label htmlFor={fieldId("order")} className="text-sm font-medium">
              {t("admin.auth.edit.sortOrder")}
            </label>
            <Input
              id={fieldId("order")}
              inputMode="numeric"
              value={sortOrder}
              onChange={event => setSortOrder(event.target.value)}
              {...invalidProps(fieldId("order-error"), fieldErrors.sortOrder)}
            />
            <FieldError id={fieldId("order-error")} errorKey={fieldErrors.sortOrder} />
          </div>
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" variant="brandDeep" disabled={patch.isPending}>
              {patch.isPending ? t("admin.auth.edit.saving") : t("admin.auth.edit.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
