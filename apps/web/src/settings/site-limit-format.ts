import {
  defaultParseWorkers,
  memoryParseWorkers,
  siteLimitDef,
  siteLimitStep,
  type SiteLimitItemDto,
  type SiteLimitKey,
  type SiteLimitsDto,
  type SiteLimitUnit,
} from "@knotebook/shared";

/**
 * Site limits: the admin page reads and writes input units (MiB, seconds, hours, count); the API always uses `unit` (bytes,
 * ms, seconds…).
 */

/** API units per input unit (`siteLimitStep` is the amount of `input.step` input units). */
function apiPerInputUnit(key: SiteLimitKey): number {
  return siteLimitStep(key) / siteLimitDef(key).input.step;
}

/** Returns null when not aligned to the input step so callers show the raw API value; no rounding keeps the number truthful. */
export function toInput(key: SiteLimitKey, apiValue: number): number | null {
  if (!Number.isInteger(apiValue) || apiValue % siteLimitStep(key) !== 0) return null;
  return apiValue / apiPerInputUnit(key);
}

export type FromInputResult = { ok: true; value: number } | { ok: false; reason: "notInteger" | "range" };

export function fromInput(key: SiteLimitKey, text: string): FromInputResult {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return { ok: false, reason: "notInteger" };
  const def = siteLimitDef(key);
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) return { ok: false, reason: "notInteger" };
  // Every current input.step is 1; this guards future items with a larger step.
  if (n % def.input.step !== 0) return { ok: false, reason: "notInteger" };
  const value = n * apiPerInputUnit(key);
  if (value < def.min || value > def.max) return { ok: false, reason: "range" };
  return { ok: true, value };
}

const API_UNIT_SYMBOL: Record<SiteLimitUnit, string> = { bytes: "bytes", ms: "ms", mib: "MiB", seconds: "s", count: "" };

export function formatMib(mib: number): string {
  return mib >= 1024 && mib % 1024 === 0 ? `${mib / 1024} GiB` : `${mib} MiB`;
}

/** Space-separated thousands in every language (not locale-formatted). */
export function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function formatApiValue(key: SiteLimitKey, apiValue: number, unitLabel?: string): string {
  const label = unitLabel ?? API_UNIT_SYMBOL[siteLimitDef(key).unit];
  const digits = groupDigits(apiValue);
  return label === "" ? digits : `${digits} ${label}`;
}

/** Worker memory estimate (MB): N × (M + 150) + 500 (server) + 500 (co-located PostgreSQL), plus 20 %. */
export function estimateParseMemoryMb(workers: number, memoryMb: number): number {
  // Multiply by 12 then divide by 10: × 1.2 carries float error (3348 × 1.2 ≠ 4017.6).
  return ((workers * (memoryMb + 150) + 1000) * 12) / 10;
}

/**
 * Locked by env: the effective value. A valid draft: the draft. Blank (= auto) or still auto: recomputed from the new memory
 * limit with the server's own auto-derivation function, since the server's `autoValue` used the old memory limit.
 * Otherwise: the current effective value.
 */
export function effectiveWorkers(draft: string, item: SiteLimitItemDto, machine: SiteLimitsDto["machine"], memoryMb: number): number {
  if (item.source === "env") return item.value;
  const blank = draft.trim() === "";
  if (!blank) {
    const parsed = fromInput(item.key, draft);
    if (parsed.ok) return parsed.value;
  }
  if (blank || item.source === "auto") return Math.min(defaultParseWorkers(machine.cpus), memoryParseWorkers(machine.memoryBytes, memoryMb));
  return item.value;
}
