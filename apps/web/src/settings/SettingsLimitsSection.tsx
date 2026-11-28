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
import { initialDraft, isSiteLimitKey, limitValueText, MEDIA_LIMIT_KEY, SiteLimitRow } from "./SiteLimitRow";
import { effectiveWorkers, estimateParseMemoryMb, formatMib, fromInput, toInput } from "./site-limit-format";
import "@/i18n/management-strings";

/** `signIn` lives on the sign-in tab; categories with no registry items aren't drawn. */
export const PAGE_CATEGORIES: readonly SiteLimitCategory[] = ["uploadsNotes", "parseWorkers", "rateLimits", "bulkTransfer"];

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** `limit_locked_by_env` has its own text; `invalid_body` always shows the range message rather than the English server text. */
export function serverErrorMessage(t: TFunction, err: unknown): string {
  if (err instanceof ApiFail) {
    if (err.code === "limit_locked_by_env") return t("errors.limit_locked_by_env");
    if (err.code === "invalid_body") return t("admin.limits.invalidRange");
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

export function categoryKeys(category: SiteLimitCategory): SiteLimitKey[] {
  return SITE_LIMIT_KEYS.filter((key) => SITE_LIMITS[key].category === category);
}

function itemsFor(data: SiteLimitsDto, keys: readonly SiteLimitKey[]): SiteLimitItemDto[] {
  const byKey = new Map(data.items.map((item) => [item.key, item]));
  return keys.flatMap((key) => {
    const item = byKey.get(key);
    return item ? [item] : [];
  });
}

/** Estimates from the draft values; warns when over the detected memory but doesn't block saving. */
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
    <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
      {t("admin.limits.memoryWarning", { needed: Math.round(needed), count: workers, memoryMb })}
    </p>
  );
}

function MachineLine({ machine }: { machine: SiteLimitsDto["machine"] }) {
  const { t } = useTranslation();
  const gib = machine.memoryBytes / GiB;
  const memory = Number.isInteger(gib) ? String(gib) : gib.toFixed(1);
  return <p className="text-sm text-muted-foreground">{t("admin.limits.machine", { count: machine.cpus, memory, source: machine.memorySource })}</p>;
}

/**
 * One save sends only keys whose draft differs from the current value (in API units), after client-side integer and range
 * checks. For items that default to auto, blank = auto: an adjusted one sends `null` to revert, an already-auto one isn't
 * sent. "Restore default"/"Back to auto" send `null` at once. Server errors show at the top of the group.
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
  header?: (draftOf: (item: SiteLimitItemDto) => string) => ReactNode;
}) {
  const { t } = useTranslation();
  const update = useUpdateSiteLimits();
  const [drafts, setDrafts] = useState<Partial<Record<SiteLimitKey, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<SiteLimitKey, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const items = itemsFor(data, keys);
  const draftOf = (item: SiteLimitItemDto): string => drafts[item.key] ?? initialDraft(t, item);

  function validationMessage(key: SiteLimitKey, reason: "notInteger" | "range", draft: string): string {
    if (reason === "notInteger") return t("admin.limits.validation.notInteger");
    const def = SITE_LIMITS[key];
    if (key === MEDIA_LIMIT_KEY) {
      // The registry maximum (a storage ceiling, not a recommendation) is never printed.
      return Number(draft.trim()) > def.max ? t("admin.limits.media.tooLarge") : t("admin.limits.media.tooSmall", { min: formatMib(def.min) });
    }
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
        nextErrors[item.key] = validationMessage(item.key, parsed.reason, draft);
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

/** The server already sorts newest first; keys missing from the registry show their raw key and API value. */
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
  } else if (query.data === undefined) {
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
