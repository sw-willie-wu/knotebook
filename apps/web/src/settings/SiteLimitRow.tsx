import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { SITE_LIMITS, siteLimitDef, type SiteLimitItemDto, type SiteLimitKey } from "@knotebook/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatApiValue, formatMib, fromInput, toInput } from "./site-limit-format";
import "@/i18n/management-strings";

/** Keys with a "consequences of lowering" note (copy at `admin.limits.consequences.<key>`). */
const CONSEQUENCE_KEYS: ReadonlySet<SiteLimitKey> = new Set(["parseTimeoutMs", "parseWorkerMemoryMb", "parseQueueWaitMs"]);

export const MEDIA_LIMIT_KEY: SiteLimitKey = "uploadMediaMaxMib";
/** Above this the admin page warns about what a very large upload costs; the registry maximum is never shown. */
const MEDIA_RECOMMENDED_MIN_MIB = 100;
const MEDIA_RECOMMENDED_MAX_MIB = 1024;
const MEDIA_RISK_KEYS = ["disk", "proxy", "restart", "temp"] as const;

/** Change-log entries may carry keys that are no longer in the registry. */
export function isSiteLimitKey(key: string): key is SiteLimitKey {
  return Object.prototype.hasOwnProperty.call(SITE_LIMITS, key);
}

/** Unit names shown without a number (e.g. beside an empty input) use the plural form. */
const UNIT_PLURAL_COUNT = 2;

export function inputUnitLabel(t: TFunction, key: SiteLimitKey, count: number = UNIT_PLURAL_COUNT): string {
  if (key === "parseWorkers") return t("admin.limits.units.workers", { count });
  if (key === "apiTokensPerUser") return t("admin.limits.units.tokens", { count });
  return t(`admin.limits.units.${siteLimitDef(key).input.unit}`, { count });
}

export function apiUnitLabel(t: TFunction, key: SiteLimitKey, count: number = UNIT_PLURAL_COUNT): string {
  const unit = siteLimitDef(key).unit;
  if (unit === "count") return inputUnitLabel(t, key, count);
  return t(`admin.limits.units.${unit}`, { count });
}

export function limitValueText(t: TFunction, key: SiteLimitKey, apiValue: number): string {
  const n = toInput(key, apiValue);
  if (n === null) return formatApiValue(key, apiValue, apiUnitLabel(t, key, apiValue));
  return `${n} ${inputUnitLabel(t, key, n)}`;
}

function outOfPageRange(key: SiteLimitKey, apiValue: number): boolean {
  const def = siteLimitDef(key);
  return apiValue < def.min || apiValue > def.max;
}

/** True when aligned to the input scale, including env values outside the page's range (which get an extra note). */
function shownInInputUnits(item: SiteLimitItemDto): boolean {
  return toInput(item.key, item.value) !== null;
}

/** Auto items start empty (the placeholder shows the auto value); others get the effective value in input units, or the raw API-unit text when unaligned. */
export function initialDraft(t: TFunction, item: SiteLimitItemDto): string {
  if (item.source === "auto") return "";
  if (!shownInInputUnits(item)) return formatApiValue(item.key, item.value, apiUnitLabel(t, item.key, item.value));
  return String(toInput(item.key, item.value));
}

function unitCount(text: string, placeholder: string | undefined): number {
  for (const candidate of [text.trim(), placeholder ?? ""]) {
    if (/^\d+$/.test(candidate)) return Number(candidate);
  }
  return UNIT_PLURAL_COUNT;
}

function windowText(t: TFunction, windowMs: number): string {
  const HOUR = 3_600_000;
  if (windowMs % HOUR === 0) return t("admin.limits.window.hours", { count: windowMs / HOUR });
  return t("admin.limits.window.minutes", { count: windowMs / 60_000 });
}

function hintText(t: TFunction, key: SiteLimitKey): string {
  const def = siteLimitDef(key);
  if (key === MEDIA_LIMIT_KEY) {
    return t("admin.limits.media.hint", { default: formatMib(def.default as number), min: formatMib(MEDIA_RECOMMENDED_MIN_MIB), max: formatMib(MEDIA_RECOMMENDED_MAX_MIB) });
  }
  const values = {
    default: def.default === "auto" ? t("admin.limits.defaultAuto") : limitValueText(t, key, def.default),
    min: String(toInput(key, def.min) ?? def.min),
    max: limitValueText(t, key, def.max),
  };
  if (def.windowMs !== undefined) return t("admin.limits.defaultAndRangeWindow", { ...values, window: windowText(t, def.windowMs) });
  return t("admin.limits.defaultAndRange", values);
}

export interface SiteLimitRowProps {
  item: SiteLimitItemDto;
  draft: string;
  onDraft(text: string): void;
  onReset(): void;
  disabled: boolean;
  error?: string | null;
}

