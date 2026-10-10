/**
 * 自動版本的分層稀疏清除（spec 2026-10-09-note-versions-design.md §10.1）。純函式，時間一律外部注入——檔內不得呼叫
 * `Date.now()`／`new Date()`（`version-policy.test.ts` 有源碼守衛），同 `backup-policy.ts` 的慣例。
 *
 * 永遠留：手動版本、基底那版、最新一版（seq 最大）。其餘自動版本依 `age = now − createdAt` 分三個區間：
 *   age < F 天：全留；F ≤ age < D：**只在這個區間的候選之間**每個 UTC 日曆日留 createdAt 最新一筆；age ≥ D：**只在這個區間的候選之間**
 *   每個 UTC 週（週一 00:00 起）留最新一筆。同 createdAt 留 seq 大者。UTC 切桶是設計選擇（PR2 的 docs/versions.md 會寫）。
 * age 為負（時鐘回撥）算在 F 內。
 */
export interface VersionPolicyRow {
  seq: number;
  kind: string;
  createdAt: Date;
}

export interface VersionPolicyOpts {
  now: Date;
  keepAllDays: number;
  dailyUntilDays: number;
  baseSeq: number | null;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** epoch（1970-01-01）是週四；1970-01-05 是週一——週桶以它對齊。 */
const MONDAY_EPOCH_OFFSET_MS = 4 * DAY_MS;

const dayKey = (t: number): number => Math.floor(t / DAY_MS);
const weekKey = (t: number): number => Math.floor((t - MONDAY_EPOCH_OFFSET_MS) / WEEK_MS);
const newer = (a: VersionPolicyRow, b: VersionPolicyRow): boolean =>
  a.createdAt.getTime() > b.createdAt.getTime() || (a.createdAt.getTime() === b.createdAt.getTime() && a.seq > b.seq);

export function selectVersionsToDelete(rows: VersionPolicyRow[], opts: VersionPolicyOpts): number[] {
  if (rows.length === 0) return [];
  const newestSeq = rows.reduce((m, r) => (r.seq > m ? r.seq : m), rows[0]!.seq);
  const nowMs = opts.now.getTime();
  const keepAllMs = opts.keepAllDays * DAY_MS;
  const dailyUntilMs = opts.dailyUntilDays * DAY_MS;
  const keep = new Set<number>();
  const daily = new Map<number, VersionPolicyRow>();
  const weekly = new Map<number, VersionPolicyRow>();
  for (const r of rows) {
    if (r.kind === "manual" || r.seq === opts.baseSeq || r.seq === newestSeq) {
      keep.add(r.seq);
      continue;
    }
    const t = r.createdAt.getTime();
    const age = nowMs - t;
    if (age < keepAllMs) {
      keep.add(r.seq);
      continue;
    }
    const [bucket, key] = age < dailyUntilMs ? [daily, dayKey(t)] : [weekly, weekKey(t)];
    const cur = bucket.get(key);
    if (cur === undefined || newer(r, cur)) bucket.set(key, r);
  }
  for (const r of daily.values()) keep.add(r.seq);
  for (const r of weekly.values()) keep.add(r.seq);
  return rows.filter(r => !keep.has(r.seq)).map(r => r.seq).sort((a, b) => a - b);
}
