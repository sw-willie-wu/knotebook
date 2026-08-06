/**
 * 分桶備份保留策略（純函式，時間一律外部注入——不得在本檔任何地方直接呼叫
 * `Date.now()`/`new Date()`，否則單元測試無法用固定向量重現）。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 保留規則（brief §Interfaces 逐字約定，rev 3 已依 newest-per-bucket 重算）
 * ──────────────────────────────────────────────────────────────────────────
 * 桶一律 `[start, end)` 半開區間、對齊 UTC 時鐘：
 *   - 15分層：最近 4 個**已結束**（不含正在進行中、即包含 now 的那一桶）的對齊 15 分桶。
 *   - 小時層：最近 6 個**已結束**的對齊小時桶（同上，不含 now 所在的當前小時桶）。
 *   - 日層：最近 7 個 UTC 日曆日（**含今日**——與前兩層刻意不對稱，brief 明訂）。
 * 每桶保留「最新」1 筆（同一筆可同時滿足多層，聯集去重）；其餘全刪。
 *
 * 15分/小時層為何不含「現在所在的那一桶」而日層含：15分/小時桶會在本 process 存活期間
 * 自然跨進下一桶並產生新的最新備份，此刻仍在進行中的桶不用急著保留一筆「還會被更新」
 * 的快照；日層的「今日」則是唯一代表「今天」的桶，若不含今日，剛過午夜就會立刻少一天
 * 的備份覆蓋，與「最近 7 天」的直覺不符——這個不對稱是刻意的，已用具體向量核對過。
 */

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface BucketTier {
  sizeMs: number;
  count: number;
  /** true：N 桶中最新的一桶就是「現在」所在的那一桶（日層）；false：從現在所在桶的前一桶開始算（15分/小時層）。 */
  includeCurrentBucket: boolean;
}

const TIERS: readonly BucketTier[] = [
  { sizeMs: FIFTEEN_MIN_MS, count: 4, includeCurrentBucket: false },
  { sizeMs: HOUR_MS, count: 6, includeCurrentBucket: false },
  { sizeMs: DAY_MS, count: 7, includeCurrentBucket: true },
];

/** 對齊到 `sizeMs` 邊界的桶起點（epoch ms）。UTC 曆日恰好也是 `DAY_MS` 對齊，同一公式通用。 */
function bucketStart(epochMs: number, sizeMs: number): number {
  return Math.floor(epochMs / sizeMs) * sizeMs;
}

/**
 * 是否已跨過 15 分桶邊界（本 policy 唯一用來判斷「該不該考慮寫一筆新備份」的時間粒度；
 * 小時/日層只影響「留幾筆」的 pruning，不影響「要不要寫」）。
 *
 * `lastBackupAt` 為 `null`（從未備份過）一律回傳 `true`。
 */
export function crossesBucketBoundary(lastBackupAt: Date | null, now: Date): boolean {
  if (lastBackupAt === null) return true;
  return bucketStart(lastBackupAt.getTime(), FIFTEEN_MIN_MS) !== bucketStart(now.getTime(), FIFTEEN_MIN_MS);
}

/** 某一層在 `now` 當下要保留的 N 個對齊桶起點（epoch ms），由新到舊。 */
function tierBucketStarts(tier: BucketTier, now: Date): number[] {
  const current = bucketStart(now.getTime(), tier.sizeMs);
  const newest = tier.includeCurrentBucket ? current : current - tier.sizeMs;
  const starts: number[] = [];
  for (let i = 0; i < tier.count; i += 1) {
    starts.push(newest - i * tier.sizeMs);
  }
  return starts;
}

/**
 * 給定既有備份時間戳與現在時刻，回傳「該刪除」的子集合——即 `existing` 扣掉三層聯集各自
 * newest-per-bucket 選出的保留集合。回傳的是 `existing` 中原始的 `Date` 物件（保留參照
 * 同一性，呼叫方可用它們反查對應的 DB row）。
 */
export function selectPrunable(existing: Date[], now: Date): Date[] {
  const keep = new Set<Date>();

  for (const tier of TIERS) {
    for (const start of tierBucketStarts(tier, now)) {
      const end = start + tier.sizeMs;
      let newest: Date | null = null;
      for (const d of existing) {
        const t = d.getTime();
        if (t < start || t >= end) continue;
        if (newest === null || t > newest.getTime()) newest = d;
      }
      if (newest !== null) keep.add(newest);
    }
  }

  return existing.filter(d => !keep.has(d));
}
