/**
 * #397：站台限制註冊表——一項限制只註冊一次（前後端共用；web 用它畫表單、驗範圍、顯示預設與單位，server 用它驗 PATCH、取預設）。
 * 值照 spec §4.3。新增一項要做的事見 spec §4.2。
 */
export type SiteLimitCategory = "uploadsNotes" | "parseWorkers" | "rateLimits" | "bulkTransfer" | "signIn";
export type SiteLimitUnit = "bytes" | "mib" | "ms" | "seconds" | "count";

export interface SiteLimitDef {
  /** 型別：本版只有整數。 */
  type: "int";
  unit: SiteLimitUnit;
  /** 預設值；"auto"＝伺服器依機器推算（只有解析 worker 兩項）。 */
  default: number | "auto";
  /** 管理頁可存的範圍（含兩端）。env 的範圍另由 config.ts 管，不受此限。 */
  min: number;
  max: number;
  /** 既有 env 名（只有 5 項有；不新增）。 */
  env?: "NOTE_MAX_BYTES" | "PARSE_WORKERS" | "PARSE_WORKER_MEMORY_MB" | "PARSE_TIMEOUT_MS" | "PARSE_QUEUE_WAIT_MS";
  category: SiteLimitCategory;
  /** 速率限制：視窗長度（只顯示，不可調；server 測試斷言與 rate-limit.ts 的常數相等）。 */
  windowMs?: number;
  /** 管理頁輸入單位與換算（例：bytes 以 MiB 輸入、ms 以秒輸入）；step 是輸入的最小單位。 */
  input: { unit: "mib" | "seconds" | "hours" | "count"; step: number };
}

export const SITE_LIMITS = {
  uploadMaxBytes: { type: "int", unit: "bytes", default: 10_485_760, min: 1_048_576, max: 10_485_760, category: "uploadsNotes", input: { unit: "mib", step: 1 } },
  noteMaxBytes: { type: "int", unit: "bytes", default: 5_242_880, min: 1_048_576, max: 5_242_880, env: "NOTE_MAX_BYTES", category: "uploadsNotes", input: { unit: "mib", step: 1 } },
  parseWorkers: { type: "int", unit: "count", default: "auto", min: 1, max: 4, env: "PARSE_WORKERS", category: "parseWorkers", input: { unit: "count", step: 1 } },
  parseWorkerMemoryMb: { type: "int", unit: "mib", default: 1_024, min: 512, max: 3_072, env: "PARSE_WORKER_MEMORY_MB", category: "parseWorkers", input: { unit: "mib", step: 1 } },
  parseTimeoutMs: { type: "int", unit: "ms", default: 10_000, min: 4_000, max: 10_000, env: "PARSE_TIMEOUT_MS", category: "parseWorkers", input: { unit: "seconds", step: 1 } },
  parseQueueWaitMs: { type: "int", unit: "ms", default: "auto", min: 5_000, max: 45_000, env: "PARSE_QUEUE_WAIT_MS", category: "parseWorkers", input: { unit: "seconds", step: 1 } },
  rateTokenRead: { type: "int", unit: "count", default: 300, min: 30, max: 300, category: "rateLimits", windowMs: 60_000, input: { unit: "count", step: 1 } },
  rateTokenWrite: { type: "int", unit: "count", default: 60, min: 6, max: 60, category: "rateLimits", windowMs: 600_000, input: { unit: "count", step: 1 } },
  rateContentRead: { type: "int", unit: "count", default: 120, min: 12, max: 120, category: "rateLimits", windowMs: 60_000, input: { unit: "count", step: 1 } },
  rateEdit: { type: "int", unit: "count", default: 30, min: 3, max: 30, category: "rateLimits", windowMs: 60_000, input: { unit: "count", step: 1 } },
  rateSearch: { type: "int", unit: "count", default: 60, min: 6, max: 60, category: "rateLimits", windowMs: 60_000, input: { unit: "count", step: 1 } },
  rateUpload: { type: "int", unit: "count", default: 120, min: 12, max: 120, category: "rateLimits", windowMs: 600_000, input: { unit: "count", step: 1 } },
  rateAi: { type: "int", unit: "count", default: 30, min: 3, max: 30, category: "rateLimits", windowMs: 60_000, input: { unit: "count", step: 1 } },
  rateTransferExport: { type: "int", unit: "count", default: 10, min: 1, max: 10, category: "rateLimits", windowMs: 3_600_000, input: { unit: "count", step: 1 } },
  rateTransferWrite: { type: "int", unit: "count", default: 30, min: 3, max: 30, category: "rateLimits", windowMs: 60_000, input: { unit: "count", step: 1 } },
  sessionTtlSeconds: { type: "int", unit: "seconds", default: 604_800, min: 3_600, max: 2_592_000, category: "signIn", input: { unit: "hours", step: 1 } },
  apiTokensPerUser: { type: "int", unit: "count", default: 20, min: 1, max: 20, category: "signIn", input: { unit: "count", step: 1 } },
} as const satisfies Record<string, SiteLimitDef>;
export type SiteLimitKey = keyof typeof SITE_LIMITS;

