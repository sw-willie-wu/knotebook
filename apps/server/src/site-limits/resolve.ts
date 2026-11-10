/**
 * #397 §6.2／§6.4：`resolveSnapshot`——把 `site_limits` 的列、env、機器資訊算成生效值快照（純函式）。
 * `load` 與 `update` 共用；不合格的列只進 `ignored`、不套用、不刪。
 */
import { SITE_LIMIT_KEYS, SITE_LIMITS, siteLimitDef, siteLimitStep, type SiteLimitKey, type SiteLimitSource } from "@knotebook/shared";
import { autoParseWorkers, autoQueueWaitMs } from "./auto.js";
import type { LimitEnv, MachineInfo } from "./types.js";

/** 先範圍後刻度；`update` 與 `resolveSnapshot` 共用，兩邊不會判得不一樣。 */
export function checkStorable(key: SiteLimitKey, value: number): "ok" | "range" | "step" {
  const { min, max } = siteLimitDef(key);
  if (!Number.isInteger(value) || value < min || value > max) return "range";
  return value % siteLimitStep(key) === 0 ? "ok" : "step";
}

export interface Snapshot {
  values: Record<SiteLimitKey, number>;
  source: Record<SiteLimitKey, SiteLimitSource>;
  /** 「現在自動會是多少」（不論該項實際是不是自動）。 */
  autoValue: { parseWorkers: number; parseQueueWaitMs: number };
  autoSource: "cpu" | "memory";
  /** 未知 key 或 `checkStorable` 不是 ok 的列（不套用）。 */
  ignored: Array<{ key: string; value: number }>;
}

const KEY_SET: ReadonlySet<string> = new Set(SITE_LIMIT_KEYS);

export function resolveSnapshot(rows: ReadonlyMap<string, number>, limitEnv: LimitEnv, machine: MachineInfo): Snapshot {
  const values = {} as Record<SiteLimitKey, number>;
  const source = {} as Record<SiteLimitKey, SiteLimitSource>;
  const ignored: Snapshot["ignored"] = [];
  for (const [key, value] of rows) {
    if (!KEY_SET.has(key) || checkStorable(key as SiteLimitKey, value) !== "ok") ignored.push({ key, value });
  }
  const bad = new Set(ignored.map(i => i.key));

  // 先解非自動項（兩個自動項若有 env／合格的列也先放進來，下面再補自動值）。
  const pending: SiteLimitKey[] = [];
  for (const key of SITE_LIMIT_KEYS) {
    const envValue = limitEnv[key];
    const row = rows.get(key);
    if (envValue !== undefined) {
      values[key] = envValue;
      source[key] = "env";
    } else if (row !== undefined && !bad.has(key)) {
      values[key] = row;
      source[key] = "admin";
    } else {
      const def = SITE_LIMITS[key].default;
      if (def === "auto") {
        pending.push(key);
        source[key] = "auto";
      } else {
        values[key] = def;
        source[key] = "default";
      }
    }
  }

  // 自動值用「生效的」記憶體上限與時限算。
  const workers = autoParseWorkers(machine, values.parseWorkerMemoryMb);
  const queueWait = autoQueueWaitMs(values.parseTimeoutMs);
  for (const key of pending) values[key] = key === "parseWorkers" ? workers.value : queueWait;

  return {
    values,
    source,
    autoValue: { parseWorkers: workers.value, parseQueueWaitMs: queueWait },
    autoSource: workers.source,
    ignored,
  };
}
