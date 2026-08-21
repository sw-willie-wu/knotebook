import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AdminAiActionDto, AdminAiModelDto, AdminAiProviderDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import {
  useAdminAiActions,
  useAdminAiModels,
  useAdminAiProviders,
  useCreateAiAction,
  useCreateAiModel,
  useCreateAiProvider,
  useDeleteAiAction,
  useDeleteAiModel,
  useDeleteAiProvider,
  usePatchAiAction,
  usePatchAiModel,
  usePatchAiProvider,
  useTestAiProvider,
} from "@/api/adminAi";
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

/** ApiFail → errors.<code>；其餘 → errors.fallback。與 SettingsUsersSection/ShareDialog
 * 同一套對映（各檔各自一份，是既有慣例）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const TEXTAREA_CLASS =
  "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors " +
  "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/** provider type 決定 baseUrl 欄位的 placeholder（Task 4 審查交接）：anthropic 是官方
 * origin（不帶 `/v1`——`routes/admin-ai.ts` 測試連線端點自己拼 `${baseUrl}/v1/models`）；
 * openai_compatible 通常是本機/自架端點，`/v1` 是路徑的一部分（例如 ollama）。 */
function baseUrlPlaceholder(type: AdminAiProviderDto["type"]): string {
  return type === "anthropic" ? "https://api.anthropic.com" : "http://host:11434/v1";
}

// ═══════════════════════════════ providers ═══════════════════════════════

