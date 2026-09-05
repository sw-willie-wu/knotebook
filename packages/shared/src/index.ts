export const YDOC_FRAGMENT = "knotebook";

export const SESSION_COOKIE = "knotebook_session";

/** OIDC authorization request 期間的一次性 state cookie 名稱（Plan 5 §14.3）——存活
 * 短暫（見 server 端 `OIDC_STATE_TTL_SECONDS`），只在 `/api/auth/oidc` 路徑下有效。 */
export const OIDC_STATE_COOKIE = "knotebook_oidc";

export type Role = "owner" | "editor" | "viewer" | "none";

export interface ApiError {
  error: { code: string; message: string };
}

/** `GET /api/auth/me`、login/OIDC 成功回應的使用者形狀（見 apps/server routes/auth.ts）。 */
export interface UserDto {
  id: string;
  email: string;
  /** #122：URL 用的使用者名（/n/<handle>/…）。建帳時派生（OIDC preferred_username →
   * email local-part）或 admin 指定；settings 可改（改名＝舊網址即死、舊名永不回收）。 */
  handle: string;
  displayName: string;
  isAdmin: boolean;
  /** 首登強制改密碼旗標（spec rev 5.7 / §14.2）：env bootstrap 建立的 admin、admin UI
   * 代建的帳號皆為 true；OIDC 自動建帳為 false。web 端的 `ChangePasswordGate` 依此
   * 導向 `/change-password`——見 apps/web/src/auth/guards.tsx。 */
  mustChangePassword: boolean;
  /** OIDC-only 帳號為 false；設定 modal 據此隱藏改密表單——spec §14.4。 */
  hasPassword: boolean;
}

/** 密碼長度下限，鏡射 apps/server/src/auth/constants.ts 的同名常數——這裡是給
 * web 端表單前端先驗用的唯一真相，兩邊刻意保持同一個數字（12）。 */
export const MIN_PASSWORD_LENGTH = 12;

/** `GET /api/auth/config` 的回應形狀（Plan 5 §5，免認證）：web 端登入頁用 `oidc.enabled`
 * 決定是否顯示「用 SSO 登入」按鈕。刻意只曝光布林旗標——不外洩 issuer/clientId 等設定
 * 細節（那些是後端與 IdP 之間的事，client 只需要知道「這個功能有沒有開」）。 */
export interface AuthConfigDto {
  oidc: { enabled: boolean };
}

export interface NoteDto {
  id: string;
  title: string;
  ownerId: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
  /** 網址代稱（#122 spec §3a 起 NOT NULL＋per-user 唯一）：auto（跟標題走）或自訂，恆為字串。 */
  slug: string;
  /** owner 的 username（/n/<ownerHandle>/<slug> 的第一段）；editor PATCH 回應也帶 owner 的、非操作者的。 */
  ownerHandle: string;
  /** slug 形態：false＝auto（title 變更會重算）、true＝顯式自訂（title 變更不動 slug）。 */
  slugIsCustom: boolean;
  /** 單層自訂 redirect 來源（只記自訂變更；無則 null）——by-path miss 後的補查面。 */
  prevSlug: string | null;
}

// 分享名單上的角色只會是 'editor'/'viewer'——note_shares 表的 DB check constraint
// 本就不允許存 'owner'/'none'（owner 不會出現在 note_shares 裡；'none' 純粹是
// resolveRole 用來表示「無權限」的哨兵值，從不落地成一筆分享列）。與 NoteDto 的
// `Role`（涵蓋全部四種狀態）刻意分開成獨立型別，讓「這欄位只可能是這兩種角色」
// 這件事在型別層就看得出來。
export type ShareRole = "editor" | "viewer";

export interface ShareDto {
  userId: string;
  email: string;
  displayName: string;
  role: ShareRole;
}

/** 反向連結清單項目（Plan 3）：連到目前筆記的來源筆記摘要，供 backlinks 面板渲染。 */
export interface BacklinkDto {
  id: string;
  title: string;
  slug: string;
  /** 來源筆記 owner 的 username——BacklinksSection 組 /n/ 連結用（#122）。 */
  ownerHandle: string;
}

/** 圖片上傳單檔大小上限（bytes，Plan 3）：10 MiB，超過回 `file_too_large`（413）。 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 單次 `POST /api/notes/:id/links` 提交的 target 集合上限（去重、過濾 self-link 正規化後計；超過回 400 `invalid_body`）。 */
export const MAX_LINK_TARGETS = 1000;

/** 單篇筆記 backlinks 面板回傳的來源筆記數上限（Plan 3）。 */
export const MAX_BACKLINKS = 200;

