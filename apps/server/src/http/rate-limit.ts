/**
 * 固定視窗（fixed window）節流器，供 per-user API 節流用（collab-token、slug PATCH，
 * spec §5/§11.4）。與 `auth/rate-limit.ts` 的 `LoginThrottle`（帳號+IP 雙軌、指數退避）
 * 是兩套不同語意，不共用實作：這裡只要「每個 key 在固定長度的視窗內最多 N 次」。
 *
 * **生產預設值唯一真相來源**：`buildApp`（未收到 `AppDeps.limiters` 時的內建預設）與
 * `test/helpers.ts`（`buildTestApp`/`buildCollabTestApp` 注入的每次全新實例）都從這裡
 * 匯出的 `COLLAB_TOKEN_LIMIT`/`SLUG_PATCH_LIMIT` 取值，不各自重複寫一份數字字面量。
 */
import { BoundedMap, DEFAULT_MAX_KEYS } from "../lib/bounded-map.js";

export const COLLAB_TOKEN_LIMIT = { limit: 60, windowMs: 60_000 } as const;
export const SLUG_PATCH_LIMIT = { limit: 10, windowMs: 600_000 } as const;
/** Plan 3 Task 10b：`POST /api/notes/:id/uploads` 節流（key=userId，同 collabToken/slugPatch 慣例）。 */
export const UPLOAD_LIMIT = { limit: 120, windowMs: 600_000 } as const;
/** Plan 4 Task 5：`POST /api/ai` 節流（key=userId，同 collabToken/slugPatch/upload 慣例）。 */
export const AI_LIMIT = { limit: 30, windowMs: 60_000 } as const;
/**
 * Plan 5 Task 8：OIDC 端點的節流額度（key=request.ip——這兩條路由發生在登入之前，無
 * userId 可用；比照 AI_LIMIT 的數值與視窗長度）。
 *
 * ⚠ **login 與 callback 各自一個 `FixedWindowLimiter` 實例，不共用**（issue #16）：一次
 * 完整的 SSO 登入必定先 login 再 callback，兩者共用一個 bucket 的話等於每次登入吃掉
 * 兩份額度，實際可用次數只有標稱的一半（共用出口 IP 的辦公室網路更早撞到）。
 * 兩者用同一組數值，但計數彼此獨立。
 */
export const OIDC_LIMIT = { limit: 30, windowMs: 60_000 } as const;
/**
 * #72：`PUT/DELETE /api/notes/:id/public-link` 節流（key=userId）。**GET 不吃這桶**
 * ——分享面板開啟即 GET，10 分鐘開 11 次面板是正常操作；掛上去就是 OIDC issue #16
 * 那族「共桶讓額度砍半」的變形。⚠ #122 PR3 的 `PUT/DELETE …/public-link/slug`
 * 兩支**不在此桶**——別名是另一種 slug 寫入，併 `slugPatch` 桶（先授權後扣，與
 * 這桶的「先扣後授權」相反；兩紀律並存的理由見 routes/notes.ts 五支總註解）。
 */
export const PUBLIC_LINK_LIMIT = { limit: 10, windowMs: 600_000 } as const;
/**
 * #72／#122 PR3 公開端點的雙桶（皆無登入態；token 形與別名形 `/:handle/:slug`
 * **共用同兩顆桶**）。四步序寫死在 routes/public.ts 的 `resolvePublicNote`：
 * **格式 guard → 不計數的 isBlocked(ip) 預檢 → DB 查詢 → miss 才 consume(ip)／
 * hit 才 consume（token 形 `${ip}:${token}`、別名形 `${ip}:path:${noteId}`）**
 * ——hit/miss 要查完 DB 才知道，pre-DB 若直接 consume(ip) 正常讀者也會啃 miss 額度。
 *
 * - miss 桶（key=ip，**兩形共用**）：管「解不到 noteId」的洪水與其 DB 查詢。**key
 *   不得含請求輸入**——含了就是攻擊者控制的 key space（每個亂輸入＝新 bucket 滿血
 *   額度，節流形同不存在，還會把 BoundedMap 掃空擠掉合法讀者）。120 而非 30：共用
 *   出口 IP／反代未設 TRUST_PROXY 時這把 key 會塌縮，額度要容得下多人（塌縮的退化
 *   形記 docs/known-limitations.md）。
 * - hit 桶（**只記命中**）：內容/圖片各一份。key 兩形不可能相撞（token 是 base64url
 *   無 `:`，`:path:` 中綴只出現在別名形），故同一篇筆記兩形額度各自計（乘二）＋
 *   同一 BoundedMap 的 key 基數變大——皆明示接受，記 docs/known-limitations.md。
 *   跨筆記 upload 的 404 是「解得到 noteId」的正常讀者行為，落 hit 桶不啃 miss 額度。
 */
export const PUBLIC_MISS_LIMIT = { limit: 120, windowMs: 60_000 } as const;
export const PUBLIC_NOTE_LIMIT = { limit: 60, windowMs: 60_000 } as const;
export const PUBLIC_UPLOAD_LIMIT = { limit: 300, windowMs: 60_000 } as const;

export interface FixedWindowLimiterOptions {
  limit: number;
  windowMs: number;
  /** 視窗登記表的 key 上限，插入序淘汰最舊。預設 `DEFAULT_MAX_KEYS`。 */
  maxKeys?: number;
}

interface Window {
  windowStart: number;
  count: number;
}