export function SiteLimitRow({ item, draft, onDraft, onReset, disabled, error }: SiteLimitRowProps) {
  const { t } = useTranslation();
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const inputId = `${baseId}-input`;
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;
  const autoId = `${baseId}-auto`;
  const descriptionId = `${baseId}-description`;
  const consequenceId = `${baseId}-consequence`;
  const mediaId = `${baseId}-media`;
  const { key } = item;
  const def = siteLimitDef(key);
  const autoCapable = def.default === "auto";
  const locked = item.source === "env";
  const value = locked ? initialDraft(t, item) : draft;
  const showUnit = !locked || shownInInputUnits(item);
  // No placeholder when the auto value isn't aligned to the input scale (API-unit text won't fit); the raw value is in the "auto: ..." line below.
  const autoInInputUnits = item.source === "auto" && item.autoValue !== undefined ? toInput(key, item.autoValue) : null;
  const placeholder = autoInInputUnits === null ? undefined : String(autoInInputUnits);

  const notes: string[] = [];
  if (locked) {
    notes.push(t("admin.limits.status.lockedByEnv", { env: def.env ?? "" }));
    if (outOfPageRange(key, item.value)) notes.push(t("admin.limits.status.outOfRange"));
    if (item.stored !== null) notes.push(t("admin.limits.status.storedNotApplied", { value: limitValueText(t, key, item.stored) }));
  } else if (item.storedIgnored && item.stored !== null) {
    notes.push(t("admin.limits.status.storedIgnored", { value: limitValueText(t, key, item.stored) }));
  }

  let autoLabel: string | null = null;
  if (item.source === "auto" && item.autoValue !== undefined) {
    autoLabel =
      key === "parseWorkers"
        ? t("admin.limits.status.auto", {
            value: item.autoValue,
            source: t(item.autoSource === "memory" ? "admin.limits.status.autoSourceMemory" : "admin.limits.status.autoSourceCpu"),
          })
        : t("admin.limits.status.autoPlain", { value: limitValueText(t, key, item.autoValue) });
  }

  // The draft when it parses, else the saved value, so the size and the warning follow typing.
  let mediaMib: number | null = null;
  if (key === MEDIA_LIMIT_KEY) {
    const parsed = locked ? null : fromInput(key, draft);
    mediaMib = parsed !== null && parsed.ok ? parsed.value : item.value;
  }

  const noteId = (index: number) => `${baseId}-note-${index}`;
  const describedBy = [
    descriptionId,
    hintId,
    ...(CONSEQUENCE_KEYS.has(key) ? [consequenceId] : []),
    ...(autoLabel !== null ? [autoId] : []),
    ...(mediaMib !== null ? [mediaId] : []),
    ...notes.map((_, index) => noteId(index)),
    ...(error ? [errorId] : []),
  ].join(" ");

  return (
    <div role="group" aria-labelledby={labelId} data-limit-key={key} className="space-y-1.5 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <label id={labelId} htmlFor={inputId} className="text-sm font-medium">
            {t(`admin.limits.items.${key}.label`)}
          </label>
          <p id={descriptionId} className="text-sm text-muted-foreground">
            {t(`admin.limits.items.${key}.description`)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Input
            id={inputId}
            inputMode="numeric"
            value={value}
            placeholder={placeholder}
            disabled={disabled || locked}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(event) => onDraft(event.target.value)}
            className={showUnit ? "w-28" : "w-40"}
          />
          {showUnit && <span className="w-16 text-sm text-muted-foreground">{inputUnitLabel(t, key, unitCount(value, placeholder))}</span>}
        </div>
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        {hintText(t, key)}
      </p>
      {CONSEQUENCE_KEYS.has(key) && (
        <p id={consequenceId} className="text-xs text-muted-foreground">
          {t(`admin.limits.consequences.${key}`)}
        </p>
      )}
      {mediaMib !== null && (
        <div id={mediaId} className="space-y-1 text-xs text-muted-foreground">
          <p>{t("admin.limits.media.current", { size: formatMib(mediaMib) })}</p>
          {mediaMib > MEDIA_RECOMMENDED_MAX_MIB && (
            <>
              <p className="font-medium text-foreground">{t("admin.limits.media.riskTitle", { size: formatMib(MEDIA_RECOMMENDED_MAX_MIB) })}</p>
              <ul className="list-disc space-y-0.5 pl-5">
                {MEDIA_RISK_KEYS.map((risk) => (
                  <li key={risk}>{t(`admin.limits.media.risk.${risk}`)}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {autoLabel !== null && (
        <p id={autoId} className="text-xs text-muted-foreground">
          {autoLabel}
        </p>
      )}
      {item.source === "admin" && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">{t("admin.limits.status.adjusted")}</span>
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onReset}>
            {t(autoCapable ? "admin.limits.actions.resetAuto" : "admin.limits.actions.resetDefault")}
          </Button>
        </div>
      )}
      {notes.map((note, index) => (
        <p key={note} id={noteId(index)} className="text-xs text-muted-foreground">
          {note}
        </p>
      ))}
      {error && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
