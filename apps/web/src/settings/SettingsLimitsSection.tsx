import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  SITE_LIMIT_KEYS,
  SITE_LIMITS,
  type SiteLimitCategory,
  type SiteLimitChangeDto,
  type SiteLimitItemDto,
  type SiteLimitKey,
  type SiteLimitsDto,
} from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useSiteLimits, useUpdateSiteLimits } from "@/api/siteLimits";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import { initialDraft, isSiteLimitKey, limitValueText, SiteLimitRow } from "./SiteLimitRow";
import { effectiveWorkers, estimateParseMemoryMb, fromInput, toInput } from "./site-limit-format";
import "@/i18n/management-strings";

/** 這一頁的分類（`signIn` 在「登入」分頁）；註冊表裡沒有項目的分類不畫。 */
const PAGE_CATEGORIES: readonly SiteLimitCategory[] = ["uploadsNotes", "parseWorkers", "rateLimits", "bulkTransfer"];

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** 伺服器錯誤：`limit_locked_by_env` 有自己的文案；`invalid_body` 一律「數值不在可調範圍內」，不轉譯英文 message。 */
function serverErrorMessage(t: TFunction, err: unknown): string {
  if (err instanceof ApiFail) {
    if (err.code === "limit_locked_by_env") return t("errors.limit_locked_by_env");
    if (err.code === "invalid_body") return t("admin.limits.invalidRange");
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

function categoryKeys(category: SiteLimitCategory): SiteLimitKey[] {
  return SITE_LIMIT_KEYS.filter((key) => SITE_LIMITS[key].category === category);
}

function itemsFor(data: SiteLimitsDto, keys: readonly SiteLimitKey[]): SiteLimitItemDto[] {
  const byKey = new Map(data.items.map((item) => [item.key, item]));
  return keys.flatMap((key) => {
    const item = byKey.get(key);
    return item ? [item] : [];
  });
}

/** 記憶體警告：用輸入框裡的值試算，超過偵測到的記憶體就提醒（不擋儲存）。 */
function MemoryWarning({ data, draftOf }: { data: SiteLimitsDto; draftOf: (item: SiteLimitItemDto) => string }) {
  const { t } = useTranslation();
  const memoryItem = data.items.find((item) => item.key === "parseWorkerMemoryMb");
  const workersItem = data.items.find((item) => item.key === "parseWorkers");
  if (!memoryItem || !workersItem) return null;
  let memoryMb = memoryItem.value;
  if (memoryItem.source !== "env") {
    const parsed = fromInput("parseWorkerMemoryMb", draftOf(memoryItem));
    if (parsed.ok) memoryMb = parsed.value;
  }
  const workers = effectiveWorkers(draftOf(workersItem), workersItem, data.machine, memoryMb);
  const needed = estimateParseMemoryMb(workers, memoryMb);
  if (needed <= data.machine.memoryBytes / MiB) return null;
  return (
    <p className="text-sm text-amber-700 dark:text-amber-400">
      {t("admin.limits.memoryWarning", { needed: Math.round(needed), count: workers, memoryMb })}
    </p>
  );
}

function MachineLine({ machine }: { machine: SiteLimitsDto["machine"] }) {
  const { t } = useTranslation();
  const gib = machine.memoryBytes / GiB;
  const memory = Number.isInteger(gib) ? String(gib) : gib.toFixed(1);
  return <p className="text-sm text-muted-foreground">{t("admin.limits.machine", { cpus: machine.cpus, memory, source: machine.memorySource })}</p>;
}

/**
 * 一組限制＋一顆「儲存」：只送輸入框與目前值不同的 key（以 API 單位）。前端先驗整數與範圍，有錯就不送；
 * 預設是自動的項目留空＝自動（已調整的送 `null` 改回自動，本來就是自動的不送）；「恢復預設」／「改回自動」立即送 `null`。
 * 伺服器回錯顯示在區塊頂。
 */
export function SiteLimitsGroup({
  title,
  keys,
  data,
  header,
}: {
  title: string;
  keys: readonly SiteLimitKey[];
  data: SiteLimitsDto;
  /** 區塊頂端、列之前的內容（例如解析 worker 的機器資訊）；拿得到輸入框目前的內容。 */
  header?: (draftOf: (item: SiteLimitItemDto) => string) => ReactNode;
}) {
  const { t } = useTranslation();
  const update = useUpdateSiteLimits();
  const [drafts, setDrafts] = useState<Partial<Record<SiteLimitKey, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<SiteLimitKey, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const items = itemsFor(data, keys);
  const draftOf = (item: SiteLimitItemDto): string => drafts[item.key] ?? initialDraft(t, item);

  function validationMessage(key: SiteLimitKey, reason: "notInteger" | "range"): string {
    if (reason === "notInteger") return t("admin.limits.validation.notInteger");
    const def = SITE_LIMITS[key];
    const inInputUnits = (v: number) => String(toInput(key, v) ?? v);
    return t("admin.limits.validation.outOfRange", { min: inInputUnits(def.min), max: inInputUnits(def.max) });
  }

  async function send(set: Partial<Record<SiteLimitKey, number | null>>): Promise<void> {
    setServerError(null);
    try {
      await update.mutateAsync({ set });
      const sent = Object.keys(set) as SiteLimitKey[];
      const without = (prev: Partial<Record<SiteLimitKey, string>>) => {
        const next = { ...prev };
        for (const key of sent) delete next[key];
        return next;
      };
      setDrafts(without);
      setErrors(without);
      toast({ title: t("admin.limits.actions.saved") });
    } catch (err) {
      setServerError(serverErrorMessage(t, err));
    }
  }

  function handleSave(): void {
    const set: Partial<Record<SiteLimitKey, number | null>> = {};
    const nextErrors: Partial<Record<SiteLimitKey, string>> = {};
    for (const item of items) {
      const draft = drafts[item.key];
      if (item.source === "env" || draft === undefined) continue;
      if (SITE_LIMITS[item.key].default === "auto" && draft.trim() === "") {
        if (item.source === "admin") set[item.key] = null;
        continue;
      }
      const parsed = fromInput(item.key, draft);
      if (!parsed.ok) {
        nextErrors[item.key] = validationMessage(item.key, parsed.reason);
        continue;
      }
      if (item.source !== "auto" && parsed.value === item.value) continue;
      set[item.key] = parsed.value;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    if (Object.keys(set).length === 0) {
      setDrafts({});
      return;
    }
    void send(set);
  }

  return (
    <SettingsGroup labelledByTitle title={title}>
      <div className="space-y-4">
        {serverError && (
          <p role="alert" className="text-sm text-destructive">
            {serverError}
          </p>
        )}
        {header?.(draftOf)}
        <div className="divide-y divide-border">
          {items.map((item) => (
            <SiteLimitRow
              key={item.key}
              item={item}
              draft={draftOf(item)}
              disabled={update.isPending}
              error={errors[item.key] ?? null}
              onDraft={(text) => {
                setDrafts((prev) => ({ ...prev, [item.key]: text }));
                setErrors((prev) => {
                  const next = { ...prev };
                  delete next[item.key];
                  return next;
                });
                setServerError(null);
              }}
              onReset={() => void send({ [item.key]: null })}
            />
          ))}
        </div>
        <Button type="button" variant="outline" disabled={update.isPending} onClick={handleSave}>
          {update.isPending ? t("admin.limits.actions.saving") : t("admin.limits.actions.save")}
        </Button>
      </div>
    </SettingsGroup>
  );
}

function changeValueText(t: TFunction, change: SiteLimitChangeDto, value: number | null, effective: number): string {
  const known = isSiteLimitKey(change.key);
  const text = (v: number) => (known ? limitValueText(t, change.key as SiteLimitKey, v) : String(v));
  if (value !== null) return text(value);
  const auto = known && SITE_LIMITS[change.key as SiteLimitKey].default === "auto";
  return t(auto ? "admin.limits.changes.toAuto" : "admin.limits.changes.toDefault", { value: text(effective) });
}

/** 最近的修改：伺服器已依時間新到舊排好；不在註冊表的 key 照列原始 key 與 API 原值。 */
function ChangesGroup({ changes }: { changes: SiteLimitChangeDto[] }) {
  const { t, i18n } = useTranslation();
  const columns: SettingsTableColumn[] = [
    { id: "time", header: t("admin.limits.changes.time"), kind: "primary", grow: 1 },
    { id: "actor", header: t("admin.limits.changes.actor"), kind: "text", grow: 1.5 },
    { id: "item", header: t("admin.limits.changes.item"), kind: "text", grow: 1.5 },
    { id: "change", header: t("admin.limits.changes.change"), kind: "text", grow: 1.5 },
  ];
  const rows: SettingsTableRow[] = changes.map((change) => ({
    id: change.id,
    primary: { name: new Date(change.changedAt).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" }) },
    cells: {
      actor: change.actor ? change.actor.email : { content: t("admin.limits.changes.actorGone"), tone: "muted" },
      item: isSiteLimitKey(change.key) ? t(`admin.limits.items.${change.key}.label`) : change.key,
      change: t("admin.limits.changes.arrow", {
        from: changeValueText(t, change, change.oldValue, change.oldEffective),
        to: changeValueText(t, change, change.newValue, change.newEffective),
      }),
    },
  }));
  return (
    <SettingsGroup title={t("admin.limits.changes.heading")}>
      <SettingsTable
        label={t("admin.limits.changes.heading")}
        columns={columns}
        rows={rows}
        empty={<p className="text-sm text-muted-foreground">{t("admin.limits.changes.empty")}</p>}
      />
    </SettingsGroup>
  );
}

function LimitsBody({ data }: { data: SiteLimitsDto }) {
  const { t } = useTranslation();
  const categories = PAGE_CATEGORIES.filter((category) => categoryKeys(category).length > 0);
  return (
    <>
      {categories.map((category) => (
        <SiteLimitsGroup
          key={category}
          title={t(`admin.limits.categories.${category}`)}
          keys={categoryKeys(category)}
          data={data}
          header={
            category === "parseWorkers"
              ? (draftOf) => (
                  <>
                    <MachineLine machine={data.machine} />
                    <MemoryWarning data={data} draftOf={draftOf} />
                  </>
                )
              : undefined
          }
        />
      ))}
      <ChangesGroup changes={data.changes} />
    </>
  );
}

/**
 * 站台管理「站台限制」分頁：依分類一個區塊（上傳與筆記、解析 worker、速率限制；批次讀寫有項目才畫），最後是最近的修改。
 * 登入期限與 token 兩項在「登入」分頁。
 */
export function SettingsLimitsSection() {
  const { t } = useTranslation();
  const query = useSiteLimits();
  let body: ReactNode;
  if (query.isPending) {
    body = (
      <SettingsGroup>
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      </SettingsGroup>
    );
  } else if (query.isError) {
    body = (
      <SettingsGroup>
        <p role="alert" className="text-sm text-destructive">
          {serverErrorMessage(t, query.error)}
        </p>
      </SettingsGroup>
    );
  } else {
    body = <LimitsBody data={query.data} />;
  }
  return (
    <SettingsPage title={t("admin.limits.title")} description={t("admin.limits.description")}>
      {body}
    </SettingsPage>
  );
}