function CreateProviderDialog() {
  const { t } = useTranslation();
  const createProvider = useCreateAiProvider();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<AdminAiProviderDto["type"]>("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  function resetForm(): void {
    setName("");
    setType("anthropic");
    setBaseUrl("");
    setApiKey("");
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const trimmedKey = apiKey.trim();
    try {
      await createProvider.mutateAsync({
        name,
        type,
        baseUrl,
        ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : {}),
      });
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
        <Button type="button" size="sm">
          {t("settings.ai.addProvider")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.ai.addProvider")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="ai-provider-name" className="text-sm font-medium">
              {t("settings.ai.providerName")}
            </label>
            <Input id="ai-provider-name" required value={name} onChange={(event) => setName(event.target.value)} />
          </div>

          <div className="space-y-1">
            <label htmlFor="ai-provider-type" className="text-sm font-medium">
              {t("settings.ai.providerType")}
            </label>
            <select
              id="ai-provider-type"
              value={type}
              onChange={(event) => setType(event.target.value as AdminAiProviderDto["type"])}
              className={SELECT_CLASS}
            >
              <option value="anthropic">{t("settings.ai.providerTypeAnthropic")}</option>
              <option value="openai_compatible">{t("settings.ai.providerTypeOpenAiCompatible")}</option>
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="ai-provider-base-url" className="text-sm font-medium">
              {t("settings.ai.providerBaseUrl")}
            </label>
            <Input
              id="ai-provider-base-url"
              required
              placeholder={baseUrlPlaceholder(type)}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="ai-provider-api-key" className="text-sm font-medium">
              {t("settings.ai.apiKey")}
            </label>
            <Input
              id="ai-provider-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={createProvider.isPending}>
              {createProvider.isPending ? t("settings.ai.creating") : t("settings.ai.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 編輯 provider dialog——`apiKey` 唯寫：`hasKey===true` 時 placeholder 顯示
 * `settings.ai.keySet`（不回顯任何密文/明文片段，server 端從不 SELECT 密文本體給
 * 這支端點以外的任何回應，見 `routes/admin-ai.ts` 的 `providerListColumns` 說明）；
 * 欄位留空送出 → PATCH body **完全不含** `apiKey` 這個 key（不是送空字串——空字串
 * 會被 server 的 `z.string().min(1)` 拒絕，且語意上「不改」與「清空」是兩件事，
 * 這支表單不提供清空金鑰的功能）。
 */
function EditProviderDialog({ provider }: { provider: AdminAiProviderDto }) {
  const { t } = useTranslation();
  const patchProvider = usePatchAiProvider();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(provider.name);
  const [type, setType] = useState<AdminAiProviderDto["type"]>(provider.type);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (next) {
      setName(provider.name);
      setType(provider.type);
      setBaseUrl(provider.baseUrl);
      setApiKey("");
      setError(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const trimmedKey = apiKey.trim();
    try {
      await patchProvider.mutateAsync({
        id: provider.id,
        body: {
          name,
          type,
          baseUrl,
          ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : {}),
        },
      });
      setOpen(false);
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {t("settings.ai.edit")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.ai.editProvider")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={`ai-provider-edit-name-${provider.id}`} className="text-sm font-medium">
              {t("settings.ai.providerName")}
            </label>
            <Input
              id={`ai-provider-edit-name-${provider.id}`}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor={`ai-provider-edit-type-${provider.id}`} className="text-sm font-medium">
              {t("settings.ai.providerType")}
            </label>
            <select
              id={`ai-provider-edit-type-${provider.id}`}
              value={type}
              onChange={(event) => setType(event.target.value as AdminAiProviderDto["type"])}
              className={SELECT_CLASS}
            >
              <option value="anthropic">{t("settings.ai.providerTypeAnthropic")}</option>
              <option value="openai_compatible">{t("settings.ai.providerTypeOpenAiCompatible")}</option>
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor={`ai-provider-edit-base-url-${provider.id}`} className="text-sm font-medium">
              {t("settings.ai.providerBaseUrl")}
            </label>
            <Input
              id={`ai-provider-edit-base-url-${provider.id}`}
              required
              placeholder={baseUrlPlaceholder(type)}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            {/* issue #46：換網址會作廢既有金鑰。**事前**講——事後 toast 的話，使用者會先
                看到 provider 突然不能用，才知道發生了什麼。只在真的會發生時顯示：這個
                provider 有金鑰、網址真的被改了、而且這次沒有一併輸入新金鑰。 */}
            {provider.hasKey && baseUrl !== provider.baseUrl && apiKey.trim().length === 0 && (
              <p className="text-sm text-muted-foreground">{t("settings.ai.baseUrlChangeClearsKey")}</p>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor={`ai-provider-edit-api-key-${provider.id}`} className="text-sm font-medium">
              {t("settings.ai.apiKey")}
            </label>
            <Input
              id={`ai-provider-edit-api-key-${provider.id}`}
              type="password"
              autoComplete="off"
              placeholder={provider.hasKey ? t("settings.ai.keySet") : undefined}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={patchProvider.isPending}>
              {patchProvider.isPending ? t("settings.ai.saving") : t("settings.ai.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteProviderDialog({ provider }: { provider: AdminAiProviderDto }) {
  const { t } = useTranslation();
  const deleteProvider = useDeleteAiProvider();
  const [open, setOpen] = useState(false);

  async function handleConfirm(): Promise<void> {
    try {
      await deleteProvider.mutateAsync(provider.id);
      setOpen(false);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="destructive" size="sm">
          {t("settings.ai.delete")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.ai.deleteProviderTitle")}</DialogTitle>
          <DialogDescription>{t("settings.ai.deleteProviderDescription", { name: provider.name })}</DialogDescription>
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
            onClick={() => void handleConfirm()}
            disabled={deleteProvider.isPending}
          >
            {t("settings.ai.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ═══════════════════════════════ models ═══════════════════════════════

function CreateModelDialog({ providerId }: { providerId: string }) {
  const { t } = useTranslation();
  const createModel = useCreateAiModel();
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetForm(): void {
    setModelId("");
    setDisplayName("");
    setIsDefault(false);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await createModel.mutateAsync({ providerId, modelId, displayName, isDefault });
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
        <Button type="button" variant="outline" size="sm">
          {t("settings.ai.addModel")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.ai.addModel")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={`ai-model-id-${providerId}`} className="text-sm font-medium">
              {t("settings.ai.modelIdLabel")}
            </label>
            <Input
              id={`ai-model-id-${providerId}`}
              required
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor={`ai-model-display-name-${providerId}`} className="text-sm font-medium">
              {t("settings.ai.modelDisplayName")}
            </label>
            <Input
              id={`ai-model-display-name-${providerId}`}
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              id={`ai-model-is-default-${providerId}`}
              type="checkbox"
              checked={isDefault}
              onChange={(event) => setIsDefault(event.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            <label htmlFor={`ai-model-is-default-${providerId}`} className="text-sm font-medium">
              {t("settings.ai.modelIsDefault")}
            </label>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={createModel.isPending}>
              {createModel.isPending ? t("settings.ai.creating") : t("settings.ai.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditModelDialog({ model }: { model: AdminAiModelDto }) {
  const { t } = useTranslation();
  const patchModel = usePatchAiModel();
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState(model.modelId);
  const [displayName, setDisplayName] = useState(model.displayName);
  const [isDefault, setIsDefault] = useState(model.isDefault);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (next) {
      setModelId(model.modelId);
      setDisplayName(model.displayName);
      setIsDefault(model.isDefault);
      setError(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await patchModel.mutateAsync({ id: model.id, body: { modelId, displayName, isDefault } });
      setOpen(false);
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          {t("settings.ai.edit")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.ai.editModel")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={`ai-model-edit-id-${model.id}`} className="text-sm font-medium">
              {t("settings.ai.modelIdLabel")}
            </label>
            <Input
              id={`ai-model-edit-id-${model.id}`}
              required
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor={`ai-model-edit-display-name-${model.id}`} className="text-sm font-medium">
              {t("settings.ai.modelDisplayName")}
            </label>
            <Input
              id={`ai-model-edit-display-name-${model.id}`}
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              id={`ai-model-edit-is-default-${model.id}`}
              type="checkbox"
              checked={isDefault}
              onChange={(event) => setIsDefault(event.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            <label htmlFor={`ai-model-edit-is-default-${model.id}`} className="text-sm font-medium">
              {t("settings.ai.modelIsDefault")}
            </label>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={patchModel.isPending}>
              {patchModel.isPending ? t("settings.ai.saving") : t("settings.ai.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteModelDialog({ model }: { model: AdminAiModelDto }) {
  const { t } = useTranslation();
  const deleteModel = useDeleteAiModel();
  const [open, setOpen] = useState(false);

  async function handleConfirm(): Promise<void> {
    try {
      await deleteModel.mutateAsync(model.id);
      setOpen(false);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          {t("settings.ai.delete")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.ai.deleteModelTitle")}</DialogTitle>
          <DialogDescription>{t("settings.ai.deleteModelDescription", { name: model.displayName })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={() => void handleConfirm()} disabled={deleteModel.isPending}>
            {t("settings.ai.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 一列 model：displayName＋modelId、`isDefault` 星號徽章、`enabled` 開關、編輯／刪除。 */
function ModelRow({ model }: { model: AdminAiModelDto }) {
  const { t } = useTranslation();
  const patchModel = usePatchAiModel();

  async function handleToggleEnabled(next: boolean): Promise<void> {
    try {
      await patchModel.mutateAsync({ id: model.id, body: { enabled: next } });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <div className="min-w-0 flex-1">
        <span className="font-medium">{model.displayName}</span>
        {model.isDefault && (
          <span title={t("settings.ai.modelDefaultBadge")} aria-label={t("settings.ai.modelDefaultBadge")} className="ml-1">
            ★
          </span>
        )}
        <span className="ml-2 text-muted-foreground">{model.modelId}</span>
      </div>
      <div className="flex items-center gap-2">
        <input
          id={`model-enabled-${model.id}`}
          type="checkbox"
          checked={model.enabled}
          onChange={(event) => void handleToggleEnabled(event.target.checked)}
          disabled={patchModel.isPending}
          className="h-4 w-4 rounded border-input"
        />
        <label htmlFor={`model-enabled-${model.id}`} className="sr-only">
          {t("settings.ai.enabled")}
        </label>
        <EditModelDialog model={model} />
        <DeleteModelDialog model={model} />
      </div>
    </li>
  );
}

/** provider 卡片：name/type/baseUrl/enabled 開關/degraded 警示＋重輸提示/test 鈕/編輯/刪除，
 * 內嵌這個 provider 底下的 models 列表＋「新增 model」（spec §13.4）。 */
function ProviderCard({ provider, models }: { provider: AdminAiProviderDto; models: AdminAiModelDto[] }) {
  const { t } = useTranslation();
  const patchProvider = usePatchAiProvider();
  const testProvider = useTestAiProvider();
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function handleToggleEnabled(next: boolean): Promise<void> {
    try {
      await patchProvider.mutateAsync({ id: provider.id, body: { enabled: next } });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  async function handleTest(): Promise<void> {
    setTestResult(null);
    try {
      await testProvider.mutateAsync(provider.id);
      setTestResult({ ok: true, message: t("settings.ai.testSuccess") });
    } catch (err) {
      setTestResult({ ok: false, message: errorMessage(t, err) });
    }
  }

  const providerModels = models.filter((model) => model.providerId === provider.id);
  const typeLabel =
    provider.type === "anthropic" ? t("settings.ai.providerTypeAnthropic") : t("settings.ai.providerTypeOpenAiCompatible");

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{provider.name}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {typeLabel} · {provider.baseUrl}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <EditProviderDialog provider={provider} />
          <DeleteProviderDialog provider={provider} />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <input
            id={`provider-enabled-${provider.id}`}
            type="checkbox"
            checked={provider.enabled}
            onChange={(event) => void handleToggleEnabled(event.target.checked)}
            disabled={patchProvider.isPending}
            className="h-4 w-4 rounded border-input"
          />
          <label htmlFor={`provider-enabled-${provider.id}`} className="text-xs font-medium">
            {t("settings.ai.enabled")}
          </label>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void handleTest()} disabled={testProvider.isPending}>
          {testProvider.isPending ? t("settings.ai.testing") : t("settings.ai.test")}
        </Button>
      </div>

      {provider.degraded && (
        <p role="alert" className="text-xs text-destructive">
          {t("settings.ai.degradedBadge")}: {t("settings.ai.degradedNotice")}
        </p>
      )}

      {testResult && (
        <p role={testResult.ok ? "status" : "alert"} className={testResult.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
          {testResult.message}
        </p>
      )}

      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-muted-foreground">{t("settings.ai.modelsHeading")}</h4>
          <CreateModelDialog providerId={provider.id} />
        </div>
        {providerModels.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("settings.ai.modelEmpty")}</p>
        ) : (
          <ul className="space-y-1">
            {providerModels.map((model) => (
              <ModelRow key={model.id} model={model} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════ actions ═══════════════════════════════

/** model 下拉共用欄位：空值＝`settings.ai.modelAuto`（**「自動選擇（偏好預設模型）」**，
 * spec §13.4 明文禁止簡寫成「預設模型」——那句話描述的是「回退時偏好誰」，不是「這個
 * 選項本身叫預設模型」，兩者不能混為一談）。 */
function ModelSelectField({
  id,
  models,
  value,
  onChange,
}: {
  id: string;
  models: AdminAiModelDto[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className={SELECT_CLASS}>
      <option value="">{t("settings.ai.modelAuto")}</option>
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.displayName}
        </option>
      ))}
    </select>
  );
}

/**
 * `nextSortOrder`（fix round 1，M-1）：新 action 一律附加在清單最後，而不是讓 body
 * 省略 `sortOrder`（server 端 `sortOrder ?? 0` 會跟內建 Rewrite 之類同分變成 0——
 * 上下移鈕互換的是「相鄰兩項的 sortOrder 值」，同分時互換等於原地不動：兩支 PATCH
 * 照發、皆成功、但排序靜默失效）。呼叫端（`ActionsSection`）算好目前最大值 +1 傳進來。
 */
function CreateActionDialog({ models, nextSortOrder }: { models: AdminAiModelDto[]; nextSortOrder: number }) {
  const { t } = useTranslation();
  const createAction = useCreateAiAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [userTemplate, setUserTemplate] = useState("");
  const [modelId, setModelId] = useState("");
  const [applyMode, setApplyMode] = useState<AdminAiActionDto["applyMode"]>("direct");
  const [error, setError] = useState<string | null>(null);

  function resetForm(): void {
    setName("");
    setSystemPrompt("");
    setUserTemplate("");
    setModelId("");
    setApplyMode("direct");
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await createAction.mutateAsync({
        name,
        systemPrompt,
        userTemplate,
        modelId: modelId.length > 0 ? modelId : null,
        applyMode,
        sortOrder: nextSortOrder,
      });
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
        <Button type="button" size="sm">
          {t("settings.ai.addAction")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.ai.addAction")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="ai-action-name" className="text-sm font-medium">
              {t("settings.ai.actionName")}
            </label>
            <Input id="ai-action-name" required value={name} onChange={(event) => setName(event.target.value)} />
          </div>

          <div className="space-y-1">
            <label htmlFor="ai-action-system-prompt" className="text-sm font-medium">
              {t("settings.ai.actionSystemPrompt")}
            </label>
            <textarea
              id="ai-action-system-prompt"
              required
              rows={3}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              className={TEXTAREA_CLASS}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="ai-action-user-template" className="text-sm font-medium">
              {t("settings.ai.actionUserTemplate")}
            </label>
            <textarea
              id="ai-action-user-template"
              required
              rows={3}
              value={userTemplate}
              onChange={(event) => setUserTemplate(event.target.value)}
              className={TEXTAREA_CLASS}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.ai.actionUserTemplateHint", { placeholder: "{{text}}" })}
            </p>
          </div>

          <div className="space-y-1">
            <label htmlFor="ai-action-apply-mode" className="text-sm font-medium">
              {t("settings.ai.actionApplyMode")}
            </label>
            <select
              id="ai-action-apply-mode"
              value={applyMode}
              onChange={(event) => setApplyMode(event.target.value as AdminAiActionDto["applyMode"])}
              className={SELECT_CLASS}
            >
              <option value="direct">{t("settings.ai.actionApplyModeDirect")}</option>
              <option value="preview">{t("settings.ai.actionApplyModePreview")}</option>
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="ai-action-model" className="text-sm font-medium">
              {t("settings.ai.actionModel")}
            </label>
            <ModelSelectField id="ai-action-model" models={models} value={modelId} onChange={setModelId} />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={createAction.isPending}>
              {createAction.isPending ? t("settings.ai.creating") : t("settings.ai.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditActionDialog({ action, models }: { action: AdminAiActionDto; models: AdminAiModelDto[] }) {
  const { t } = useTranslation();
  const patchAction = usePatchAiAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(action.name);
  const [systemPrompt, setSystemPrompt] = useState(action.systemPrompt);
  const [userTemplate, setUserTemplate] = useState(action.userTemplate);
  const [modelId, setModelId] = useState(action.modelId ?? "");
  const [applyMode, setApplyMode] = useState<AdminAiActionDto["applyMode"]>(action.applyMode);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (next) {
      setName(action.name);
      setSystemPrompt(action.systemPrompt);
      setUserTemplate(action.userTemplate);
      setModelId(action.modelId ?? "");
      setApplyMode(action.applyMode);
      setError(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await patchAction.mutateAsync({
        id: action.id,
        body: { name, systemPrompt, userTemplate, modelId: modelId.length > 0 ? modelId : null, applyMode },
      });
      setOpen(false);
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          {t("settings.ai.edit")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.ai.editAction")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={`ai-action-edit-name-${action.id}`} className="text-sm font-medium">
              {t("settings.ai.actionName")}
            </label>
            <Input
              id={`ai-action-edit-name-${action.id}`}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor={`ai-action-edit-system-prompt-${action.id}`} className="text-sm font-medium">
              {t("settings.ai.actionSystemPrompt")}
            </label>
            <textarea
              id={`ai-action-edit-system-prompt-${action.id}`}
              required
              rows={3}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              className={TEXTAREA_CLASS}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor={`ai-action-edit-user-template-${action.id}`} className="text-sm font-medium">
              {t("settings.ai.actionUserTemplate")}
            </label>
            <textarea
              id={`ai-action-edit-user-template-${action.id}`}
              required
              rows={3}
              value={userTemplate}
              onChange={(event) => setUserTemplate(event.target.value)}
              className={TEXTAREA_CLASS}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.ai.actionUserTemplateHint", { placeholder: "{{text}}" })}
            </p>
          </div>

          <div className="space-y-1">
            <label htmlFor={`ai-action-edit-apply-mode-${action.id}`} className="text-sm font-medium">
              {t("settings.ai.actionApplyMode")}
            </label>
            <select
              id={`ai-action-edit-apply-mode-${action.id}`}
              value={applyMode}
              onChange={(event) => setApplyMode(event.target.value as AdminAiActionDto["applyMode"])}
              className={SELECT_CLASS}
            >
              <option value="direct">{t("settings.ai.actionApplyModeDirect")}</option>
              <option value="preview">{t("settings.ai.actionApplyModePreview")}</option>
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor={`ai-action-edit-model-${action.id}`} className="text-sm font-medium">
              {t("settings.ai.actionModel")}
            </label>
            <ModelSelectField id={`ai-action-edit-model-${action.id}`} models={models} value={modelId} onChange={setModelId} />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={patchAction.isPending}>
              {patchAction.isPending ? t("settings.ai.saving") : t("settings.ai.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** builtin action 雙保險之一（server 端見 `routes/admin-ai.ts` 的 `BUILTIN_ACTION_IDS`
 * 檢查）——UI 這一層直接不渲染刪除鈕，`DeleteActionDialog` 只在 `!action.builtin` 時掛載。 */
function DeleteActionDialog({ action }: { action: AdminAiActionDto }) {
  const { t } = useTranslation();
  const deleteAction = useDeleteAiAction();
  const [open, setOpen] = useState(false);

  async function handleConfirm(): Promise<void> {
    try {
      await deleteAction.mutateAsync(action.id);
      setOpen(false);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          {t("settings.ai.delete")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.ai.deleteActionTitle")}</DialogTitle>
          <DialogDescription>{t("settings.ai.deleteActionDescription", { name: action.name })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={() => void handleConfirm()} disabled={deleteAction.isPending}>
            {t("settings.ai.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ActionRow({
  action,
  models,
  canMoveUp,
  canMoveDown,
  movePending,
  onMove,
}: {
  action: AdminAiActionDto;
  models: AdminAiModelDto[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  movePending: boolean;
  onMove: (direction: "up" | "down") => void;
}) {
  const { t } = useTranslation();
  const patchAction = usePatchAiAction();

  async function handleToggleEnabled(next: boolean): Promise<void> {
    try {
      await patchAction.mutateAsync({ id: action.id, body: { enabled: next } });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  const modelLabel = action.modelId
    ? (models.find((model) => model.id === action.modelId)?.displayName ?? action.modelId)
    : t("settings.ai.modelAuto");
  const applyModeLabel =
    action.applyMode === "direct" ? t("settings.ai.actionApplyModeDirect") : t("settings.ai.actionApplyModePreview");

  return (
    <li className="space-y-2 rounded-md border border-border p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            {action.name}
            {action.builtin && (
              <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {t("settings.ai.actionBuiltinBadge")}
              </span>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {applyModeLabel} · {modelLabel}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("settings.ai.moveUp", { name: action.name })}
            disabled={!canMoveUp || movePending}
            onClick={() => onMove("up")}
          >
            ↑
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("settings.ai.moveDown", { name: action.name })}
            disabled={!canMoveDown || movePending}
            onClick={() => onMove("down")}
          >
            ↓
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          id={`action-enabled-${action.id}`}
          type="checkbox"
          checked={action.enabled}
          onChange={(event) => void handleToggleEnabled(event.target.checked)}
          disabled={patchAction.isPending}
          className="h-4 w-4 rounded border-input"
        />
        <label htmlFor={`action-enabled-${action.id}`} className="text-xs font-medium">
          {t("settings.ai.enabled")}
        </label>
        <div className="ml-auto flex items-center gap-2">
          <EditActionDialog action={action} models={models} />
          {!action.builtin && <DeleteActionDialog action={action} />}
        </div>
      </div>
    </li>
  );
}

/** Actions 列表——照 `sortOrder` 排序（`GET /api/admin/ai/actions` 已經
 * `orderBy(sortOrder, id)`，這裡直接沿用回應順序，不再重排）。上下移鈕＝跟相鄰項目
 * 對調 `sortOrder` 值：兩支循序 PATCH（先目標項、後鄰居項），值取自目前已知的
 * `actions` 陣列（不必等第一支 PATCH 的回應/重新查詢），故意循序 await 避免競態。
 *
 * fix round 2：上下移鈕在兩支 PATCH 進行中必須鎖死，否則連點會用同一組 stale
 * `actions` 陣列送出第二組「跟相鄰項目對調」的 PATCH——兩次對調抵銷，UI 呈現原地
 * 不動，但兩列已經同 `sortOrder`（PATCH body 不含 sortOrder 的 Edit 表單救不回來）。
 * `patchAction`（本層 `usePatchAiAction()` 實例）才是 `handleMove` 實際呼叫
 * `mutateAsync` 的那個——`ActionRow` 內部另有一個自己的 `usePatchAiAction()` 實例
 * （給 enabled checkbox 用），彼此 `isPending` 不共享，所以 move 鈕的鎖必須從這層
 * 往下傳，不能指望 `ActionRow` 自己那份。 */
function ActionsSection({ actions, models }: { actions: AdminAiActionDto[]; models: AdminAiModelDto[] }) {
  const { t } = useTranslation();
  const patchAction = usePatchAiAction();

  // fix round 1（M-1）：新 action 附加在清單最後——`sortOrder` 沒有 DB 唯一約束，若
  // create body 省略這個欄位，server 端 `sortOrder ?? 0` 會讓新動作跟 sortOrder=0
  // 的既有項（例如內建 Rewrite）同分，之後上下移鈕互換同分值＝原地不動，排序功能
  // 對這個新動作靜默失效。`Math.max(...) + 1` 保證新項一律排在現有最大值之後。
  const nextSortOrder = actions.length > 0 ? Math.max(...actions.map((action) => action.sortOrder)) + 1 : 0;

  async function handleMove(action: AdminAiActionDto, direction: "up" | "down"): Promise<void> {
    const index = actions.findIndex((item) => item.id === action.id);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= actions.length) return;
    const target = actions[targetIndex];
    try {
      await patchAction.mutateAsync({ id: action.id, body: { sortOrder: target.sortOrder } });
      await patchAction.mutateAsync({ id: target.id, body: { sortOrder: action.sortOrder } });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("settings.ai.actionsHeading")}</h2>
        <CreateActionDialog models={models} nextSortOrder={nextSortOrder} />
      </div>
      {actions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("settings.ai.actionEmpty")}</p>
      ) : (
        <ul className="space-y-2">
          {actions.map((action, index) => (
            <ActionRow
              key={action.id}
              action={action}
              models={models}
              canMoveUp={index > 0}
              canMoveDown={index < actions.length - 1}
              movePending={patchAction.isPending}
              onMove={(direction) => void handleMove(action, direction)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ═══════════════════════════════ section root ═══════════════════════════════

/**
 * 設定 modal 的 AI 區（`/settings/ai`，admin only，spec §13.4）——provider／model／
 * action 三層 CRUD：三個獨立 query（key 定死 `["admin-ai","providers"|"models"|"actions"]`，
 * 見 `@/api/adminAi`），任一 mutation 成功都會 invalidate 這三個＋`["ai-actions"]`
 * （`AiSession` 讀的可執行動作清單，讓筆記側欄同分頁立即生效）。
 */
export function SettingsAiSection() {
  const { t } = useTranslation();
  const providersQuery = useAdminAiProviders();
  const modelsQuery = useAdminAiModels();
  const actionsQuery = useAdminAiActions();

  const models = modelsQuery.data ?? [];
  const actions = actionsQuery.data ?? [];

  return (
    <div className="space-y-8">
      <h1 className="text-lg font-semibold">{t("settings.ai.title")}</h1>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("settings.ai.providersHeading")}</h2>
          <CreateProviderDialog />
        </div>

        {providersQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : providersQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, providersQuery.error)}
          </p>
        ) : providersQuery.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("settings.ai.providerEmpty")}</p>
        ) : (
          <div className="space-y-3">
            {providersQuery.data.map((provider) => (
              <ProviderCard key={provider.id} provider={provider} models={models} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3 border-t border-border pt-6">
        {actionsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : actionsQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, actionsQuery.error)}
          </p>
        ) : (
          <ActionsSection actions={actions} models={models} />
        )}
      </section>
    </div>
  );
}