/**
 * `consume(key)`：每次呼叫「必計數」——即使已超限，這次呼叫仍會讓計數 +1（不是只在
 * 未超限時才累加），回傳值只反映「這次呼叫本身有沒有落在限額內」。
 *
 * 視窗滾動：每個 key 各自獨立的固定視窗（非 sliding window）——`now - windowStart >=
 * windowMs` 即視為進入新視窗，計數歸零重算，不做「前一視窗按比例扣打」那種平滑處理。
 *
 * maxKeys 淘汰：交給共用的 `BoundedMap`（插入序淘汰）。只有「這個 key 開新視窗」時
 * 才會 `set()` 而移到尾端，純粹計數不觸發重排；超過上限時砍最久沒開過新視窗的
 * 那個 key。`auth/rate-limit.ts` 的 `LoginThrottle` 與 `auth/session.ts` 的 `UserGate`
 * 用的是同一個型別（issue #15）。
 */
export class FixedWindowLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly windows: BoundedMap<Window>;

  constructor(opts: FixedWindowLimiterOptions) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.windows = new BoundedMap<Window>(opts.maxKeys ?? DEFAULT_MAX_KEYS);
  }

  consume(key: string): boolean {
    const now = Date.now();
    let window = this.windows.get(key);
    if (!window || now - window.windowStart >= this.windowMs) {
      // 開新視窗（cache miss 或前一視窗已過期）：`BoundedMap.set` 負責把這個 key
      // 移到尾端並在必要時砍掉最舊的一筆。
      window = { windowStart: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    return window.count <= this.limit;
  }

  /**
   * #72：**不計數**的預檢——只回報「此刻 consume 會不會被拒」，不動計數也不開新
   * 視窗（過期視窗視同未滿，交給之後真正的 consume 開新窗）。公開端點的三步順序
   * 用它在 DB 查詢前擋已超限的 IP，而不提前扣額度（見 PUBLIC_MISS_LIMIT 註解）。
   */
  isBlocked(key: string): boolean {
    const window = this.windows.get(key);
    if (!window || Date.now() - window.windowStart >= this.windowMs) return false;
    return window.count >= this.limit;
  }
}

/**
 * #107：Bearer token 路徑的節流（key=`token:${userId}`）。
 *
 * **只對 token 路徑**——session 路徑維持現狀（無限流），所以既有 web／e2e 行為零
 * 變動。要防的對象是失控的外部程式，不是使用者自己的瀏覽器；「MCP client 打滿不
 * 會鎖住使用者介面」是刻意設計。
 *
 * 桶由路由宣告的 `required` scope 決定：read 路由走 `tokenRead`、write 路由走
 * `tokenWrite`。扣點在 scope 檢查**通過之後**——403 `insufficient_scope` 不啃桶
 * （與 BEARER_MISS 同紀律）。
 */
export const TOKEN_READ_LIMIT = { limit: 300, windowMs: 60_000 } as const;
export const TOKEN_WRITE_LIMIT = { limit: 60, windowMs: 600_000 } as const;

/**
 * #107：無效 Bearer 的節流（key=`request.ip`）。
 *
 * **consume 的觸發集合**＝scheme 不是 Bearer、前綴不是 `knb_`（含把 refresh token
 * 當 Bearer 送）、查無、過期、`checkUser` 失敗、`mustChangePassword`。
 * **403 `insufficient_scope` 不 consume**——那是合法 token，反覆重試不得連累同 IP。
 * `checkUser`／`mustChangePassword` 失敗**刻意 consume**：那是「這個帳號目前不該被
 * 任何 token 代表」，client 的重試對系統而言與無效 token 無異。
 *
 * **成功路徑不做 `isBlocked` 預檢**：有效 token 永不被同 IP 的壞 client 連累（反代
 * 共用出口 IP 時尤其重要）。**刻意接受的代價**：超限後每一發無效 Bearer 仍會做一次
 * `access_token_hash` 的 UNIQUE 索引查找才知道失敗——與公開端點「限流擋在 DB 之前」
 * 的紀律相反，理由是單筆索引查找成本遠低於那邊的多表存取，而「有效 token 不被連累」
 * 的價值更高。
 *
 * ⚠ `TRUST_PROXY` 未設時反代後全體共用同一顆桶（比照 #72 公開端點的同族退化形）。
 */
export const BEARER_MISS_LIMIT = { limit: 30, windowMs: 60_000 } as const;

/** #107：`POST /api/auth/tokens`（key=userId）。 */
export const PAT_CREATE_LIMIT = { limit: 10, windowMs: 3_600_000 } as const;

/**
 * #132：DCR（key=ip）。無認證端點，per-IP 擋灌表；殭屍 client 由 I5 ② 回收。
 * 30/h 而非更嚴：`TRUST_PROXY` 未設時反代後全體共用同一顆桶。
 */
export const DCR_LIMIT = { limit: 30, windowMs: 3_600_000 } as const;

/**
 * #132：`GET /oauth/authorize`（key=ip）。**每一發通過 T1 的請求都計數**——與
 * `PUBLIC_MISS_LIMIT` 的「預檢不計數、miss 才 consume」刻意相反：authorize 沒有
 * 「查完 DB 才知 hit/miss」的性質，每發必查 DB，且合法流量是人為導航，30/min 綽綽有餘。
 */
export const AUTHORIZE_LIMIT = { limit: 30, windowMs: 60_000 } as const;

/** #132：`POST /oauth/token`（key=ip）。 */
export const TOKEN_ENDPOINT_LIMIT = { limit: 60, windowMs: 60_000 } as const;
