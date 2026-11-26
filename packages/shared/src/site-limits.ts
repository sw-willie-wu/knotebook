export type SiteLimitCategory = "uploadsNotes" | "parseWorkers" | "rateLimits" | "bulkTransfer" | "signIn";
export type SiteLimitUnit = "bytes" | "mib" | "ms" | "seconds" | "count";

export interface SiteLimitDef {
  type: "int";
  unit: SiteLimitUnit;
  default: number | "auto";
  /** Admin page range (inclusive); env values have their own range in config.ts. */
  min: number;
  max: number;
  /** Existing env names only; don't add new ones. */
  env?: "NOTE_MAX_BYTES" | "PARSE_WORKERS" | "PARSE_WORKER_MEMORY_MB" | "PARSE_TIMEOUT_MS" | "PARSE_QUEUE_WAIT_MS";
  category: SiteLimitCategory;
  /** Display only; server tests assert it equals the constant in rate-limit.ts. */
  windowMs?: number;
  input: { unit: "mib" | "seconds" | "hours" | "count"; step: number };
}

/** Separate constant: limits.ts reading SITE_LIMITS at module top level would stop Rollup tree-shaking the registry out of the web bundle. */
export const UPLOAD_MAX_BYTES_DEFAULT = 10_485_760;

export const SITE_LIMITS = {
  uploadMaxBytes: { type: "int", unit: "bytes", default: UPLOAD_MAX_BYTES_DEFAULT, min: 1_048_576, max: 10_485_760, category: "uploadsNotes", input: { unit: "mib", step: 1 } },
  uploadMediaMaxMib: { type: "int", unit: "mib", default: 100, min: 10, max: 1_048_576, category: "uploadsNotes", input: { unit: "mib", step: 1 } },
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

/** Order matters: validation reports only the first failing key, and API items follow it. */
export const SITE_LIMIT_KEYS: readonly SiteLimitKey[] = Object.freeze(Object.keys(SITE_LIMITS) as SiteLimitKey[]);

/** Indexing SITE_LIMITS with a variable key gives a union where `.env`/`.windowMs` are TS2339; this widens it. */
export function siteLimitDef(key: SiteLimitKey): SiteLimitDef {
  const d: SiteLimitDef = SITE_LIMITS[key];
  return d;
}

const STEP_FACTORS: Readonly<Record<string, number>> = {
  "count/count": 1,
  "mib/mib": 1,
  "seconds/seconds": 1,
  "ms/ms": 1,
  "bytes/mib": 1_048_576,
  "ms/seconds": 1_000,
  "seconds/hours": 3_600,
};

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
  value: number;
  source: SiteLimitSource;
  locked: boolean;
  /** The `site_limits` value, returned even when env-locked or ignored. */
  stored: number | null;
  /** The stored value is outside the current range and not applied. */
  storedIgnored?: true;
  autoValue?: number;
  autoSource?: "cpu" | "memory";
}

export interface SiteLimitChangeDto {
  id: string;
  /** Keys not in the registry are returned as-is (the UI shows the raw key). */
  key: string;
  oldValue: number | null;
  newValue: number | null;
  oldEffective: number;
  newEffective: number;
  /** null: the account no longer exists. */
  actor: { id: string; email: string; displayName: string | null } | null;
  changedAt: string;
}

export interface SiteLimitsDto {
  items: SiteLimitItemDto[];
  machine: {
    cpus: number;
    cpuSource: "cgroup-v2" | "cgroup-v1" | "os";
    memoryBytes: number;
    memorySource: "cgroup-v2" | "cgroup-v1" | "os";
  };
  /** Latest 50, changed_at DESC, id DESC. */
  changes: SiteLimitChangeDto[];
}

/** `null` restores the default or auto value. */
export interface SiteLimitsPatchBody {
  set: Partial<Record<SiteLimitKey, number | null>>;
}
