/**
 * #397 §6.1：`SiteLimits`——站台限制的設定存取層。`load` 讀 `site_limits` 全表、`defaults()` 不碰 DB；
 * `update` 先驗、再在行程內互斥鎖下跑交易（§6.4、§6.5）。
 */
import { SITE_LIMIT_KEYS, siteLimitDef, type SiteLimitItemDto, type SiteLimitKey, type SiteLimitsDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { siteLimits } from "../db/schema.js";
import { updateSiteLimitsInTx, type UpdateSiteLimitsInput } from "../auth/tx/admin-site-limits.js";
import type { ParseLimits } from "../notes/editing/parse-settings.js";
import { LimitLockedError, LimitRangeError, LimitStepError } from "./errors.js";
import { checkStorable, resolveSnapshot, type Snapshot } from "./resolve.js";
import type { LimitEnv, MachineInfo } from "./types.js";

export type SiteLimitsView = Pick<SiteLimitsDto, "items" | "machine">;

/** `load` 要的 logger 形狀（pino／Fastify 的 logger 都合）。 */
export type SiteLimitsLog = { warn(obj: object, msg: string): void; error(obj: object, msg: string): void };

type Listener = (keys: ReadonlySet<SiteLimitKey>) => void;
type Changes = Partial<Record<SiteLimitKey, number | null>>;

const KEY_SET: ReadonlySet<string> = new Set(SITE_LIMIT_KEYS);

interface Deps {
  db: Db | null;
  limitEnv: LimitEnv;
  machine: MachineInfo;
  log: SiteLimitsLog | null;
  rows: Map<string, number>;
}

export class SiteLimits {
  private readonly db: Db | null;
  private readonly limitEnv: LimitEnv;
  private readonly machine: MachineInfo;
  private readonly log: SiteLimitsLog | null;
  private rows: Map<string, number>;
  private snapshot: Snapshot;
  private readonly listeners = new Set<Listener>();
  /** 行程內 async 互斥鎖（promise chain）：一次一個 `update` 跑「試算＋交易＋套用」（§6.5）。 */
  private lockTail: Promise<void> = Promise.resolve();

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

  /**
   * 讀 `site_limits` 全表 → `resolveSnapshot`。不套用的列（未知 key、越界、沒對齊）逐筆 `log.warn`、列不刪（§6.4）。
   * 讀不到 DB 就 reject（開機失敗，同 migration）。
   */
  static async load(db: Db, opts: { limitEnv: LimitEnv; machine: MachineInfo; log: SiteLimitsLog }): Promise<SiteLimits> {
    const rows = await db.select({ key: siteLimits.key, value: siteLimits.value }).from(siteLimits);
    const s = new SiteLimits({ db, limitEnv: opts.limitEnv, machine: opts.machine, log: opts.log, rows: new Map(rows.map(r => [r.key, r.value])) });
    for (const { key, value } of s.snapshot.ignored) {
      const def = KEY_SET.has(key) ? siteLimitDef(key as SiteLimitKey) : undefined;
      opts.log.warn({ key, value, min: def?.min, max: def?.max }, "site limit stored value ignored");
    }
    return s;
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

  /**
   * PATCH 用（§6.4、§6.5）。唯讀實例（`defaults()`）一律拒絕。
   * 1. 進鎖之前、單一一輪依註冊表順序逐 key 驗：env 鎖（`null` 也算）→ 範圍 → 刻度，第一個失敗就丟（什麼都不寫）。
   * 2. 行程內互斥鎖下：以目前的 `rows` 試算改前／改後生效值 → 交易 → 用交易回傳的整張表重算快照 → 生效值有變的 key 發 `onChange`。
   * 3. `finally` 放鎖：交易或重算拋錯時記憶體不動、下一次 `update` 不卡。
   */
  async update(actorUserId: string, changes: Changes): Promise<SiteLimitsView> {
    if (this.db === null) throw new Error("SiteLimits.defaults() is read-only");
    const set = this.validate(changes);

    const release = await this.acquireLock();
    try {
      const next = new Map(this.rows);
      for (const key of Object.keys(set) as SiteLimitKey[]) {
        const v = set[key]!;
        if (v === null) next.delete(key);
        else next.set(key, v);
      }
      const before = resolveSnapshot(this.rows, this.limitEnv, this.machine);
      const after = resolveSnapshot(next, this.limitEnv, this.machine);
      const effective: UpdateSiteLimitsInput["effective"] = {};
      for (const key of Object.keys(set) as SiteLimitKey[]) effective[key] = { old: before.values[key], new: after.values[key] };
      const input: UpdateSiteLimitsInput = { actorUserId, set, effective };

      const rows = await this.db.transaction(tx => updateSiteLimitsInTx(tx, input));

      const newRows = new Map(rows.map(r => [r.key, r.value]));
      const newSnapshot = resolveSnapshot(newRows, this.limitEnv, this.machine);
      const oldValues = this.snapshot.values;
      this.rows = newRows;
      this.snapshot = newSnapshot;
      const changed = new Set<SiteLimitKey>(SITE_LIMIT_KEYS.filter(k => oldValues[k] !== newSnapshot.values[k]));
      if (changed.size > 0) {
        for (const fn of [...this.listeners]) {
          try {
            fn(changed);
          } catch (err) {
            this.log?.error({ err }, "site limits onChange listener failed");
          }
        }
      }
      return this.view();
    } finally {
      release();
    }
  }

  /** 生效值有變的 key → 通知訂閱者；回傳解除訂閱的函式。 */
  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 單一一輪、依 `SITE_LIMIT_KEYS` 順序逐 key：env 鎖 → 範圍 → 刻度；第一個失敗就丟。回傳去掉 `undefined` 的 changes。 */
  private validate(changes: Changes): Changes {
    for (const key of Object.keys(changes)) {
      if (!KEY_SET.has(key)) throw new Error(`SiteLimits.update: unknown key ${key}`);
    }
    const set: Changes = {};
    for (const key of SITE_LIMIT_KEYS) {
      const v = changes[key];
      if (v === undefined) continue;
      const env = this.envName(key);
      if (env !== undefined) throw new LimitLockedError(key, env);
      if (v !== null) {
        const r = checkStorable(key, v);
        if (r === "range") throw new LimitRangeError(key);
        if (r === "step") throw new LimitStepError(key);
      }
      set[key] = v;
    }
    return set;
  }

  /** 取鎖：等前一個持有者放鎖；回傳放鎖函式（呼叫端在 `finally` 呼叫）。 */
  private async acquireLock(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const prev = this.lockTail;
    this.lockTail = prev.then(() => held);
    await prev;
    return release;
  }
}
