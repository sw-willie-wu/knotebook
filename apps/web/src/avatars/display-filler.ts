import type { AvatarCropDto, AvatarCropUpload } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { resetFillerUser, setFillerUserChangeHandler } from "./filler-user";

/**
 * 背景補產顯示圖：OIDC 帶入的頭貼只有原圖，別人要到本人的瀏覽器替它產生 256 px 顯示圖並送回之後才看得到。
 *
 * 佇列、在途集合與處理過的版本都放在模組層：`AppShell` 每換一頁就重掛，放在元件 state 的話換頁就清空，
 * 同一版會被反覆重抓。這個模組不碰網路也不碰 React；讀原圖、解碼編碼、寫回都經 `configureFiller` 注入，
 * 所以它不依賴 `api/avatars`（反過來 `api/avatars` 在寫入成功時通知這裡）。
 * 解碼與編碼模組（`./encode`）只在第一次真的要補產時才動態載入，不進首包。
 */

export interface FillTarget {
  id: string;
  /** 候選的版本（`AvatarRef.v`）；送回時當前置條件。 */
  v: number;
}

export interface EncodeModule {
  decodeImage(file: Blob): Promise<ImageBitmap>;
  renderDisplay(bitmap: ImageBitmap, crop: AvatarCropDto): Promise<Blob>;
}

export interface FillerDeps {
  fetchOriginal(id: string, signal?: AbortSignal): Promise<Blob>;
  putDisplay(input: { id: string; display: Blob; crop: AvatarCropUpload; version: number; signal?: AbortSignal }): Promise<unknown>;
  /** 重抓目前使用者與候選清單；不代表有頭貼被寫入（寫入成功由這個模組自己通知）。 */
  invalidate(): void;
  /** 載入解碼／編碼模組；預設是動態 `import("./encode")`。 */
  loadEncode?: () => Promise<EncodeModule>;
  /** `server_busy` 退避多久再試一次（毫秒）。 */
  backoffMs?: number;
  /** 讀原圖與送回顯示圖各自的逾時（毫秒）；逾時記為失敗，不重試。 */
  timeoutMs?: number;
}

interface QueueItem extends FillTarget {
  retried: boolean;
}

const DEFAULT_BACKOFF_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;

let deps: FillerDeps | null = null;
let queue: QueueItem[] = [];
/** 排過的版本（含在途、成功、失敗）：同一版不再排第二次。 */
let seen = new Set<string>();
let running = false;
let encodePromise: Promise<EncodeModule> | null = null;
let quotaFailed = new Map<string, FillTarget>();
const cropOpen = new Map<string, number>();
const retryTimers = new Map<ReturnType<typeof setTimeout>, FillTarget>();
/** 每次清掉狀態就加一：清掉之前開始的補產，結果不再處理。 */
let generation = 0;
const listeners = new Set<() => void>();

const keyOf = (target: FillTarget): string => `${target.id}:${target.v}`;

function emit(): void {
  for (const listener of listeners) listener();
}

/** 設定讀寫與失效的實作；每次渲染重設無妨（只換引用）。 */
export function configureFiller(next: FillerDeps): void {
  deps = next;
}

/** 排入一張待補的候選。同一 `(id, v)` 只會處理一次。 */
export function enqueueFill(target: FillTarget): void {
  const key = keyOf(target);
  if (seen.has(key)) return;
  seen.add(key);
  queue.push({ id: target.id, v: target.v, retried: false });
  void pump();
}

