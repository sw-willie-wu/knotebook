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
 * 站台限制的「輸入單位 ↔ API 單位」換算與顯示（註冊表的 `unit`／`input`）。
 * 管理頁以輸入單位（MiB、秒、小時、次）讀寫；API 一律是 `unit`（bytes、ms、seconds…）。
 */

/** 一個輸入單位等於多少 API 單位（`siteLimitStep` 是 `input.step` 個輸入單位的量）。 */
function apiPerInputUnit(key: SiteLimitKey): number {
  return siteLimitStep(key) / siteLimitDef(key).input.step;
}

/**
 * API 值換成輸入單位；沒對齊輸入刻度時回 `null`——呼叫端照 API 單位原樣顯示（`formatApiValue`），
 * 不四捨五入，畫面上的數字才會跟實際生效的一樣。
 */
export function toInput(key: SiteLimitKey, apiValue: number): number | null {
  if (!Number.isInteger(apiValue) || apiValue % siteLimitStep(key) !== 0) return null;
  return apiValue / apiPerInputUnit(key);
}

export type FromInputResult = { ok: true; value: number } | { ok: false; reason: "notInteger" | "range" };

/** 輸入框文字換成 API 值：必須是整數個 `input.step`（小數、空白、非數字都 `notInteger`），換算後要在管理頁範圍內。 */
export function fromInput(key: SiteLimitKey, text: string): FromInputResult {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return { ok: false, reason: "notInteger" };
  const def = siteLimitDef(key);
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) return { ok: false, reason: "notInteger" };
  // 目前每一項的 input.step 都是 1，這條只替之後 step 大於 1 的項目把關。
  if (n % def.input.step !== 0) return { ok: false, reason: "notInteger" };
  const value = n * apiPerInputUnit(key);
  if (value < def.min || value > def.max) return { ok: false, reason: "range" };
  return { ok: true, value };
}

const API_UNIT_SYMBOL: Record<SiteLimitUnit, string> = { bytes: "bytes", ms: "ms", mib: "MiB", seconds: "s", count: "" };

/** 每三位插一個空格（`5242881` → `5 242 881`），兩種語言都一樣。 */
export function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** 照 API 單位原樣顯示（例：`5 242 881 bytes`、`12 345 ms`）；只分位、不換算。`unitLabel` 省略時用單位符號。 */
export function formatApiValue(key: SiteLimitKey, apiValue: number, unitLabel?: string): string {
  const label = unitLabel ?? API_UNIT_SYMBOL[siteLimitDef(key).unit];
  const digits = groupDigits(apiValue);
  return label === "" ? digits : `${digits} ${label}`;
}

/** 解析 worker 的記憶體試算（MB）：N × (M + 150) + 500（伺服器）+ 500（同機 PostgreSQL），再加 20 %。 */
export function estimateParseMemoryMb(workers: number, memoryMb: number): number {
  // 先乘 12 再除 10：直接 × 1.2 會帶浮點尾差（3348 × 1.2 ≠ 4017.6）。
  return ((workers * (memoryMb + 150) + 1000) * 12) / 10;
}

/**
 * 試算記憶體時用的 worker 數：env 鎖住 → 生效值；輸入了合法值 → 輸入值；留空（＝自動）或仍是自動 → 依新的記憶體上限重算
 * （與伺服器的自動推算同一份函式；伺服器回的 `autoValue` 是用舊的記憶體上限算的）；其餘 → 目前生效值。
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
