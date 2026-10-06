import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AdminAuthProbeResultDto, AdminAuthProviderDto, AuthProviderTemplate } from "@knotebook/shared";
import { useCreateAuthProvider, useDiscoverAuthProvider, usePatchAuthProvider } from "@/api/adminAuth";
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
  function handleCopy(): void {
    void copyText(provider.callbackUrl).then(ok =>
      toast(ok ? { title: t("admin.auth.callbackCopied") } : { title: t("admin.auth.callbackCopyFailed"), variant: "destructive" }),
    );
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("admin.auth.steps.title")}</DialogTitle>
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
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<AdminAuthProviderDto | null>(null);

  function reset(): void {
    setTemplate("gitlab");
    setDisplayName(TEMPLATE_DEFAULTS.gitlab.displayName);
    setIssuerUrl(TEMPLATE_DEFAULTS.gitlab.issuerUrl);
    setClientId("");
    setClientSecret("");
    setProbe(null);
    setError(null);
    setCreated(null);
  }

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
    try {
      setProbe({ ok: true, result: await discover.mutateAsync(issuerUrl.trim()) });
    } catch (err) {
      setProbe({ ok: false, message: authErrorMessage(t, err) });
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      // secret 全空白＝不帶這個鍵（server 會 400；之後可用「編輯」補）。有內容就**原樣**送出——server 不 trim secret（IdP 給的就是那串），
      // web 也不 trim（gate r1-t8-12 Minor 3）。
      setCreated(await create.mutateAsync({ template, displayName, issuerUrl, clientId, ...(clientSecret.trim().length > 0 ? { clientSecret } : {}) }));
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
            <form onSubmit={event => void handleSubmit(event)} className="space-y-4">
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
                <Input id="auth-provider-display-name" required maxLength={40} value={displayName} onChange={event => setDisplayName(event.target.value)} />
              </div>
              <div className="space-y-1">
                <label htmlFor="auth-provider-issuer" className="text-sm font-medium">
                  {t("admin.auth.create.issuerUrl")}
                </label>
                <div className="flex gap-2">
                  <Input
                    id="auth-provider-issuer"
                    required
                    value={issuerUrl}
                    onChange={event => {
                      setIssuerUrl(event.target.value);
                      setProbe(null);
                    }}
                  />
                  <Button type="button" variant="outline" onClick={() => void handleCheck()} disabled={discover.isPending || issuerUrl.trim() === ""}>
                    {discover.isPending ? t("admin.auth.create.checking") : t("admin.auth.create.check")}
                  </Button>
                </div>
                <ProbeResult probe={probe} />
              </div>
              <div className="space-y-1">
                <label htmlFor="auth-provider-client-id" className="text-sm font-medium">
                  {t("admin.auth.create.clientId")}
                </label>
                <Input id="auth-provider-client-id" required value={clientId} onChange={event => setClientId(event.target.value)} />
              </div>
              <div className="space-y-1">
                <label htmlFor="auth-provider-client-secret" className="text-sm font-medium">
                  {t("admin.auth.create.clientSecret")}
                </label>
                <Input id="auth-provider-client-secret" type="password" autoComplete="off" value={clientSecret} onChange={event => setClientSecret(event.target.value)} />
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

/**
 * 編輯（§9.4）：secret **唯寫**——欄位永遠從空白開始、`hasSecret` 時以 placeholder 說明「已儲存、留空不變」；留空送出時
 * PATCH body **沒有** `clientSecret` 鍵（RF5；空字串 server 會 400，且「不改」與「清除」是兩件事、不提供清除）。
 * 表單每次都帶 issuer：值相同時 server 不清不停用（§5.2 的 CASE 比舊值），所以這裡只在**真的改了**才警示。
 */
export function EditProviderDialog({ provider }: { provider: AdminAuthProviderDto }) {
  const { t } = useTranslation();
  const patch = usePatchAuthProvider();
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState(provider.displayName);
  const [issuerUrl, setIssuerUrl] = useState(provider.issuerUrl);
  const [clientId, setClientId] = useState(provider.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [sortOrder, setSortOrder] = useState(String(provider.sortOrder));
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (next) {
      setDisplayName(provider.displayName);
      setIssuerUrl(provider.issuerUrl);
      setClientId(provider.clientId);
      setClientSecret("");
      setSortOrder(String(provider.sortOrder));
      setError(null);
    }
  }

  const issuerChanged = issuerUrl.trim() !== provider.issuerUrl;
  const secretEntered = clientSecret.trim().length > 0;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const order = Number(sortOrder);
    if (sortOrder.trim() === "" || !Number.isInteger(order) || order < 0) {
      setError(t("admin.auth.edit.sortOrderInvalid"));
      return;
    }
    try {
      const updated = await patch.mutateAsync({
        id: provider.id,
        body: { displayName, issuerUrl, clientId, sortOrder: order, ...(secretEntered ? { clientSecret } : {}) },
      });
      setOpen(false);
      if (provider.enabled && !updated.enabled) toast({ title: t("admin.auth.turnedOff") });
    } catch (err) {
      setError(authErrorMessage(t, err));
    }
  }

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
        </DialogHeader>
        <form onSubmit={event => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={`auth-provider-edit-name-${provider.id}`} className="text-sm font-medium">
              {t("admin.auth.create.displayName")}
            </label>
            <Input id={`auth-provider-edit-name-${provider.id}`} required maxLength={40} value={displayName} onChange={event => setDisplayName(event.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor={`auth-provider-edit-issuer-${provider.id}`} className="text-sm font-medium">
              {t("admin.auth.create.issuerUrl")}
            </label>
            <Input id={`auth-provider-edit-issuer-${provider.id}`} required value={issuerUrl} onChange={event => setIssuerUrl(event.target.value)} />
            {issuerChanged && (
              <p className="text-sm text-muted-foreground">
                {provider.hasSecret && !secretEntered ? t("admin.auth.edit.issuerChangeClearsSecret") : t("admin.auth.edit.issuerChangeTurnsOff")}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <label htmlFor={`auth-provider-edit-client-id-${provider.id}`} className="text-sm font-medium">
              {t("admin.auth.create.clientId")}
            </label>
            <Input id={`auth-provider-edit-client-id-${provider.id}`} required value={clientId} onChange={event => setClientId(event.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor={`auth-provider-edit-secret-${provider.id}`} className="text-sm font-medium">
              {t("admin.auth.create.clientSecret")}
            </label>
            <Input
              id={`auth-provider-edit-secret-${provider.id}`}
              type="password"
              autoComplete="off"
              placeholder={provider.hasSecret ? t("admin.auth.edit.secretPlaceholderSaved") : undefined}
              value={clientSecret}
              onChange={event => setClientSecret(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={`auth-provider-edit-order-${provider.id}`} className="text-sm font-medium">
              {t("admin.auth.edit.sortOrder")}
            </label>
            <Input id={`auth-provider-edit-order-${provider.id}`} inputMode="numeric" value={sortOrder} onChange={event => setSortOrder(event.target.value)} />
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