/** 某張候選的裁切框開啟時登記，佇列會跳過它；回傳的函式解除登記。 */
export function registerCropOpen(id: string): () => void {
  cropOpen.set(id, (cropOpen.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (cropOpen.get(id) ?? 1) - 1;
    if (left <= 0) cropOpen.delete(id);
    else cropOpen.set(id, left);
    void pump();
  };
}

/** 這張候選版本 `v` 以前的待處理項目丟掉（排隊中、等重試、配額失敗）：它剛被別的路徑寫入，舊版本再補只會撞版本；更新的版本不動。 */
export function dropQueuedFill(id: string, v: number): void {
  const stale = (target: FillTarget): boolean => target.id === id && target.v <= v;
  queue = queue.filter(item => !stale(item));
  for (const [timer, target] of retryTimers) {
    if (!stale(target)) continue;
    clearTimeout(timer);
    retryTimers.delete(timer);
  }
  const before = quotaFailed.size;
  quotaFailed = new Map([...quotaFailed].filter(([, target]) => !stale(target)));
  if (quotaFailed.size !== before) emit();
}

/** 任何一次頭貼寫入成功（上傳、重新裁切、選用、刪除、重新取得、補產）：因空間不足失敗的項目重新排入。 */
export function notifyAvatarWritten(): void {
  if (quotaFailed.size === 0) return;
  const retry = [...quotaFailed.values()];
  quotaFailed = new Map();
  for (const target of retry) {
    seen.delete(keyOf(target));
    enqueueFill(target);
  }
  emit();
}

export function subscribeFiller(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 因空間不足而補不出顯示圖的版本；每次變動換一個新的 Map（供 `useSyncExternalStore` 比對）。 */
export function getQuotaFailed(): ReadonlyMap<string, FillTarget> {
  return quotaFailed;
}

export function fillKey(target: FillTarget): string {
  return keyOf(target);
}

/** 換了使用者（同一分頁登出再登入）：前一位的佇列、記憶與失敗全部作廢。已在跑的那一張跑完後結果被丟掉。 */
export function clearFillerState(): void {
  generation += 1;
  queue = [];
  seen = new Set();
  quotaFailed = new Map();
  for (const timer of retryTimers.keys()) clearTimeout(timer);
  retryTimers.clear();
  emit();
}

/** 測試用：清掉所有模組層狀態。 */
export function resetFiller(): void {
  deps = null;
  running = false;
  encodePromise = null;
  cropOpen.clear();
  resetFillerUser();
  clearFillerState();
}

function loadEncode(): Promise<EncodeModule> {
  // 只在第一次需要時載入；失敗不快取，下一張再試。
  encodePromise ??= (deps?.loadEncode ?? (() => import("./encode")))().catch((err: unknown) => {
    encodePromise = null;
    throw err;
  });
  return encodePromise;
}

/** 回傳 false＝裁切框在補產途中開了，沒有送出（項目已放回佇列）。 */
async function fill(item: QueueItem, active: FillerDeps, started: number): Promise<boolean> {
  const timeoutMs = active.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const original = await active.fetchOriginal(item.id, AbortSignal.timeout(timeoutMs));
  const encode = await loadEncode();
  // 裁切數學與編碼一樣只在真的要補產時才載入，不進首包。
  const { centeredCrop } = await import("./crop-math");
  const bitmap = await encode.decodeImage(original);
  let display: Blob;
  let crop: AvatarCropDto;
  const width = bitmap.width;
  const height = bitmap.height;
  try {
    crop = centeredCrop(width, height);
    display = await encode.renderDisplay(bitmap, crop);
  } finally {
    bitmap.close();
  }
  // 換了使用者：這張是前一位的，不送。
  if (started !== generation) return false;
  // 補產途中使用者開了這張的裁切框：現在送出會讓版本變動，他按儲存就撞 `avatar_outdated`。
  if (cropOpen.has(item.id)) {
    queue.push(item);
    return false;
  }
  await active.putDisplay({ id: item.id, display, crop: { ...crop, width, height }, version: item.v, signal: AbortSignal.timeout(timeoutMs) });
  return true;
}

function scheduleRetry(item: QueueItem, backoffMs: number): void {
  const timer = setTimeout(() => {
    retryTimers.delete(timer);
    queue.push({ id: item.id, v: item.v, retried: true });
    void pump();
  }, backoffMs);
  retryTimers.set(timer, { id: item.id, v: item.v });
}

async function pump(): Promise<void> {
  if (running || deps === null) return;
  running = true;
  try {
    for (;;) {
      const active = deps;
      if (active === null) return;
      const index = queue.findIndex(item => !cropOpen.has(item.id));
      if (index < 0) return;
      const [item] = queue.splice(index, 1) as [QueueItem];
      const started = generation;
      try {
        const sent = await fill(item, active, started);
        if (started !== generation) continue;
        if (sent) {
          active.invalidate();
          notifyAvatarWritten();
        }
      } catch (err) {
        if (started !== generation) continue;
        if (err instanceof ApiFail && err.code === "server_busy" && !item.retried) {
          scheduleRetry(item, active.backoffMs ?? DEFAULT_BACKOFF_MS);
        } else if (err instanceof ApiFail && err.code === "avatar_outdated") {
          // 別處已補好或原圖剛被替換：重抓後以新版本照常處理（沒有寫入，所以不重排配額失敗的項目）。
          active.invalidate();
        } else if (err instanceof ApiFail && err.code === "storage_quota_exceeded") {
          quotaFailed = new Map(quotaFailed).set(keyOf(item), { id: item.id, v: item.v });
          emit();
        }
        // 其餘（網路、500、解碼失敗、404、413、415、429…）：這一版記為失敗，本分頁不再重試。
      }
    }
  } finally {
    running = false;
  }
}

// 補產本體一載入就登記：換人時由首包的薄殼經 `syncFillerUser` 觸發清除。
setFillerUserChangeHandler(clearFillerState);
