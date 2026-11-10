import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { SITE_LIMITS, siteLimitDef, type SiteLimitItemDto, type SiteLimitKey } from "@knotebook/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatApiValue, toInput } from "./site-limit-format";
import "@/i18n/management-strings";

/** 有「調低後果」說明的項目（文案在 `admin.limits.consequences.<key>`）。 */
const CONSEQUENCE_KEYS: ReadonlySet<SiteLimitKey> = new Set(["parseTimeoutMs", "parseWorkerMemoryMb", "parseQueueWaitMs"]);

/** 註冊表裡的 key（修改紀錄可能帶著已不在註冊表的 key）。 */
export function isSiteLimitKey(key: string): key is SiteLimitKey {
  return Object.prototype.hasOwnProperty.call(SITE_LIMITS, key);
}

/** 不帶數字的單位名稱（例如輸入框旁還沒填值時）用複數形。 */
const UNIT_PLURAL_COUNT = 2;

/** 輸入單位的名稱（依 `count` 取單複數）；worker 數與 token 數不用「次」。 */
export function inputUnitLabel(t: TFunction, key: SiteLimitKey, count: number = UNIT_PLURAL_COUNT): string {
  if (key === "parseWorkers") return t("admin.limits.units.workers", { count });
  if (key === "apiTokensPerUser") return t("admin.limits.units.tokens", { count });
  return t(`admin.limits.units.${siteLimitDef(key).input.unit}`, { count });
}

/** API 單位的名稱：次數類跟輸入單位同名（worker／token／次），其餘照 API 單位（bytes、ms…）。 */
export function apiUnitLabel(t: TFunction, key: SiteLimitKey, count: number = UNIT_PLURAL_COUNT): string {
  const unit = siteLimitDef(key).unit;
  if (unit === "count") return inputUnitLabel(t, key, count);
  return t(`admin.limits.units.${unit}`, { count });
}

/** 一個 API 值的顯示：對齊時以輸入單位（`5 MiB`、`45 seconds`），沒對齊時照 API 單位原樣（`5 242 881 bytes`）。 */
export function limitValueText(t: TFunction, key: SiteLimitKey, apiValue: number): string {
  const n = toInput(key, apiValue);
  if (n === null) return formatApiValue(key, apiValue, apiUnitLabel(t, key, apiValue));
  return `${n} ${inputUnitLabel(t, key, n)}`;
}

function outOfPageRange(key: SiteLimitKey, apiValue: number): boolean {
  const def = siteLimitDef(key);
  return apiValue < def.min || apiValue > def.max;
}

/** 生效值能不能以輸入單位顯示：對齊輸入刻度就能（超出管理頁範圍的 env 值也一樣，另有一句說明）。 */
function shownInInputUnits(item: SiteLimitItemDto): boolean {
  return toInput(item.key, item.value) !== null;
}

/** 輸入框的起始內容：自動項空白（placeholder 顯示自動值）；其餘是生效值的輸入單位數字，沒對齊時是 API 單位原文。 */
export function initialDraft(t: TFunction, item: SiteLimitItemDto): string {
  if (item.source === "auto") return "";
  if (!shownInInputUnits(item)) return formatApiValue(item.key, item.value, apiUnitLabel(t, item.key, item.value));
  return String(toInput(item.key, item.value));
}

/** 輸入框旁的單位跟著框裡的數字取單複數；不是整數（或空白）時看 placeholder，再沒有就用複數。 */
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
  /** 前端驗證錯誤（整數、範圍），顯示在列內。 */
  error?: string | null;
}

/**
 * 站台限制的一列：名稱、說明、輸入框（輸入單位）、「預設 X · 範圍 A–B」、狀態。
 * 狀態依 `item.source`：`default` 無標記；`auto` 標自動值；`admin` 標「已調整」＋恢復鈕；`env` 鎖住並說明，
 * 值超出管理頁範圍、或管理頁另存了值時各多一句；`storedIgnored` 另起一句說存的值沒套用。
 */
export function SiteLimitRow({ item, draft, onDraft, onReset, disabled, error }: SiteLimitRowProps) {
  const { t } = useTranslation();
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const inputId = `${baseId}-input`;
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;
  const autoId = `${baseId}-auto`;
  const { key } = item;
  const def = siteLimitDef(key);
  const autoCapable = def.default === "auto";
  const locked = item.source === "env";
  const value = locked ? initialDraft(t, item) : draft;
  const showUnit = !locked || shownInInputUnits(item);
  // 自動值沒對齊輸入刻度時不放 placeholder（框裡放不下 API 單位原文）；原值寫在下面的「自動：…」那句。
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

  const noteId = (index: number) => `${baseId}-note-${index}`;
  const describedBy = [
    hintId,
    ...(autoLabel !== null ? [autoId] : []),
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
          <p className="text-sm text-muted-foreground">{t(`admin.limits.items.${key}.description`)}</p>
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
      {CONSEQUENCE_KEYS.has(key) && <p className="text-xs text-muted-foreground">{t(`admin.limits.consequences.${key}`)}</p>}
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
