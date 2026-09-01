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
  /** 自訂網址代稱（spec §11.4）；未設定為 `null`（Task 8：收緊為必填，server 的 toNoteDto 全點回填）。 */
  slug: string | null;
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
  slug: string | null;
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
 * `new`；整串 uuid 或以 `-<uuid>` 結尾 → `uuid_like`（避免與 `canonicalNotePath`
 * 的 `<titleSlug>-<id>` vanity path 混淆——見該函式與 `extractRefUuid` 的說明）。
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
 * 從標題產生「vanity slug」——僅供 `canonicalNotePath` 組裝好看、非唯一的 URL 片段
 * （真正查找靠 `<id>` 尾碼，見 `extractRefUuid`），因此刻意不做大小寫正規化
 * （與需要唯一比對的自訂 slug 不同，那條路徑一律經 `normalizeSlug`）。
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
 * 從 ref 字串（可能是純 uuid，或 `<vanity>-<uuid>` 形式）擷取尾碼 uuid，供
 * `GET /api/notes/:ref` 在 slug 精確比對失敗後的第二段查找路徑。找不到回傳 null。
 */
export function extractRefUuid(ref: string): string | null {
  if (UUID_RE.test(ref)) return ref.toLowerCase();
  const match = UUID_SUFFIX_RE.exec(ref);
  if (match) return match[0].slice(1).toLowerCase();
  return null;
}

/**
 * 組出筆記的「canonical」路徑，供 NoteList href、TitleInput 存檔後
 * `history.replaceState`、分享 dialog 複製連結共用。三態：
 * 1. 有自訂 slug（DB 已驗證合法且唯一）→ `/notes/<slug>`。
 * 2. 無 slug、但 title 轉得出非空 vanity slug → `/notes/<titleSlug>-<id>`。
 * 3. 無 slug 且 title 轉出空字串（例如全符號標題）→ 純 `/notes/<id>`。
 */
export function canonicalNotePath(note: { id: string; slug: string | null; title: string }): string {
  if (note.slug) return `/notes/${note.slug}`;
  const vanity = titleSlug(note.title);
  return vanity ? `/notes/${vanity}-${note.id}` : `/notes/${note.id}`;
}

/**
 * #72：空 Y.Doc 的合法 update 編碼（`Y.encodeStateAsUpdate(new Y.Doc())` ＝ `[0,0]`
 * 的 base64）。公開端點對「筆記從沒開過編輯器（查無 note_states）」回這個值——
 * **不能回空字串／零長度**：`Y.applyUpdate(doc, new Uint8Array())` 會 throw（實測），
 * 公開頁直接爆。server 回它、web 端測試斷同一份；「這個字面真的等於空文件編碼」
 * 由 server 的 unit 釘住（防兩端 import 同一個錯值的套套邏輯）。
 */
export const EMPTY_YDOC_UPDATE_B64 = "AAA=";
