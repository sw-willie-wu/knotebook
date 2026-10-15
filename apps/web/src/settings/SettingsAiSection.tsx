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
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowDown, ArrowUp, Pencil, Plug, Trash } from "@/components/ui/icons";
import { RowIconButton } from "@/components/ui/row-icon-button";
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
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";

/** ApiFail → errors.<code>；其餘 → errors.fallback。與 SettingsUsersSection/ShareDialog
 * 同一套對映（各檔各自一份，是既有慣例）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

const SELECT_CLASS =
  "h-8 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none " +
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

/** 前端先擋（server 才是權威，同 code `base_url_has_credentials`）：URL 帶帳密時不送出。 */
function baseUrlHasCredentials(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.username !== "" || u.password !== "";
  } catch {
    return false;
  }
}

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
    if (baseUrlHasCredentials(baseUrl)) {
      setError(t("errors.base_url_has_credentials"));
      return;
    }
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
        <Button type="button" variant="outline" size="sm">
          {t("settings.ai.addProvider")}
        </Button>
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
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
            <Button type="submit" variant="brandDeep" disabled={createProvider.isPending}>
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
    if (baseUrlHasCredentials(baseUrl)) {
      setError(t("errors.base_url_has_credentials"));
      return;
    }
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
        <RowIconButton label={t("settings.ai.edit")} icon={<Pencil className="h-4 w-4" />} />
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
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
            <Button type="submit" variant="brandDeep" disabled={patchProvider.isPending}>
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
        <RowIconButton label={t("settings.ai.delete")} tone="destructive" icon={<Trash className="h-4 w-4" />} />
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
      <DialogContent dismissOnOutside={false}>
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
            <Checkbox
              id={`ai-model-is-default-${providerId}`}
              checked={isDefault}
              onCheckedChange={(checked) => setIsDefault(checked === true)}
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
            <Button type="submit" variant="brandDeep" disabled={createModel.isPending}>
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
        <RowIconButton label={t("settings.ai.edit")} icon={<Pencil className="h-4 w-4" />} />
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
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
            <Checkbox
              id={`ai-model-edit-is-default-${model.id}`}
              checked={isDefault}
              onCheckedChange={(checked) => setIsDefault(checked === true)}
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
            <Button type="submit" variant="brandDeep" disabled={patchModel.isPending}>
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
        <RowIconButton label={t("settings.ai.delete")} tone="destructive" icon={<Trash className="h-4 w-4" />} />
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