// 權威清單：`grep -rn "sendError(" apps/server/src` + auth.ts 手寫 429（`too_many_attempts`）
// 逐一核對後的全集，另加本 plan 新增碼 `too_many_requests`（Task 8 slug limiter）與
// `slug_taken`（Task 8 slug unique violation）——這兩碼尚未落地於 grep 結果，屬預先保留。
// Plan 3：`not_loaded` 已落地（Task 5）——`POST /api/notes/:id/links` 409：該筆記尚未載入
// 進 collab server 記憶體，或提交者無該筆記開啟中的連線，`linkSyncGate` 回 `{ok:false}`，
// 不落地任何寫入。`server_busy` 除 auth/admin-users 的 429（`HashBusyError`，argon2 併發
// 超限）外，Task 5 新增第二個發送點——同一個 `POST /api/notes/:id/links` 的 409：
// `writeNoteLinks` 交易撞上 pg `serialization_failure`/`deadlock_detected`
// （40001/40P01，剔除消失 target 重試一次後仍失敗才會落到這裡）；純 DB 層級的併發衝突，
// 非邏輯錯誤，交給 client 重試（與 `not_loaded` 區分：後者無 note_states 回退路徑，client
// 收斂方式不同，見 Task 7）。`file_too_large`＝`POST /api/notes/:id/uploads` 413 唯一發送點
// （Plan 3 已落地）。spec §14.2：setup token 流程退役，`invalid_setup_token`/
// `already_setup`/`invalid_email`/`invalid_display_name`/`bootstrap_email_mismatch`
// 五碼隨之刪除（唯一消費者已隨 setup token 路由一併移除；`password_too_short` 仍由
// `routes/auth.ts`／`routes/admin-users.ts` 消費，留用）。
export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_body",
  "bad_request",
  "internal",
  "unsupported_media_type",
  "server_busy",
  "too_many_attempts",
  "too_many_requests",
  "password_too_short",
  "invalid_credentials",
  "account_disabled",
  "email_taken",
  "user_not_found",
  "cannot_disable_self",
  "cannot_share_with_self",
  "share_not_found",
  "slug_taken",
  "handle_taken",
  "public_slug_taken",
  "not_loaded",
  "file_too_large",
  "ai_not_configured",
  "provider_unavailable",
  "upstream_error",
  "builtin_action",
  "model_taken",
  // Plan 5（Task 8/9）：OIDC 登入流程。`oidc_unavailable`＝OIDC 未設定/discovery 失敗/
  // 不可用（login route 302、callback route 對稱處理）；`oidc_state_mismatch`＝callback
  // 的 state cookie 缺失/過期/與查詢字串不符（Task 9）；`oidc_exchange_failed`＝與 IdP
  // 的 token/userinfo 交換失敗（Task 9）；`oidc_email_unverified`/`oidc_email_missing`/
  // `oidc_conflict`＝`auth/oidc-decision.ts` 的 reject 分支碼（Task 7 已落地決策函式，
  // 這裡補上型別/i18n 承諾）。
  "oidc_unavailable",
  "oidc_state_mismatch",
  "oidc_exchange_failed",
  "oidc_email_unverified",
  "oidc_email_missing",
  "oidc_conflict",
  // #107 API token／OAuth：`insufficient_scope`＝合法 token 但 scope 不足（403——刻意
  // 與「token 本身無效」的 401 分開，後者才計入無效 Bearer 的節流）；`token_limit`＝
  // 每位使用者的有效 token 軟配額；`token_not_found`＝撤銷不存在或不屬於自己的 token
  // （兩者同形，不當成列舉 oracle）；`oauth_request_invalid`＝授權請求已用／已過期
  // （#132 才會發出，碼在 #130 一併加，避免 i18n 分兩次改）；`not_implemented`＝
  // `/api/mcp` 在 #108 前的暫時形。
  "insufficient_scope",
  "token_limit",
  "token_not_found",
  "oauth_request_invalid",
  "not_implemented",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const AI_SSE_EVENTS = { delta: "delta", done: "done", error: "error" } as const;
export interface AiSseErrorPayload {
  code: string;
  message: string;
}

export interface AiActionDto {
  id: string;
  name: string;
  applyMode: "direct" | "preview";
}

export interface AdminAiProviderDto {
  id: string;
  name: string;
  type: "openai_compatible" | "anthropic";
  baseUrl: string;
  enabled: boolean;
  hasKey: boolean;
  degraded: boolean;
  createdAt: string;
}