/** 註冊表順序（錯誤「只報第一個」與 API `items` 的順序都用它）。 */
export const SITE_LIMIT_KEYS: readonly SiteLimitKey[] = Object.freeze(Object.keys(SITE_LIMITS) as SiteLimitKey[]);

/**
 * 放寬型別的取用：`SITE_LIMITS[k]`（k 是變數）取到各項字面型別的聯集，讀 `.env`／`.windowMs` 會 TS2339。
 * 讀這些屬性且 key 是 `SiteLimitKey` 變數時都經它；要字面 `default` 的地方直接用 `SITE_LIMITS.<key>.default`。
 */
export function siteLimitDef(key: SiteLimitKey): SiteLimitDef {
  const d: SiteLimitDef = SITE_LIMITS[key];
  return d;
}

/** 允許的「API 單位／輸入單位」配對與換算；不在表裡的配對一律丟錯（新增單位要先在這裡明列）。 */
const STEP_FACTORS: Readonly<Record<string, number>> = {
  "count/count": 1,
  "mib/mib": 1,
  "seconds/seconds": 1,
  "ms/ms": 1,
  "bytes/mib": 1_048_576,
  "ms/seconds": 1_000,
  "seconds/hours": 3_600,
};

/** API 單位的刻度：`input.step` 個輸入單位換算成 API 單位（bytes／mib → 1 048 576；ms／seconds → 1 000；seconds／hours → 3 600；同單位 → 1）。 */
export function siteLimitStep(key: SiteLimitKey): number {
  const d = siteLimitDef(key);
  const pair = `${d.unit}/${d.input.unit}`;
  const factor = STEP_FACTORS[pair];
  if (factor === undefined) throw new Error(`siteLimitStep: unsupported unit pair ${pair} (${key})`);
  return d.input.step * factor;
}

export type SiteLimitSource = "env" | "admin" | "default" | "auto";

export interface SiteLimitItemDto {
  key: SiteLimitKey;
  /** 生效值。 */
  value: number;
  source: SiteLimitSource;
  /** `source === "env"`。 */
  locked: boolean;
  /** `site_limits` 存的值（env 鎖住或被忽略時也照實回）。 */
  stored: number | null;
  /** 存的值超出目前範圍、未套用。 */
  storedIgnored?: true;
  /** 只有自動項：現在自動會是多少。 */
  autoValue?: number;
  /** 只有 `parseWorkers`。 */
  autoSource?: "cpu" | "memory";
}

export interface SiteLimitChangeDto {
  id: string;
  /** 不在註冊表的紀錄照回（UI 顯示原始 key）。 */
  key: string;
  oldValue: number | null;
  newValue: number | null;
  oldEffective: number;
  newEffective: number;
  /** null＝帳號已不存在。 */
  actor: { id: string; email: string; displayName: string | null } | null;
  changedAt: string;
}

/** `GET /api/admin/limits`、`PATCH /api/admin/limits` 的回應。 */
export interface SiteLimitsDto {
  items: SiteLimitItemDto[];
  machine: {
    cpus: number;
    cpuSource: "cgroup-v2" | "cgroup-v1" | "os";
    memoryBytes: number;
    memorySource: "cgroup-v2" | "cgroup-v1" | "os";
  };
  /** 最近 50 筆，`changed_at DESC, id DESC`。 */
  changes: SiteLimitChangeDto[];
}

/** `PATCH /api/admin/limits` 的 body；`null`＝恢復預設／自動。 */
export interface SiteLimitsPatchBody {
  set: Partial<Record<SiteLimitKey, number | null>>;
}