/** 模型列的啟用開關（`SettingsTable` 的 enabled 欄）：可及名稱「Enabled ＜模型名＞」由表格的 aria-labelledby 給（spec §1 的唯一例外：原為「Enabled」）。 */
function ModelEnabledSwitch({ model, labelledBy }: { model: AdminAiModelDto; labelledBy: string }) {
  const { t } = useTranslation();
  const patchModel = usePatchAiModel();

  async function handleToggle(next: boolean): Promise<void> {
    try {
      await patchModel.mutateAsync({ id: model.id, body: { enabled: next } });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Switch
      aria-labelledby={labelledBy}
      checked={model.enabled}
      onCheckedChange={(checked) => void handleToggle(checked)}
      disabled={patchModel.isPending}
    />
  );
}

/**
 * 供應商明細列裡的模型子表（spec §3 #2）：`nested`、表名「Models – ＜供應商名＞」、標題列＝Models＋「Add model」（不論有無模型都在）。
 * 欄：名稱（★預設標籤、副標 modelId）｜操作（編輯、刪除）｜啟用。子表與父表的啟用軌同為 56px、在最右；操作軌緊鄰其左、鈕群靠右（子表 2 顆鈕，軌比父表的 3 顆窄），
 * 所以子列鈕群右緣與開關中心和父列上下對齊（spec §2.5）。
 */
function ModelsTable({ provider, models }: { provider: AdminAiProviderDto; models: AdminAiModelDto[] }) {
  const { t } = useTranslation();
  const columns: SettingsTableColumn[] = [
    { id: "name", header: t("settings.ai.tableName"), kind: "primary" },
    { id: "actions", header: t("settings.ai.tableActions"), kind: "actions", buttons: 2 },
    { id: "enabled", header: t("settings.ai.tableEnabled"), kind: "enabled" },
  ];
  const rows: SettingsTableRow[] = models.map((model) => ({
    id: model.id,
    primary: {
      name: model.displayName,
      weight: "medium",
      badges: model.isDefault ? (
        <span title={t("settings.ai.modelDefaultBadge")} aria-label={t("settings.ai.modelDefaultBadge")}>
          ★
        </span>
      ) : undefined,
      subtitles: [model.modelId],
    },
    actions: (
      <>
        <EditModelDialog model={model} />
        <DeleteModelDialog model={model} />
      </>
    ),
    enabled: (labelledBy) => <ModelEnabledSwitch model={model} labelledBy={labelledBy} />,
  }));
  return (
    <SettingsTable
      nested
      label={`${t("settings.ai.modelsHeading")} – ${provider.name}`}
      title={t("settings.ai.modelsHeading")}
      titleAction={<CreateModelDialog providerId={provider.id} />}
      columns={columns}
      rows={rows}
      empty={t("settings.ai.modelEmpty")}
    />
  );
}

/** 測試連線的狀態。按鈕在操作欄、結果在明細列，所以由 `SettingsAiSection` 以供應商 id 為鍵保存。 */
interface ProviderTestState {
  pending: boolean;
  result: { ok: boolean; message: string } | null;
}

/** 供應商的啟用開關（可及名稱「Enabled ＜供應商名＞」，由表格的 aria-labelledby 給；對齊站台使用者表與登入服務表）。 */
function ProviderEnabledSwitch({ provider, labelledBy }: { provider: AdminAiProviderDto; labelledBy: string }) {
  const { t } = useTranslation();
  const patchProvider = usePatchAiProvider();

  async function handleToggle(next: boolean): Promise<void> {
    try {
      await patchProvider.mutateAsync({ id: provider.id, body: { enabled: next } });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Switch
      aria-labelledby={labelledBy}
      checked={provider.enabled}
      onCheckedChange={(checked) => void handleToggle(checked)}
      disabled={patchProvider.isPending}
    />
  );
}

/** 供應商列的操作鈕（spec §2.7 的順序：測試 → 編輯 → 刪除）。測試的進行中與結果交給上層保存、在明細列顯示。 */
function ProviderActions({
  provider,
  onTestStart,
  onTestDone,
}: {
  provider: AdminAiProviderDto;
  onTestStart: () => void;
  onTestDone: (result: { ok: boolean; message: string }) => void;
}) {
  const { t } = useTranslation();
  const testProvider = useTestAiProvider();

  async function handleTest(): Promise<void> {
    onTestStart();
    try {
      await testProvider.mutateAsync(provider.id);
      onTestDone({ ok: true, message: t("settings.ai.testSuccess") });
    } catch (err) {
      onTestDone({ ok: false, message: errorMessage(t, err) });
    }
  }

  return (
    <>
      <RowIconButton
        label={t("settings.ai.test")}
        icon={<Plug className="h-4 w-4" />}
        onClick={() => void handleTest()}
        disabled={testProvider.isPending}
      />
      <EditProviderDialog provider={provider} />
      <DeleteProviderDialog provider={provider} />
    </>
  );
}

/**
 * 供應商的明細列（spec §3 #1：現有內容全數保留）：降級警示、金鑰說明行、測試中狀態與測試結果、模型子表。
 * 明細內容排在整個表格寬度上，窄螢幕時一部分要捲動才看得到（spec §8 已知風險）。
 */
function ProviderDetail({
  provider,
  models,
  test,
}: {
  provider: AdminAiProviderDto;
  models: AdminAiModelDto[];
  test: ProviderTestState | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <div className="space-y-2 px-3 text-xs">
        {provider.degraded && (
          <p role="alert" className="text-destructive">
            {t("settings.ai.degradedBadge")}: {t("settings.ai.degradedNotice")}
          </p>
        )}

        {/* issue #46 審查：改網址會把金鑰作廢，但在此之前卡片上**完全看不出**一個 provider
            有沒有金鑰（`hasKey` 以前只有 Edit dialog 用）——於是「金鑰被清掉」變成一個沒有
            任何 UI 表示的狀態，degraded 的紅字還會在同一時間消失（沒金鑰就不叫解不開）而
            沒有東西接手。這一行就是接手的那個。degraded 時不重複顯示：那句已經在講同一件
            事（去重新輸入金鑰），兩行並排只會吵。

            ⚠ 文案必須是**中性事實**：`hasKey` 分不出「從來沒有」（自架的無授權服務，
            `docs/ai.md` 明講那是合法設定）與「剛剛被清掉」（要行動），所以這一行不能預言
            後果、也不能說「直到重新輸入為止」——對一顆從來沒有金鑰的 Ollama provider
            那是假話，而且它永遠不會消失（審查抓到）。 */}
        {!provider.hasKey && !provider.degraded && (
          <p role="status" className="text-muted-foreground">
            {t("settings.ai.noKeyNotice")}
          </p>
        )}

        {test?.pending === true && (
          <p role="status" className="text-muted-foreground">
            {t("settings.ai.testing")}
          </p>
        )}
        {test?.result != null && (
          <p role={test.result.ok ? "status" : "alert"} className={test.result.ok ? "text-muted-foreground" : "text-destructive"}>
            {test.result.message}
          </p>
        )}
      </div>
      <ModelsTable provider={provider} models={models} />
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
 * 照發、皆成功、但排序靜默失效）。呼叫端（`SettingsAiSection`）算好目前最大值 +1 傳進來。
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
        <Button type="button" variant="outline" size="sm">
          {t("settings.ai.addAction")}
        </Button>
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
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
            <Button type="submit" variant="brandDeep" disabled={createAction.isPending}>
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
  // #263 §4.4：內建 Instruct 一律預覽——不畫套用模式控制項、PATCH 也不帶 applyMode；template 提示列出三個佔位符。
  const isInstruct = action.kind === "instruct";

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
        body: {
          name,
          systemPrompt,
          userTemplate,
          modelId: modelId.length > 0 ? modelId : null,
          ...(isInstruct ? {} : { applyMode }),
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
        <RowIconButton label={t("settings.ai.edit")} icon={<Pencil className="h-4 w-4" />} />
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
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
            <p data-testid="ai-action-edit-template-hint" className="text-xs text-muted-foreground">
              {isInstruct
                ? t("settings.ai.actionUserTemplateHintInstruct", { instruction: "{{instruction}}", focus: "{{focus}}", text: "{{text}}" })
                : t("settings.ai.actionUserTemplateHint", { placeholder: "{{text}}" })}
            </p>
          </div>

          {!isInstruct && (
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
          )}

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
            <Button type="submit" variant="brandDeep" disabled={patchAction.isPending}>
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
        <RowIconButton label={t("settings.ai.delete")} tone="destructive" icon={<Trash className="h-4 w-4" />} />
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

/** 動作的啟用開關（可及名稱「Enabled ＜動作名＞」——spec §1 的唯一例外：原為帶可見文字的「Enabled」）。 */
function ActionEnabledSwitch({ action, labelledBy }: { action: AdminAiActionDto; labelledBy: string }) {
  const { t } = useTranslation();
  const patchAction = usePatchAiAction();

  async function handleToggle(next: boolean): Promise<void> {
    try {
      await patchAction.mutateAsync({ id: action.id, body: { enabled: next } });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Switch
      aria-labelledby={labelledBy}
      checked={action.enabled}
      onCheckedChange={(checked) => void handleToggle(checked)}
      disabled={patchAction.isPending}
    />
  );
}

/**
 * 動作列的操作鈕（spec §2.7：上移 → 下移 → 編輯 → 刪除）。上下移在清單邊界、或兩支 PATCH 進行中用原生 disabled（暫時性的不可用）；
 * 內建動作沒有刪除鈕（builtin 雙保險之一，server 端見 `routes/admin-ai.ts` 的 `BUILTIN_ACTION_IDS`）。
 */
function ActionButtons({
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
  return (
    <>
      <RowIconButton
        label={t("settings.ai.moveUp", { name: action.name })}
        icon={<ArrowUp className="h-4 w-4" />}
        disabled={!canMoveUp || movePending}
        onClick={() => onMove("up")}
      />
      <RowIconButton
        label={t("settings.ai.moveDown", { name: action.name })}
        icon={<ArrowDown className="h-4 w-4" />}
        disabled={!canMoveDown || movePending}
        onClick={() => onMove("down")}
      />
      <EditActionDialog action={action} models={models} />
      {!action.builtin && <DeleteActionDialog action={action} />}
    </>
  );
}

// ═══════════════════════════════ section root ═══════════════════════════════

/**
 * 站台管理頁的 AI 區（`/admin/ai`，站台管理 modal 的「AI 代理」，#247；舊網址
 * `/settings/ai` 轉址過來，見 `App.tsx` 第二棵樹）——provider／model／
 * action 三層 CRUD：三個獨立 query（key 定死 `["admin-ai","providers"|"models"|"actions"]`，
 * 見 `@/api/adminAi`），任一 mutation 成功都會 invalidate 這三個＋`["ai-actions"]`
 * （`AiSession` 讀的可執行動作清單，讓筆記側欄同分頁立即生效）。
 *
 * 版面（spec 2026-10-13 settings-table §3 #1–#3）：供應商表（模型是每個供應商明細列裡的子表）與動作表都是 `SettingsTable`；
 * 動作表的標題與「Add action」由 `SettingsGroup` 的 title／action 提供。
 *
 * 動作照 `sortOrder` 排序（`GET /api/admin/ai/actions` 已經 `orderBy(sortOrder, id)`，這裡直接沿用回應順序，不再重排）。
 * 上下移鈕＝跟相鄰項目對調 `sortOrder` 值：兩支循序 PATCH（先目標項、後鄰居項），值取自目前已知的 `actions` 陣列
 * （不必等第一支 PATCH 的回應／重新查詢），故意循序 await 避免競態。
 *
 * fix round 2：上下移鈕在兩支 PATCH 進行中必須鎖死，否則連點會用同一組 stale `actions` 陣列送出第二組「跟相鄰項目對調」
 * 的 PATCH——兩次對調抵銷，UI 呈現原地不動，但兩列已經同 `sortOrder`（PATCH body 不含 sortOrder 的 Edit 表單救不回來）。
 * 本層的 `patchAction`（`usePatchAiAction()` 實例）才是 `handleMove` 實際呼叫 `mutateAsync` 的那個——每列開關各有自己的
 * `usePatchAiAction()` 實例，彼此 `isPending` 不共享，所以上下移鈕的鎖從這層往下傳（`movePending`）。
 */
export function SettingsAiSection() {
  const { t } = useTranslation();
  const providersQuery = useAdminAiProviders();
  const modelsQuery = useAdminAiModels();
  const actionsQuery = useAdminAiActions();
  const patchAction = usePatchAiAction();
  const [tests, setTests] = useState<Record<string, ProviderTestState>>({});

  const models = modelsQuery.data ?? [];
  const actions = actionsQuery.data ?? [];

  // fix round 1（M-1）：新 action 附加在清單最後——`sortOrder` 沒有 DB 唯一約束，若
  // create body 省略這個欄位，server 端 `sortOrder ?? 0` 會讓新動作跟 sortOrder=0
  // 的既有項（例如內建 Rewrite）同分，之後上下移鈕互換同分值＝原地不動，排序功能
  // 對這個新動作靜默失效。`Math.max(...) + 1` 保證新項一律排在現有最大值之後。
  // 「Add action」只在動作清單載入成功後才渲染，這個值才不會在載入中誤算成 0。
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

  const providerColumns: SettingsTableColumn[] = [
    { id: "name", header: t("settings.ai.tableName"), kind: "primary", grow: 1 },
    { id: "type", header: t("settings.ai.tableType"), kind: "fixed" },
    { id: "baseUrl", header: t("settings.ai.tableBaseUrl"), kind: "url" },
    { id: "models", header: t("settings.ai.tableModels"), kind: "text" },
    { id: "actions", header: t("settings.ai.tableActions"), kind: "actions", buttons: 3 },
    { id: "enabled", header: t("settings.ai.tableEnabled"), kind: "enabled" },
  ];
  const providerRows: SettingsTableRow[] = (providersQuery.data ?? []).map((provider) => {
    const providerModels = models.filter((model) => model.providerId === provider.id);
    return {
      id: provider.id,
      primary: { name: provider.name, weight: "semibold" },
      cells: {
        type: {
          content:
            provider.type === "anthropic" ? t("settings.ai.providerTypeAnthropic") : t("settings.ai.providerTypeOpenAiCompatible"),
          tone: "muted",
        },
        baseUrl: provider.baseUrl,
        models: providerModels.length === 0 ? "—" : providerModels.map((model) => model.displayName).join(", "),
      },
      actions: (
        <ProviderActions
          provider={provider}
          onTestStart={() => setTests((prev) => ({ ...prev, [provider.id]: { pending: true, result: null } }))}
          onTestDone={(result) => setTests((prev) => ({ ...prev, [provider.id]: { pending: false, result } }))}
        />
      ),
      enabled: (labelledBy) => <ProviderEnabledSwitch provider={provider} labelledBy={labelledBy} />,
      detail: <ProviderDetail provider={provider} models={providerModels} test={tests[provider.id]} />,
    };
  });

  const actionColumns: SettingsTableColumn[] = [
    { id: "name", header: t("settings.ai.tableName"), kind: "primary" },
    { id: "applyMode", header: t("settings.ai.actionApplyMode"), kind: "fixed" },
    { id: "model", header: t("settings.ai.actionModel"), kind: "text" },
    { id: "actions", header: t("settings.ai.tableActions"), kind: "actions", buttons: 4 },
    { id: "enabled", header: t("settings.ai.tableEnabled"), kind: "enabled" },
  ];
  const actionRows: SettingsTableRow[] = actions.map((action, index) => ({
    id: action.id,
    primary: {
      name: action.name,
      weight: "medium",
      badges: action.builtin ? (
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{t("settings.ai.actionBuiltinBadge")}</span>
      ) : undefined,
    },
    cells: {
      applyMode: action.applyMode === "direct" ? t("settings.ai.actionApplyModeDirect") : t("settings.ai.actionApplyModePreview"),
      model: action.modelId
        ? (models.find((model) => model.id === action.modelId)?.displayName ?? action.modelId)
        : t("settings.ai.modelAuto"),
    },
    actions: (
      <ActionButtons
        action={action}
        models={models}
        canMoveUp={index > 0}
        canMoveDown={index < actions.length - 1}
        movePending={patchAction.isPending}
        onMove={(direction) => void handleMove(action, direction)}
      />
    ),
    enabled: (labelledBy) => <ActionEnabledSwitch action={action} labelledBy={labelledBy} />,
  }));

  return (
    <SettingsPage title={t("settings.ai.title")} description={t("settings.ai.description")}>
      <SettingsGroup title={t("settings.ai.providersHeading")} action={<CreateProviderDialog />}>
        {providersQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : providersQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, providersQuery.error)}
          </p>
        ) : (
          <SettingsTable
            label={t("settings.ai.providersHeading")}
            columns={providerColumns}
            rows={providerRows}
            empty={t("settings.ai.providerEmpty")}
          />
        )}
      </SettingsGroup>

      {/* 群組之間的分隔線由 `SettingsPage` 的 `divide-y` 統一長出來。 */}
      <SettingsGroup
        title={t("settings.ai.actionsHeading")}
        action={actionsQuery.isSuccess ? <CreateActionDialog models={models} nextSortOrder={nextSortOrder} /> : undefined}
      >
        {actionsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : actionsQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, actionsQuery.error)}
          </p>
        ) : (
          <SettingsTable label={t("settings.ai.actionsHeading")} columns={actionColumns} rows={actionRows} empty={t("settings.ai.actionEmpty")} />
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