export interface AdminAiModelDto {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  purpose: "chat";
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface AdminAiActionDto {
  id: string;
  name: string;
  systemPrompt: string;
  userTemplate: string;
  modelId: string | null;
  applyMode: "direct" | "preview";
  sortOrder: number;
  enabled: boolean;
  builtin: boolean;
}

export const COLLAB_CLOSE_REVOKED = "knotebook:revoked";
export const COLLAB_CLOSE_NOTE_DELETED = "knotebook:note-deleted";

/**
 * 共編握手被拒時，server 寫進 permission-denied 訊息的 reason（client 從 provider 的
 * `authenticationFailed` 事件收到）。
 *
 * ⚠ 這一組常數與上面的 `COLLAB_CLOSE_*` 是**兩條不同的通道**，不可混用：
 * `COLLAB_CLOSE_*` 走應用層 CLOSE 訊息（連線**已經**通過 onAuthenticate 之後才送）；
 * 這裡這組則是 onAuthenticate 當場就拒絕，Hocuspocus 只回一則 permission-denied Auth
 * 訊息、**不關 socket 也不重連**（已對 @hocuspocus/server 4.5.0 `ClientConnection` 核實）。
 * client 必須自己把它翻成狀態機事件，否則畫面會永遠停在「連線中」（issue #6）。
 *
 * ⚠ **這一組分成語意完全不同的兩桶（issue #35），client 的處置不可混用**：
 *
 * A.「這是一則授權裁決」——`note-deleting`（筆記已刪除／刪除中）與 `forbidden`（這個人對
 *    這篇筆記沒有任何角色）。使用者對這篇筆記的關係真的結束了，client 據此收斂終態
 *    （deleted／撤權二擊）並導頁。
 * B.「拒絕的原因不是權限」——`invalid-token`（token 驗不過，或 session 的 tokenVersion 已被
 *    撤銷）與 `server-error`（onAuthenticate 撞到未預期例外）。**client 絕不可據此宣告使用者
 *    失去存取權**：對他說錯話之外，那一則拒絕多半重取一次 token 就會有結論。正確處置是排一次
 *    連線重啟（見 `useCollab` 的 `TOKEN_RESTART_DELAYS_MS`），狀態留在 `connecting`；重取 token
 *    時若 session 真的沒了會拿到 401，屆時走的是登出流程，那才是它正確的結局。
 *
 * 舊版把三種拒絕理由全塞進 `invalid-token` 一個桶子，client 一律翻成撤權——帳號被停用或密碼
 * 在別處改過（兩者都只是 session 失效）會對一個權限完好的使用者說「你已失去存取權」並把他
 * 導走（issue #35）。
 * ⚠ 因此 **client 對「不認得的 reason」（含 Hocuspocus 對未預期例外填的字面值
 * `"permission-denied"`、以及 reason 缺席）一律歸 B 桶**：寧可多重試幾次，不可誤殺。
 *
 * ⚠ **不要為「筆記不存在」另開一個 reason**：那會把「這個 noteId 是否存在」變成一個任何登入
 * 使用者都能問的 oracle，而 REST 端刻意不區分這兩者（`GET /api/notes/:ref` 一律 404、
 * collab-token 一律 200 + role 'none'，見 `routes/notes.ts` 的防列舉說明）。刪除後的重連窗口
 * 改由 server 端的刪除閘門覆蓋（`DELETING_GATE_TTL_MS` 大於 `COLLAB_RESTART_DELAYS_MS` 的最大
 * 值），而閘門**只對「刪除當下本來就看得到這篇筆記的人」說 `note-deleting`**——其他人一律
 * 落在 `forbidden`，與「這篇筆記存在但不是你的」完全一樣，問不出任何東西。
 */
export const COLLAB_REJECT_NOTE_DELETING = "note-deleting";
export const COLLAB_REJECT_INVALID_TOKEN = "invalid-token";
export const COLLAB_REJECT_FORBIDDEN = "forbidden";
export const COLLAB_REJECT_SERVER_ERROR = "server-error";
/**
 * client 在「token 徹底取不到」或「拒連理由不是授權裁決」之後，整條連線重來的退避表（ms，
 * issue #39／#35）與抖動幅度。最後一格重複使用；實際延遲 ＝ 該格 × [0.75, 1.25)。
 *
 * ⚠ **住在 shared 是因為 server 端的刪除閘門 TTL 必須大於這裡的最大值**
 * （`DELETING_GATE_TTL_MS`，見 `apps/server/src/collab/hooks-impl.ts`）：閘門是 server 唯一
 * 能對「本來看得到這篇筆記的人」說出「它被刪掉了」的窗口，關得比 client 的重連還早的話，
 * 那個人就會收到 `forbidden` ＝ 被告知失去存取權（issue #35）。兩個常數因此是一組耦合的
 * 契約，由 `apps/server/test/unit/collab-deleting-gate.test.ts` 釘住——調整這裡的數字時，
 * 那條測試會告訴你 server 端要不要跟著調。
 */
export const COLLAB_RESTART_DELAYS_MS = [5_000, 15_000, 60_000] as const;
export const COLLAB_RESTART_JITTER = 0.25;

/**
 * client 取 collab token 的**有上限**退避重試表（ms）。5xx／429／網路錯誤走這條——
 * 「暫時取不到 token」不是授權失敗，不可據此踢人或登出（spec N7；401 例外，直接登出）。
 * 消費端在 `useCollab.ts`；放在 shared 是因為它是跨端契約的一半：server 端的刪除閘門
 * TTL（`collab-deleting-gate.test.ts`）與撤權重驗 deadline（下方）都以它的總和為前提。
 */
export const COLLAB_TOKEN_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000] as const;

/**
 * 撤權重驗的 deadline：server 送出 `requestToken()` 後等 client 回送新 token 的上限（ms），
 * 逾時即以 `COLLAB_CLOSE_REVOKED` 關閉連線。5s 由 spec §7 逐字釘死（「定向重驗 + 5s
 * deadline」）——要調它得先改 spec。
 *
 * ⚠ **刻意短於 client 的最壞 token 重試**（上方 `COLLAB_TOKEN_RETRY_DELAYS_MS` 總和
 * 7.5s）——這不是疏忽（issue #40：舊註解宣稱餘裕含 client 重試退避，為假）：這條
 * deadline 是撤權的**最後一道 fail-closed 保險**（§10 的「撤銷分享 ≤10 秒」SLA），
 * 放寬到 >7.5s 會吃掉 SLA 的大半餘裕。重驗期間 client 若撞上 429/5xx、還在退避排程
 * 裡，deadline 先到並關線。誤殺的代價：client 進 `reconnecting-once` 重連——後端若
 * 仍在抖動，會再落入 5/15/60s 的重啟排程、badge 幾秒後升離線警示，體感不只「重連一
 * 次」；但**權限判定不受影響**：不會被升級成 kicked（那需要在 `reconnecting-once`
 * 中再吃第二擊），後端恢復即自行回復。正常路徑一次 token 往返 <200ms，5s 的餘裕
 * 留給 DB 抖動——**不含** client 的重試退避。
 *
 * 這層「deadline < 最壞重試」的關係由 `apps/web/src/collab/useCollab.test.tsx` 釘住——
 * 調整任一邊的數字時，那條測試逼你回來重新面對這個取捨。
 */
