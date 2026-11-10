import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE, SITE_LIMITS } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { sessions, users } from "../db/schema.js";
import { BoundedMap } from "../lib/bounded-map.js";

// 網頁登入有效期的**預設值**（註冊表 `sessionTtlSeconds` 的 default，7 天）。實際簽發用的有效期由管理員調整（#397）：
// 每次簽發 session 時讀一次 `siteLimits.get("sessionTtlSeconds")`，同一個值傳給 `signSession`（JWT 的 exp）、
// `setSessionCookie`（cookie 的 maxAge）與 `newSessionValues`（`sessions.expires_at`），見 `auth/sessions.ts`。
// 簽發路徑不用這個常數。
export const SESSION_TTL_SECONDS = SITE_LIMITS.sessionTtlSeconds.default;

function sessionKey(secret: string): Uint8Array {
  return createHash("sha256").update(`${secret}:session`).digest();
}

/** `sid` 的形狀：`sessions.id` 是 uuid 欄位，非 uuid 的字串進查詢會 22P02（→ 500），在驗簽階段就擋掉。collab token 也用（`collab/token.ts`）。 */
export const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 只簽 JWT，**不建 sessions 列**——登入路徑一律先建列再簽：一般登入走 `auth/sessions.ts` 的 `startSession`，改密碼／加上密碼／
 * 重設密碼在各自的交易裡換列（`auth/tx/change-password.ts`、`auth/tx/password-reset.ts`）後走 `setSessionCookieFor`。
 * `sid` 是 `sessions.id`（#388）：沒有對應列的 JWT 過不了 `UserGate.check`。
 * `ttlSeconds` 必須跟建那一列（`newSessionValues`）與 cookie 的 maxAge 用同一個值（#397）：列比 JWT 先到期的話，
 * `UserGate.check` 會判 revoked，使用者在 cookie 到期前就被登出。
 */
