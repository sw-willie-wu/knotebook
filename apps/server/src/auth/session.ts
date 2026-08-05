import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { users } from "../db/schema.js";

const SESSION_TTL = "7d";

function sessionKey(secret: string): Uint8Array {
  return createHash("sha256").update(`${secret}:session`).digest();
}

export async function signSession(secret: string, payload: { userId: string; tv: number }): Promise<string> {
  const key = sessionKey(secret);
  return new SignJWT({ tv: payload.tv })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(key);
}

export async function verifySession(secret: string, jwt: string): Promise<{ userId: string; tv: number } | null> {
  try {
    const key = sessionKey(secret);
    const { payload } = await jwtVerify(jwt, key, { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.tv !== "number") return null;
    return { userId: payload.sub, tv: payload.tv };
  } catch {
    // 過期、篡改、格式錯誤——一律回 null，不 throw
    return null;
  }
}

export interface GateUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}

export type GateResult = { status: "ok"; user: GateUser } | { status: "revoked" };

export interface GateRow {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  disabledAt: Date | null;
  tokenVersion: number;
}

interface CacheEntry {
  row: GateRow | null;
  expiresAt: number;
}

export interface UserGateOptions {
  /** 快取上限（預設 1000） */
  maxEntries?: number;
  /** 可注入的時鐘（測試用）；預設 Date.now */
  now?: () => number;
  /**
   * 測試用：覆寫查 DB 的方式（例如注入延遲，重現 invalidate 與 in-flight fetch 的 race）。
   * 預設走真正的 `users` 表查詢。production code 不應提供此選項。
   */
  fetchRow?: (userId: string) => Promise<GateRow | null>;
}

const DEFAULT_MAX_ENTRIES = 1000;
const CACHE_TTL_MS = 60_000;

/**
 * 使用者狀態閘：查 users 表判斷 token 是否仍有效（tokenVersion 相符、未被停用）。
 *
 * 內建 LRU-ish 快取（依插入順序淘汰即可，見任務規格）：上限 maxEntries，TTL 60s。
 * `invalidate(userId)` 同步刪除快取條目——這是即時撤銷（改密碼、停權等）的主路徑；
 * TTL 只是保底，確保即使漏呼叫 invalidate，最多 60 秒後也會反映最新 DB 狀態。
 *
 * 快取存的是「查到的 DB row 快照」而非「check() 的結論」：因為 check() 的結論還要
 * 跟呼叫方傳入的 tv 比對（快取命中路徑也一樣要比對，不會因為命中就跳過 tv 檢查），
 * 若只快取結論，同一個 userId 用不同 tv 呼叫時會拿到錯誤答案。
 *
 * invalidate 與 in-flight fetch 的 race：check() 觸發 DB 查詢期間，若另一個呼叫對
 * 同一個 userId 呼叫 invalidate()——此時 cache 裡可能還沒有這個 userId 的條目
 * （第一次 check 還在查），invalidate 的 `cache.delete(userId)` 會是 no-op；接著原本
 * 那個「查詢中」的 fetch 完成，若沒有額外保護，會把這份（早於撤銷時間點的）舊資料
 * 寫進快取並帶 60 秒 TTL，讓撤銷被靜默蓋掉。用一個全域 generation counter 擋掉這個
 * race：`invalidate()` 每次呼叫都遞增 `gen`；`check()` 在發起查詢前先記下當時的
 * `gen`，查詢完成後只有「查詢期間 gen 沒被任何 invalidate() 動過」才寫入快取——
 * 否則寧可這次的結果不快取（下次 check 會重新查 DB），也不要快取到可能已經過期的資料。
 */
export class UserGate {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly fetchRow: (userId: string) => Promise<GateRow | null>;
  private gen = 0;

  constructor(
    private readonly db: Db,
    options: UserGateOptions = {}
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    this.fetchRow = options.fetchRow ?? (userId => this.fetchRowFromDb(userId));
  }

  async check(userId: string, tv: number): Promise<GateResult> {
    let entry = this.cache.get(userId);
    if (!entry || entry.expiresAt <= this.now()) {
      const g = this.gen;
      const row = await this.fetchRow(userId);
      entry = { row, expiresAt: this.now() + CACHE_TTL_MS };
      // 只有查詢期間沒被 invalidate() 打斷（gen 未變）才寫入快取，見上方 class 註解。
      if (g === this.gen) this.store(userId, entry);
    }
    return UserGate.evaluate(entry.row, tv);
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
    this.gen++;
  }

  private async fetchRowFromDb(userId: string): Promise<GateRow | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      isAdmin: row.isAdmin,
      disabledAt: row.disabledAt,
      tokenVersion: row.tokenVersion,
    };
  }

  private store(userId: string, entry: CacheEntry): void {
    // 插入序淘汰：只有這裡（cache miss / TTL 過期後重新查到資料）會寫入快取，
    // 單純的讀取命中（check() 的 cache hit 分支）不會呼叫 store()、不會重排順序。
    // 先刪除已存在的 key 再重新 set，是為了在「TTL 過期後重新查到同一個 userId」時
    // 讓它移到 Map 迭代順序的尾端（視為新插入），維持「最舊的在最前面」，
    // 淘汰時固定砍最前面那個——即最久沒有被重新查詢過的那筆，符合「插入序淘汰即可當
    // LRU」的規格（純讀取命中不影響淘汰順序，是刻意簡化，非嚴格 access-recency LRU）。
    this.cache.delete(userId);
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(userId, entry);
  }

  private static evaluate(row: GateRow | null, tv: number): GateResult {
    if (!row || row.disabledAt !== null || row.tokenVersion !== tv) {
      return { status: "revoked" };
    }
    return {
      status: "ok",
      user: { id: row.id, email: row.email, displayName: row.displayName, isAdmin: row.isAdmin },
    };
  }
}