export const COLLAB_REVERIFY_DEADLINE_MS = 5_000;

export const COLLAB_TOKEN_TTL_SECONDS = 120;
export interface CollabTokenClaims {
  noteId: string;
  userId: string;
  role: Role;
  tv: number;
}

/** email 的單一漏斗（spec §14.3）：所有建帳寫入與所有 email 比對讀取共用；OIDC claims
 * 亦過此。 */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

const SLUG_CHARSET_RE = /^[\p{L}\p{N}-]+$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_SUFFIX_RE = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVED_SLUGS = new Set(["new"]);

/** slug 正規化：NFC 合成 + Unicode-aware 小寫。給 `validateSlug` 與 DB 唯一比對用。 */
export function normalizeSlug(input: string): string {
  return input.normalize("NFC").toLowerCase();
}

/**
 * 驗證已正規化（已過 `normalizeSlug`）的字串是否為合法自訂 slug。spec §11.4 逐字：
 * 1–100 code points；charset 僅 `\p{L}\p{N}-`（刻意不含 `\p{M}` combining marks——
 * 例如 `İ`.toLowerCase() 產生的 U+0307 會被擋）；不可頭尾/連續/純 `-`；保留字
 * `new`；整串 uuid 或以 `-<uuid>` 結尾 → `uuid_like`（避免與**舊版**發出去的
 * `/notes/<vanity>-<id>` 連結混淆——那些連結永久活著，由 `extractRefUuid` 解析）。
 * 檢查順序即為分支優先序：length → charset → dash → reserved → uuid_like。
 */
export function validateSlug(normalized: string): "length" | "charset" | "dash" | "reserved" | "uuid_like" | null {
  const length = Array.from(normalized).length;
  if (length < 1 || length > 100) return "length";
  if (!SLUG_CHARSET_RE.test(normalized)) return "charset";
  if (normalized.startsWith("-") || normalized.endsWith("-") || normalized.includes("--")) return "dash";
  if (RESERVED_SLUGS.has(normalized)) return "reserved";
  if (UUID_RE.test(normalized) || UUID_SUFFIX_RE.test(normalized)) return "uuid_like";
  return null;
}

const HANDLE_CHARSET_RE = /^[a-z0-9-]+$/;

/**
 * handle（使用者名，#122）的正規化：**僅 ASCII A-Z→a-z 的碼位映射**。
 *
 * 與 `normalizeSlug` 刻意不同：handle 是身分識別、進 URL 的第二段，ASCII-only
 * （跨鍵盤可輸入、避免 IDN 同形混淆）優先於在地化——所以**不做** Unicode
 * lowercase（`İ`.toLowerCase() 會產生 combining mark U+0307）、不 transliterate；
 * 非 ASCII 字元原樣保留，交給 {@link validateHandle} 以 `charset` 拒收。
 */