export async function signSession(secret: string, payload: { userId: string; tv: number; sid: string }, ttlSeconds: number): Promise<string> {
  const key = sessionKey(secret);
  return new SignJWT({ tv: payload.tv, sid: payload.sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.userId)
    .setIssuedAt()
    // jose 的 duration 字串只認 "<數字><單位>"；用秒，直接由傳入的秒數組出。
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}

export async function verifySession(secret: string, jwt: string): Promise<{ userId: string; tv: number; sid: string } | null> {
  try {
    const key = sessionKey(secret);
    const { payload } = await jwtVerify(jwt, key, { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.tv !== "number") return null;
    // #388：沒有 `sid` 的舊 JWT（升級前簽的）一律視為未登入——它沒有可以刪的列，登出作廢不了它。
    if (typeof payload.sid !== "string" || !SID_RE.test(payload.sid)) return null;
    return { userId: payload.sub, tv: payload.tv, sid: payload.sid };
  } catch {
    // 過期、篡改、格式錯誤——一律回 null，不 throw
    return null;
  }
}

export interface GateUser {
  id: string;
  email: string;
  /** #122：URL 用的使用者名——/api/auth/me 直接回 request.user，此欄必須在 Gate 層就撈。 */
  handle: string;
  displayName: string;
  isAdmin: boolean;
  /** 首登強制改密碼旗標——`GET /api/auth/me` 直接回傳 `request.user`
   * （見 app.ts 的 `authenticate`），故此欄位需在此就撈出，login 回應才有得帶。 */
  mustChangePassword: boolean;
  /** OIDC-only 帳號為 false（=`password_hash IS NULL`）。 */
  hasPassword: boolean;
  /** 版本歷史：`/api/auth/me` 直接回 `request.user`，此欄必須在 Gate 層就撈。 */
  autoVersions: boolean;
}

export type GateResult = { status: "ok"; user: GateUser } | { status: "revoked" };

export interface GateRow {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  isAdmin: boolean;
  disabledAt: Date | null;
  tokenVersion: number;
  mustChangePassword: boolean;
  hasPassword: boolean;
  autoVersions: boolean;
}

interface CacheEntry {
  row: GateRow | null;
  expiresAt: number;
}

/** #388：`sessions` 列的快照（`UserGate` 的 session 快取存這個）。 */
export interface SessionRow {
  userId: string;
  expiresAt: Date;
}

interface SessionCacheEntry {
  row: SessionRow | null;
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
  /** 測試用：覆寫查 `sessions` 列的方式（同 `fetchRow`）。production code 不應提供此選項。 */
  fetchSession?: (sessionId: string) => Promise<SessionRow | null>;
}

const DEFAULT_MAX_ENTRIES = 1000;
const CACHE_TTL_MS = 60_000;

/**
 * 使用者狀態閘：查 users 表判斷 token 是否仍有效（tokenVersion 相符、未被停用）。
 *
 * 內建 LRU-ish 快取（依插入順序淘汰即可）：上限 maxEntries，TTL 60s。
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
 *
 * #388：`check()` 另外查 `sessions` 列（JWT 的 `sid`）：列要存在、屬於這個 userId、`expires_at` 未過。session 列有自己的
 * 快取（同上限、同 60s TTL、自己的 generation counter `sessionGen`，race 守衛同上）。**登出走 `invalidateSession(sid)`**
 * ——必須在 DELETE 之後呼叫（先清快取再刪列，中間那一發會把「列還在」寫回快取 60 秒）。快取的是列的快照，`expires_at`
 * 每次都跟現在比，快取不會延長 session 的壽命。⚠ 快取只在本行程：多個 server 行程共用一個 DB 時，另一個行程最多 60 秒
 * 後才看到登出（本專案是單一行程部署，見 docs/self-hosting.md 的 Single-instance warning）。
 */
export class UserGate {
  private readonly cache: BoundedMap<CacheEntry>;
  private readonly sessionCache: BoundedMap<SessionCacheEntry>;
  private readonly now: () => number;
  private readonly fetchRow: (userId: string) => Promise<GateRow | null>;
  private readonly fetchSession: (sessionId: string) => Promise<SessionRow | null>;
  private gen = 0;
  private sessionGen = 0;

  constructor(
    private readonly db: Db,
    options: UserGateOptions = {}
  ) {
    this.cache = new BoundedMap<CacheEntry>(options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.sessionCache = new BoundedMap<SessionCacheEntry>(options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
    this.fetchRow = options.fetchRow ?? (userId => this.fetchRowFromDb(userId));
    this.fetchSession = options.fetchSession ?? (sessionId => this.fetchSessionFromDb(sessionId));
  }

  /**
   * cookie session（與由它換得的 collab token）的閘：使用者列（存在、未停用、tokenVersion 相符）＋ #388 的 session 列
   * （存在、屬於這個 userId、未過期）。`sessionId` 必填——型別上就寫不出「只驗 tv 不驗 session 列」的呼叫。
   */
  async check(userId: string, tv: number, sessionId: string): Promise<GateResult> {
    const row = await this.getRow(userId);
    const result = UserGate.evaluate(row, tv);
    if (result.status !== "ok") return result;
    const session = await this.getSession(sessionId);
    if (!session || session.userId !== userId || session.expiresAt.getTime() <= this.now()) return { status: "revoked" };
    return result;
  }

  /**
   * #107：token 路徑（Bearer）的使用者狀態閘。與 `check()` **共用同一條 fetch／
   * 快取／generation-counter 路徑**（`getRow`），差別只在評估時**不比對
   * tokenVersion**——改密碼不作廢 API token（比照 GitHub PAT），撤銷靠設定頁
   * 逐支撤或 admin 停權。
   *
   * 實作上是「把列自己的 tokenVersion 傳給 evaluate」＝那個比較恆真，於是只剩
   * 「列存在」與「未停權」兩個條件。⚠ **不可自己另寫一份 fetch**：`getRow` 的
   * `gen` 守衛擋的是「查詢期間被 invalidate，舊資料仍被寫進快取並帶 60 秒 TTL」
   * 的 race；少了它，停權後 60 秒內 token 仍然可用。
   */
  async checkUser(userId: string): Promise<GateResult> {
    const row = await this.getRow(userId);
    return UserGate.evaluate(row, row?.tokenVersion ?? 0);
  }

  /**
   * 快取／查詢的單一入口（`check` 與 `checkUser` 共用）。快取存的是「查到的 DB row
   * 快照」而非結論，所以兩個呼叫端可以用同一份快取做不同的評估。`gen` 守衛的完整
   * 說明見 class 註解。
   */
  private async getRow(userId: string): Promise<GateRow | null> {
    let entry = this.cache.get(userId);
    if (!entry || entry.expiresAt <= this.now()) {
      const g = this.gen;
      const row = await this.fetchRow(userId);
      entry = { row, expiresAt: this.now() + CACHE_TTL_MS };
      // 只有查詢期間沒被 invalidate() 打斷（gen 未變）才寫入快取，見上方 class 註解。
      if (g === this.gen) this.store(userId, entry);
    }
    return entry.row;
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
    this.gen++;
  }

  /** #388：登出（刪了這一列）之後呼叫，讓這個 sid 下一次 `check` 立刻重查 DB。⚠ 必須在 DELETE 之後（見 class 註解）。 */
  invalidateSession(sessionId: string): void {
    this.sessionCache.delete(sessionId);
    this.sessionGen++;
  }

  /** session 列的快取／查詢入口；`sessionGen` 守衛與 `getRow` 的 `gen` 同理（見 class 註解）。 */
  private async getSession(sessionId: string): Promise<SessionRow | null> {
    let entry = this.sessionCache.get(sessionId);
    if (!entry || entry.expiresAt <= this.now()) {
      const g = this.sessionGen;
      const row = await this.fetchSession(sessionId);
      entry = { row, expiresAt: this.now() + CACHE_TTL_MS };
      if (g === this.sessionGen) this.sessionCache.set(sessionId, entry);
    }
    return entry.row;
  }

  private async fetchSessionFromDb(sessionId: string): Promise<SessionRow | null> {
    const [row] = await this.db
      .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return row ?? null;
  }

  private async fetchRowFromDb(userId: string): Promise<GateRow | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      handle: row.handle,
      displayName: row.displayName,
      isAdmin: row.isAdmin,
      disabledAt: row.disabledAt,
      tokenVersion: row.tokenVersion,
      mustChangePassword: row.mustChangePassword,
      hasPassword: row.passwordHash !== null,
      autoVersions: row.autoVersions,
    };
  }

  private store(userId: string, entry: CacheEntry): void {
    // 插入序淘汰交給共用的 `BoundedMap`（issue #15）：`set()` 會把這個 userId 移到
    // 迭代順序的尾端並在滿了時砍最前面那筆。只有這裡（cache miss / TTL 過期後重新查到
    // 資料）會寫入快取，單純的讀取命中（check() 的 cache hit 分支）不呼叫 store()、不重排
    // 順序——因此被砍的是「最久沒有被重新查詢過」的那筆（刻意簡化，非嚴格
    // access-recency LRU）。
    this.cache.set(userId, entry);
  }

  private static evaluate(row: GateRow | null, tv: number): GateResult {
    if (!row || row.disabledAt !== null || row.tokenVersion !== tv) {
      return { status: "revoked" };
    }
    return {
      status: "ok",
      user: {
        id: row.id,
        email: row.email,
        handle: row.handle,
        displayName: row.displayName,
        isAdmin: row.isAdmin,
        mustChangePassword: row.mustChangePassword,
        hasPassword: row.hasPassword,
        autoVersions: row.autoVersions,
      },
    };
  }
}

/**
 * cookie session 的解析，**不送回應**——回 null＝這個請求沒有有效 session（無 cookie、簽章壞、沒有 `sid` 的舊 JWT、tokenVersion 不符、
 * 停用、帳號不在、session 列已刪或已過期）。
 * 自 `app.ts` 抽出（#187：手動連結的 callback 必須維持「一律 302」，不能掛 `authenticate` preHandler，只借它的核心）。
 */
export async function resolveSessionUser(
  cookies: Record<string, string | undefined>,
  appSecret: string,
  gate: UserGate,
): Promise<ResolvedSession | null> {
  const token = cookies[SESSION_COOKIE];
  const session = token ? await verifySession(appSecret, token) : null;
  if (!session) return null;
  const result = await gate.check(session.userId, session.tv, session.sid);
  if (result.status !== "ok") return null;
  return { user: result.user, tv: session.tv, sid: session.sid };
}

/** `resolveSessionUser` 的結果：`tv`／`sid` 只供 collab token 簽發（`routes/notes.ts`，經 `request.sessionTv`／`request.sessionId`）。 */
export interface ResolvedSession {
  user: GateUser;
  tv: number;
  sid: string;
}
