/**
 * #397 §6.1：`SiteLimits`——站台限制的設定存取層。S3 只有唯讀面（`defaults()` 與讀取方法）；`load`／`update` 在 S4。
 */
import { SITE_LIMIT_KEYS, siteLimitDef, type SiteLimitItemDto, type SiteLimitKey, type SiteLimitsDto } from "@knotebook/shared";
import type pino from "pino";
import type { Db } from "../db/index.js";
import type { ParseLimits } from "../notes/editing/parse-settings.js";
import { resolveSnapshot, type Snapshot } from "./resolve.js";
import type { LimitEnv, MachineInfo } from "./types.js";

export type SiteLimitsView = Pick<SiteLimitsDto, "items" | "machine">;

type Listener = (keys: ReadonlySet<SiteLimitKey>) => void;

interface Deps {
  db: Db | null;
  limitEnv: LimitEnv;
  machine: MachineInfo;
  log: pino.Logger | null;
  rows: Map<string, number>;
}

export class SiteLimits {
  private readonly db: Db | null;
  private readonly limitEnv: LimitEnv;
  private readonly machine: MachineInfo;
  private readonly log: pino.Logger | null;
  private rows: Map<string, number>;
  private snapshot: Snapshot;
  private readonly listeners = new Set<Listener>();

  private constructor(deps: Deps) {
    this.db = deps.db;
    this.limitEnv = deps.limitEnv;
    this.machine = deps.machine;
    this.log = deps.log;
    this.rows = deps.rows;
    for (const key of Object.keys(this.limitEnv) as SiteLimitKey[]) {
      if (this.limitEnv[key] !== undefined && siteLimitDef(key).env === undefined) {
        throw new Error(`SiteLimits: limitEnv has key ${key} but the registry entry has no env`);
      }
    }
    this.snapshot = resolveSnapshot(this.rows, this.limitEnv, this.machine);
  }

  /** 不碰 DB、同步：等於「`site_limits` 沒有列」的那份（env＞預設／自動）。`update` 一律拒絕。 */
  static defaults(opts: { limitEnv?: LimitEnv; machine: MachineInfo }): SiteLimits {
    return new SiteLimits({ db: null, limitEnv: opts.limitEnv ?? {}, machine: opts.machine, log: null, rows: new Map() });
  }

  /** 生效值，同步、O(1)；永遠是整數。 */
  get(key: SiteLimitKey): number {
    return this.snapshot.values[key];
  }

  /** 這一項被哪個 env 鎖住；沒鎖回 undefined。鎖定狀態的唯一來源。 */
  envName(key: SiteLimitKey): ReturnType<typeof siteLimitDef>["env"] | undefined {
    return this.limitEnv[key] === undefined ? undefined : siteLimitDef(key).env;
  }

  /** 解析 pool 要的四項（含自動值）。 */
  parseLimits(): ParseLimits {
    const v = this.snapshot.values;
    return { workers: v.parseWorkers, workerMemoryMb: v.parseWorkerMemoryMb, timeoutMs: v.parseTimeoutMs, queueWaitMs: v.parseQueueWaitMs };
  }

  view(): SiteLimitsView {
    const s = this.snapshot;
    const ignoredKeys = new Set(s.ignored.map(i => i.key));
    const items: SiteLimitItemDto[] = SITE_LIMIT_KEYS.map(key => {
      const item: SiteLimitItemDto = {
        key,
        value: s.values[key],
        source: s.source[key],
        locked: this.envName(key) !== undefined,
        stored: this.rows.get(key) ?? null,
      };
      if (ignoredKeys.has(key)) item.storedIgnored = true;
      if (key === "parseWorkers") {
        item.autoValue = s.autoValue.parseWorkers;
        item.autoSource = s.autoSource;
      } else if (key === "parseQueueWaitMs") {
        item.autoValue = s.autoValue.parseQueueWaitMs;
      }
      return item;
    });
    return { items, machine: { ...this.machine } };
  }

  /** 唯讀實例（`defaults()`）一律拒絕；先檢查這個，之後才（S4）驗證與寫入。 */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- S4 才用到參數
  async update(_actorUserId: string, _changes: Partial<Record<SiteLimitKey, number | null>>): Promise<SiteLimitsView> {
    if (this.db === null) throw new Error("SiteLimits.defaults() is read-only");
    throw new Error("SiteLimits.update is not implemented yet (S4)");
  }

  /** 生效值有變的 key → 通知訂閱者；回傳解除訂閱的函式。 */
  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