export function normalizeHandle(input: string): string {
  // 碼位加 32 而非 toLowerCase()：讓「絕不觸 Unicode lowercase」在原始碼層級看得見
  return input.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

/**
 * 驗證已正規化（已過 `normalizeHandle`）的字串是否為合法 handle（spec #122 §2b）：
 * 1–32、charset 僅 `a-z0-9-`、dash 不可頭尾/連續、不得 uuid 形。
 *
 * **刻意沒有保留字單**（與 `validateSlug` 的 `reserved` 分支不同）：handle 恆出現在
 * `/n/`、`/p/` 的第二段，與任何頂層路由零衝突面——`api`、`new`、`settings` 都是
 * 合法 handle（apps/server/test/unit/shared-handle.test.ts 有反向釘，別「順手」把
 * slug 的保留字抄過來）。
 * uuid_like 分支在 32 字元上限下對完整 uuid（36 字元）實為死碼（length 先擋），
 * 留著是防禦性宣告：上限若放寬，這條規則仍在。
 */
export function validateHandle(normalized: string): "length" | "charset" | "dash" | "uuid_like" | null {
  // 長度以 code point 計（比照 validateSlug 慣例）：非 ASCII 長輸入才會正確落到
  // charset 訊息（「只能用 a-z0-9-」）而不是誤導的「太長」。
  const length = Array.from(normalized).length;
  if (length < 1 || length > 32) return "length";
  if (!HANDLE_CHARSET_RE.test(normalized)) return "charset";
  if (normalized.startsWith("-") || normalized.endsWith("-") || normalized.includes("--")) return "dash";
  if (UUID_RE.test(normalized)) return "uuid_like";
  return null;
}

/**
 * 從標題產生 slug 片段。唯一消費端（#122 起）：`autoSlugFromTitle` 的原料（後續進
 * normalizeSlug→validateSlug 漏斗）——`canonicalNotePath` 已改 `/n/<handle>/<slug>`
 * 單一形，不再組 vanity 片段。刻意不做大小寫正規化：需要唯一比對的路徑由消費端
 * 自行 `normalizeSlug`（歷史上 vanity 路徑要保留原大小寫，這個性質順帶留存）。
 * pipeline：NFC → 保留 `\p{L}\p{N}`，其餘一段段轉單一 `-` → 去頭尾 `-` →
 * 以 code point（`Array.from`，避免切斷 surrogate pair）截斷至 60 → 截斷後再去尾
 * `-` 一次（截斷點可能恰好落在 `-` 後）。全空 → `""`。
 */
export function titleSlug(title: string): string {
  let s = title.normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-");
  s = s.replace(/^-+|-+$/g, "");
  const chars = Array.from(s);
  if (chars.length > 60) {
    s = chars.slice(0, 60).join("");
  }
  s = s.replace(/-+$/, "");
  return s;
}

/**
 * 從標題產生 auto slug（#122 spec §3a：`slug_is_custom=false` 的筆記，slug 跟
 * 標題走）。漏斗：`titleSlug` → `normalizeSlug` → `validateSlug`；合法候選
 * **原封不動**放行（重音、CJK 保留）。首驗不過時才進 fallback：NFD 剝 `\p{M}`
 * 再 NFC 回來重驗——這會把**整串**的變音符一併剝掉（`İstanbul Café` →
 * `istanbul-cafe`），不只肇事字元；仍不過（uuid 形、保留字、空、全符號…）→
 * 固定退 `"untitled"`。產物恆為 `normalizeSlug` 的固定點（進 DB 唯一比對的
 * 前提）。唯一性去重是呼叫端的事——本函式是純函式。
 */
export function autoSlugFromTitle(title: string): string {
  const candidate = normalizeSlug(titleSlug(title));
  if (validateSlug(candidate) === null) return candidate;
  const stripped = candidate.normalize("NFD").replace(/\p{M}+/gu, "").normalize("NFC");
  if (validateSlug(stripped) === null) return stripped;
  return "untitled";
}

/**
 * 從 ref 字串（可能是純 uuid，或**舊版連結**的 `<vanity>-<uuid>` 形式）擷取尾碼
 * uuid，供 `GET /api/notes/:ref` 在 legacy slug 比對失敗後的第二段查找路徑——
 * 0007 之前發出去的連結靠這條永久可解。找不到回傳 null。
 */
export function extractRefUuid(ref: string): string | null {
  if (UUID_RE.test(ref)) return ref.toLowerCase();
  const match = UUID_SUFFIX_RE.exec(ref);
  if (match) return match[0].slice(1).toLowerCase();
  return null;
}

/**
 * 組出筆記的 canonical 路徑（#122 spec §3b）：`/n/<ownerHandle>/<slug>`——單一形，
 * 不再有三態（slug 自 0007 起 NOT NULL、每篇筆記必有 ownerHandle）。供 NoteList
 * href、NotePage 收斂 effect 的 `history.replaceState`、分享 dialog 複製連結共用。
 * 兩段都不做 URL 編碼：擋掉 `/ % ? #` 等分隔字元的是**字元集驗證**——handle 走
 * `validateHandle`（`a-z0-9-`）、slug 走 `validateSlug`（`\p{L}\p{N}-`），兩者都
 * 不可能切出額外 path segment 或 query/hash；非 ASCII 字元由瀏覽器/
 * `encodeURIComponent` 在傳輸層處理（與舊 `/notes/<slug>` 形同慣例）。
 * 舊形 `/notes/…`（含 `<vanity>-<uuid>`）永久可解析（server 走 legacy＋uuid 尾碼），
 * 但**不再由本函式產生**。
 */
export function canonicalNotePath(note: { ownerHandle: string; slug: string }): string {
  return `/n/${note.ownerHandle}/${note.slug}`;
}

/**
 * 組出公開別名**頁面**路徑（#122 PR3 spec §4）：`/p/<handle>/<slug>`——`/p/` 兩段
 * 形頁面網址的組字點（plan gate m-2 收窄版，比照 `canonicalNotePath`）：ShareDialog
 * 別名列的前綴/複製走這裡（**Task 5 起接線**——刻意提前落地基建，非 drift），
 * 禁自拼字串（組字漂移＝複製鈕給出打不開的網址）。不做 URL 編碼
 * 的理由同 `canonicalNotePath`（輸入是**已驗證**的 handle/slug，charset 擋掉分隔
 * 字元）。⚠ 職責邊界（T4 讀碼審裁決）：公開 **API** 網址（fetch 用的
 * `/api/public/notes/…`）的組字點是 web 的 `lib/public-note-ref.ts`——那邊吃的是
 * URL 原始參數、做防禦性 encodeURIComponent，**編碼政策不同、刻意不共用**。
 * ⚠ e2e **刻意除外**：e2e package 無 @knotebook/shared 依賴（rsync 不帶 dist），
 * 別名網址一律從 ShareDialog UI 讀出。token 形 `/p/<token>` 不經此函式（單段、
 * 無組字問題）。
 */
export function publicAliasPath(ref: { handle: string; slug: string }): string {
  return `/p/${ref.handle}/${ref.slug}`;
}

/**
 * #72：空 Y.Doc 的合法 update 編碼（`Y.encodeStateAsUpdate(new Y.Doc())` ＝ `[0,0]`
 * 的 base64）。公開端點對「筆記從沒開過編輯器（查無 note_states）」回這個值——
 * **不能回空字串／零長度**：`Y.applyUpdate(doc, new Uint8Array())` 會 throw（實測），
 * 公開頁直接爆。server 回它、web 端測試斷同一份；「這個字面真的等於空文件編碼」
 * 由 server 的 unit 釘住（防兩端 import 同一個錯值的套套邏輯）。
 */
export const EMPTY_YDOC_UPDATE_B64 = "AAA=";

/**
 * #107：API token 的 scope。**是集合不是單值**——OAuth 的 scope 參數是空白分隔的
 * 集合，且「write 涵蓋 read」，所以落庫形只有兩種：只讀，或讀寫（write 一定把 read
 * 顯式寫進字串，讓 DB CHECK、token 回應 body、設定頁三處看到同一個值）。
 */
export type TokenScope = "notes:read" | "notes:read notes:write";

/** 路由宣告「這個操作至少需要什麼」時用的單值，與落庫形（集合）刻意不同型別。 */
export type RequiredScope = "notes:read" | "notes:write";

/**
 * 把外部送來的 scope 參數正規化成落庫形。
 *
 * **切詞後逐一比對，不是子字串比對**：`xnotes:write`、`notes:write-all` 都只是
 * 不認得的值，不得因為「含有 notes:write」而授予寫入權（那是 scope 放大）。
 *
 * **忽略不認得的值**（RFC 6749 §3.3 允許 AS 部分忽略；MCP client 可能自行加
 * `offline_access`），因此**永不回 null**——呼叫端沒有 `invalid_scope` 分支。
 * 空／undefined → `notes:read`（最小權限）：MCP client 的 scope 優先序是「401
 * challenge 的 scope → PRM `scopes_supported` → 兩者皆無才省略」，我們兩者都給，
 * 正常不會送空；真的送空就給最小的。
 *
 * 分隔字元只認**半形空白**（RFC 6749 §3.3 的 scope 是 SP-delimited）。tab／全形空白
 * 之類的分隔不會被切開，整串因此變成一個不認得的值 → 落到 `notes:read`，方向是
 * fail-closed。
 *
 * 回應裡的 `scope` 一律是這個函式的輸出（我們實際授予的集合），被忽略的值不回聲；
 * client 依 RFC 6749 §5.1 應以回應為準。
 */
export function normalizeScope(input: string | null | undefined): TokenScope {
  // 只需要知道有沒有要求 write——read 在兩種落庫形裡都有，不必另外判斷。
  return (input ?? "").split(" ").includes("notes:write") ? "notes:read notes:write" : "notes:read";
}

/**
 * 落庫的 scope 集合是否涵蓋這個操作所需的權限。
 *
 * 用**成員判定**，不是「`required === "notes:read"` 恆真 ‖ `stored` 整串等於讀寫形」
 * 那種寫死的階層判斷。兩者在**合法**的兩種落庫形上答案完全相同——`scope` 欄有
 * `CHECK (scope in ('notes:read','notes:read notes:write'))`，連 psql 直插都繞不過去，
 * 所以這不是在修一個現在會發生的 bug。差別在**不依賴那條 CHECK**：這支函式是授權
 * 判定的最後一關，而它拿到的 `stored` 來自 `text` 欄位、型別是靠 `as TokenScope`
 * 斷言來的。萬一哪天 CHECK 被放寬、或多一種落庫形（例如未來加第三個 scope），
 * 字面相等會把讀寫 token 靜默降成唯讀——失敗形態是「功能莫名其妙壞掉」，很難查；
 * 成員判定則自然涵蓋。
 *
 * 守衛見 `apps/server/test/unit/shared-scope.test.ts`：帶 cast 的漂移案會讓字面
 * 相等版本紅掉。
 */
export function hasScope(stored: TokenScope, required: RequiredScope): boolean {
  return stored.split(" ").includes(required);
}

/** `GET /api/auth/tokens` 的列元素（#107）。`kind='oauth'` 的列在 #132 才會出現。 */
export interface ApiTokenDto {
  id: string;
  kind: "pat" | "oauth";
  /** PAT 是使用者自取；oauth 是 client 自述的名稱快照（**未經驗證**，UI 要標示）。 */
  name: string;
  scope: TokenScope;
  createdAt: string;
  lastUsedAt: string | null;
  /** null＝不到期（PAT 的預設）。 */
  expiresAt: string | null;
  clientId: string | null;
}

/** `POST /api/auth/tokens` 的 201 回應：**`token` 明文只在這裡出現一次**。 */
export interface CreatedApiTokenDto extends ApiTokenDto {
  token: string;
}

/** #132：同意頁要顯示的四要素（`GET /api/oauth/request`）。 */
export interface OauthRequestDto {
  /** client 的自述名稱，**未經驗證**——渲染時要 bidi 隔離。 */
  clientName: string;
  /** `new URL(redirect_uri).host`，**刻意含 port**：讓使用者看到實際會跳去的位址。 */
  redirectHost: string;
  scope: TokenScope;
  /** `scope` 拆成單值陣列，供同意頁逐條列出人話說明。 */
  scopes: string[];
  /** 呼叫者本人已有同 client 的 oauth grant（I7 會取代它）。 */
  replacesExisting: boolean;
}

/**
 * 「這條路徑不是 SPA 頁」的唯一判準——兩個用途共用：
 *
 * 1. server 的 SPA fallback（`apps/server/src/http/spa.ts`）：命中者不回 index.html，
 *    落回 JSON 404。
 * 2. `safeNextPath`（#131）：登入後的導回目標若命中，一律當作不安全的 next——否則
 *    OIDC callback 會把使用者導到一份裸 JSON（或 #132 的 RFC 形錯誤），而不是頁面。
 *
 * 比對是 **segment 邊界**，不是字串 `startsWith`：`/x` 本身或 `/x/...` 才算命中，
 * 所以 `/collaborators` 不受 `/collab` 牽連、`/apifoo` 不受 `/api` 牽連。
 *
 * 前四條沿用 spec §11.5 的契約（守衛在 `apps/server/test/spa.test.ts`）；常數本身
 * export 出來只有一個用途：讓測試釘住這是一個**封閉集合**，逼下一個想加前綴的人連同
 * SPA fallback 的行為一起想過。**實作端一律用 `isExcludedPath`**，不要自己 import
 * 陣列再寫一次比對——那正是本次搬家要消滅的東西。
 *
 * `/oauth` 與 `/.well-known` 是 #131 加入的：#132 會在這兩個前綴下掛 OAuth 授權
 * 伺服器的端點，它們的 404 是 RFC 形 JSON 而不是 SPA 頁。**在 #132 落地之前**這兩條
 * 路由還不存在，加入的即時效果只是「`GET /oauth/x` 帶 `Accept: text/html` 從回
 * index.html 變成回 JSON 404」——刻意如此。
 *
 * ⚠ #132 的**同意頁**是 SPA 路徑 `/authorize`（server 的 `GET /oauth/authorize` 驗完
 * 參數後 302 到它），**不在 `/oauth` 之下**——所以把 `/oauth` 排除掉不會把同意頁自己
 * 排除掉。下一棒不要因為「同意頁需要 SPA fallback」而刪掉這個前綴。
 *
 * ⚠ **不做任何正規化**（守衛：`shared-next-path.test.ts` 的「不做正規化」一案）。
 * 呼叫端各自決定餵什麼進來：`spa.ts` 餵未解碼的 `request.url.split("?")[0]`（Fastify
 * 的路由比對也不解碼），`safeNextPath` 餵 `new URL(...).pathname`（dot-segment 已正
 * 規化、百分比編碼保留）。兩者對 `/x/../api/notes` 的判定因此不同，這是刻意的：各自
 * 比對的是各自那一側真正會被路由的字串。`apps/server/src/routes/public.ts` 的 token 遮罩理由鏈也依賴這條——它算準了
 * `//api/public/…` 這種變體**比不中**任何前綴而落進 SPA fallback。
 */
export const EXCLUDED_PREFIXES = ["/api", "/collab", "/healthz", "/assets", "/oauth", "/.well-known"] as const;

/** `pathname` 是否命中 {@link EXCLUDED_PREFIXES}——segment 邊界比對，理由與清單見該常數。 */
export function isExcludedPath(pathname: string): boolean {
  return EXCLUDED_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * `next` 的長度上限。2048 是一個任意但明顯低於各層實務上限的數字（nginx 預設 header
 * buffer 8 KB、舊 IE 的網址列 2083），用途是讓「有人把整份文件塞進 query」有個明確的
 * 失敗點，而不是慢慢地把各層撐爆。
 *
 * 這個數字同時是 SSO 那條路的 cookie 預算保證：`next` 會被封進 OIDC state cookie，而
 * 2048 字元的 next 封章（JSON → AES-GCM → base64url）後 `name=value` 是 **3049 bytes**、
 * 含屬性的 `Set-Cookie` 是 3115，都在 4 KB 之下（實測；臨界值是 2834 字元）。**所以 server 端不需要、也刻意沒有
 * 第二道更緊的上限**——理由與裁決見 `apps/server/src/auth/oidc-state.ts` 的 `next` 欄位
 * JSDoc。
 */
export const MAX_NEXT_PATH_LENGTH = 2048;

/** `safeNextPath` 解析用的虛構 base——只用來判定「相對解析後有沒有換 origin」，
 * 這個網域不會被連線（`.invalid` 是 RFC 2606 保留的 TLD）。 */
const NEXT_PATH_BASE = "http://knotebook.invalid";

/** 可見 ASCII（U+0021–U+007E）。為何收得這麼緊，見 `safeNextPath` 的第 4 條。 */
const NEXT_PATH_CHARSET_RE = /^[\u0021-\u007e]+$/;

/**
 * 「登入完可以把人送去哪」的唯一判準（#131）——web 的 `LoginPage`／`useSessionGate`
 * 與 server 的 OIDC login／callback 共用這一支。
 *
 * **回傳輸入的原字串或 `null`，永遠不回傳正規化後的形。** 這是本函式最重要的契約：
 * `/..//evil` 通過所有檢查（相對於本站解析仍指向本站），但
 * `new URL("/..//evil", base).pathname` 是 `//evil`——把那個正規化形送進 `Location`
 * 或 `navigate()`，瀏覽器會當它是 protocol-relative URL，人就到了 `http://evil`。
 * 回原字串則由瀏覽器自己相對於本站解析，無害。
 *
 * 失敗一律回 `null`、**刻意不回原因碼**：所有呼叫端的處置都一樣（靜默 fallback 到
 * `/`），沒有分支需求，也不該把「你給的 next 哪裡不合法」講給使用者聽。
 *
 * 檢查順序（任何一條不過就是 `null`；便宜的先跑）：
 * 1. 必須是字串——**不是型別系統的贅語**：query string 解出來可能是 `null` 或**陣列**
 *    （Fastify 對 `?next=/&next=x` 給的是 `["/", "x"]`），而陣列的 `[0]` 可能剛好是
 *    `"/"`，靠下面的字元檢查是攔不住的。
 * 2. 長度 <= `MAX_NEXT_PATH_LENGTH`。用 `input.length`（UTF-16 碼元）而**不是**同檔
 *    `validateSlug`／`validateHandle` 那種 code point 計數：這裡量的是「當 `Location`
 *    用時的長度」，而且過了第 4 條之後全是 ASCII，兩種算法等值。
 * 3. 首字元 `/`，第二字元不是 `/` 也不是 `\`——擋掉 `//evil` 與 `/\evil` 這兩種會被
 *    URL 解析器當成 authority 的形（`\` 在 special scheme 下等同 `/`）。
 *    ⚠ 本條的**次字元**兩個比對與第 5 條的 origin 檢查**互為冗餘**：刪掉任一邊，全表
 *    仍綠（已窮舉 + fuzz 驗證）。保留兩邊是讓字元層與解析層各有一道，不把「同源」整個
 *    押在單一機制上。
 * 4. **只允許可見 ASCII（U+0021–U+007E）**——必須在 URL 解析之前擋：WHATWG 的解析器
 *    會把 CR／LF／TAB 靜默移除，先解析再看就永遠看不到它們，而
 *    `Location: /x\r\nSet-Cookie: …` 是標頭注入。
 *
 *    **這條刻意比 spec §9.1 的字面（只點名 CR／LF／TAB／NUL）嚴很多**，理由是
 *    **呼叫端契約**：OIDC callback 的成功導向刻意**不**做編碼（`reply.redirect(next)`，#131 Task 6 起，
 *    見 `routes/oidc.ts`），因為在導向端補編碼行不通——`encodeURI` 會把既有的 `%20`
 *    二次編碼成 `%2520`，`encodeURIComponent` 會把 `/`、`?`、`#` 一起吃掉。所以
 *    **「送進來的字串必須可以逐字當 `Location` 用」是本函式的責任**。Node 的標頭字元
 *    白名單是 `[\t\x20-\x7e\x80-\xff]`：裸的 C0（TAB 除外，那條由上一段的理由
 *    擋）與 DEL 會被 `validateHeaderValue` 丟 `ERR_INVALID_CHAR`，**U+0100 起（超過
 *    latin-1）的字元也會**——`/n/alice/筆記` 這種未編碼的 CJK 路徑就是（實測：U+00FF
 *    仍放行，U+0100 起才炸）。
 *    而該例外**接不到** `routes/oidc.ts` 最外層的 catch：`app.ts` 掛的是 async
 *    `onSend`，`reply.redirect()` 只是把 header 塞進 reply，真正的 `writeHead` 發生在
 *    handler 回傳之後 → 使用者拿到 JSON 500，而 `setSessionCookie` 已經跑過。等於打破
 *    `routes/oidc.ts` 檔頭寫的「這條路由一切失敗都是 302，不是 JSON 500」。
 *
 *    對呼叫端的要求（因此）是：**送已百分比編碼的路徑**。web 端天然滿足——瀏覽器的
 *    `location.pathname` 本身就是百分比編碼形，所以 `/n/alice/%E7%AD%86%E8%A8%98`
 *    通過、`/n/alice/筆記` 不通過，真實路徑一個都不會被誤殺。
 * 5. 相對於 `NEXT_PATH_BASE` 解析後 origin 必須沒變。**這條是刻意的冗餘防線**（見第 3
 *    條）：**沒有任何輸入能只被它擋下**——突變測試會顯示這行可以刪掉而測試全綠，這是
 *    已知且刻意的。**同段的 `try/catch` 同理**：相對輸入配合法 base，`new URL` 不會
 *    throw，catch 分支同樣沒有輸入到得了。
 * 6. 解析後的 pathname 不得命中 `isExcludedPath`——`/api/…`、`/oauth/…` 這些不是 SPA
 *    頁，導過去只會看到一份裸 JSON。用**解析後**的 pathname 比對，`/x/../api/notes`
 *    與 `/x/%2e%2e/api/notes` 才擋得掉（`isExcludedPath` 自己不做正規化，見該函式）。
 * 7. 收斂尾斜線與大小寫之後不是 `/login`——`/login?next=%2Flogin` 這種手工連結會讓人
 *    登入完又回到登入表單（此時已登入）。不是安全問題，是死路；spec 沒提，這條是 #131
 *    加的。收斂是必要的：react-router 的路徑比對忽略尾斜線、預設大小寫不敏感，所以
 *    `/login/` 與 `/LOGIN` 一樣會渲染登入頁。
 *    判準是「**這個頁的存在前提是尚未登入**」——只有這種頁才該排除。`/change-password`
 *    不算：它對已登入者是一個功能正常的頁。
 */
export function safeNextPath(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  if (input.length > MAX_NEXT_PATH_LENGTH) return null;
  if (input[0] !== "/") return null;
  if (input[1] === "/" || input[1] === "\\") return null;
  // 不需要 eslint-disable：這個 pattern 的**字面裡沒有任何控制字元**（是碼位逸出），
  // `no-control-regex` 本來就不會命中它。
  if (!NEXT_PATH_CHARSET_RE.test(input)) return null;

  let url: URL;
  try {
    url = new URL(input, NEXT_PATH_BASE);
  } catch {
    return null;
  }
  if (url.origin !== NEXT_PATH_BASE) return null;
  if (isExcludedPath(url.pathname)) return null;
  if (url.pathname.replace(/\/+$/, "").toLowerCase() === "/login") return null;

  return input;
}
