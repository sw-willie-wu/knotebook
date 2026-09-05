import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyFormbody from "@fastify/formbody";
import { MAX_UPLOAD_BYTES, SESSION_COOKIE, type ErrorCode, type RequiredScope, type TokenScope } from "@knotebook/shared";
import { publicUrlIssuer, type AppConfig } from "./config.js";
import type { Db } from "./db/index.js";
import { verifySession, type GateUser, type UserGate } from "./auth/session.js";
import { createAuthenticateAny } from "./auth/bearer.js";
import type { LoginThrottle } from "./auth/rate-limit.js";
import type { CollabHooks } from "./collab/hooks.js";
import type { CollabServer } from "./collab/server.js";
import { authRoutes } from "./routes/auth.js";
import { notesRoutes } from "./routes/notes.js";
import type { WriteNoteLinksHooks } from "./notes/links.js";
import { adminUsersRoutes } from "./routes/admin-users.js";
import { adminAiRoutes } from "./routes/admin-ai.js";
import { aiRoutes } from "./routes/ai.js";
import { uploadsRoutes } from "./routes/uploads.js";
import { publicRoutes, redactPublicTokens } from "./routes/public.js";
import { oidcRoutes } from "./routes/oidc.js";
import { mcpRoutes } from "./routes/mcp.js";
import { apiTokensRoutes } from "./routes/api-tokens.js";
import { drainWithCap } from "./http/drain.js";
import { sendError } from "./http/errors.js";
import { AI_LIMIT, AUTHORIZE_LIMIT, BEARER_MISS_LIMIT, COLLAB_TOKEN_LIMIT, DCR_LIMIT, FixedWindowLimiter, OIDC_LIMIT, PAT_CREATE_LIMIT, PUBLIC_LINK_LIMIT, PUBLIC_MISS_LIMIT, PUBLIC_NOTE_LIMIT, PUBLIC_UPLOAD_LIMIT, SLUG_PATCH_LIMIT, TOKEN_ENDPOINT_LIMIT, TOKEN_READ_LIMIT, TOKEN_WRITE_LIMIT, UPLOAD_LIMIT } from "./http/rate-limit.js";
import { FORM_EXEMPT_ROUTES, isOauthScopedPath, sendOauthError } from "./http/oauth-errors.js";
import { oauthRoutes } from "./routes/oauth.js";
import { oauthMetadataRoutes } from "./routes/oauth-metadata.js";
import { oauthApiRoutes } from "./routes/oauth-api.js";
import { registerSpaFallback } from "./http/spa.js";
import { assertUploadsDirWritable } from "./uploads/service.js";
import type { AiRuntime } from "./ai/runtime.js";
import { createOidcRuntime, type OidcRuntime } from "./auth/oidc-client.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    /** #107：opt-in 的 Bearer／session 雙路徑認證，語意見 `auth/bearer.ts`。 */
    authenticateAny(
      required: RequiredScope,
      challenge?: string
    ): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user?: GateUser;
    /**
     * `authenticate` 通過時一併記下當次 session JWT 的 `tv`（與 `request.user` 同時
     * 設定，見下方 decorator）——`POST /api/notes/:id/collab-token`（Task 4）簽發
     * collab token 時需要它塞進 `CollabTokenClaims.tv`，但 `GateUser`（`gate.check`
     * 的回傳形狀）本身不帶 tv，故另開這個欄位，不擴充 `GateUser` 型別本身。
     */
    sessionTv?: number;
    /** #107：這一發是 cookie session 還是 API token 認證的。錯誤 log 只印這個與 tokenId。 */
    authKind?: "session" | "token";
    /** #107：token 路徑才有——落庫的正規化 scope 集合。 */
    tokenScope?: TokenScope;
    /** #107：token 路徑才有——`api_tokens.id`（**不是**明文，明文永不進 log）。 */
    tokenId?: string;
  }
}

export interface AppDeps {
  config: AppConfig;
  db: Db;
  gate: UserGate;
  throttle: LoginThrottle;
  collabHooks: CollabHooks;
  /**
   * 即時協作（Hocuspocus）server。**選配**：不傳就不掛 `/collab`，一般 REST 測試
   * （`buildTestApp`）與只跑 REST 的情境完全不受影響；傳入時 `buildApp` 會把它的
   * WebSocket upgrade handler 掛上本 app 的底層 http server。
   */
  collab?: CollabServer;
  /**
   * per-user 固定視窗節流器（Task 4：collab-token；Task 8：slug PATCH；Task 10b：
   * uploads）。**選配**：`index.ts` 的 `AppDeps` 物件字面值不在 Task 4 的 Files 內，
   * 必填會讓 Task 4–6 之間 `pnpm -r build` 全紅（vitest 不做型檢，會綠色假象）。未傳時
   * `buildApp` 內建生產預設（見 `COLLAB_TOKEN_LIMIT`/`SLUG_PATCH_LIMIT`/`UPLOAD_LIMIT`，
   * `http/rate-limit.ts`）。
   *
   * `buildTestApp`/`buildCollabTestApp`（`test/helpers.ts`）每次呼叫一律注入**全新
   * 實例**——嚴禁 module 單例，否則不同測試檔案共享同一份計數會互相汙染。
   */
  limiters?: {
    collabToken: FixedWindowLimiter;
    slugPatch: FixedWindowLimiter;
    upload: FixedWindowLimiter;
    ai: FixedWindowLimiter;
    /** OIDC login 與 callback 各自一份額度（issue #16），見 `OIDC_LIMIT` 註解。 */
    oidcLogin: FixedWindowLimiter;
    oidcCallback: FixedWindowLimiter;
    /** #72：public-link 管理端 PUT/DELETE（key=userId；GET 不吃桶，見 PUBLIC_LINK_LIMIT）。 */
    publicLink: FixedWindowLimiter;
    /** #72 公開端點雙桶（miss=ip／hit=ip:token，語意見 PUBLIC_MISS_LIMIT 註解）。 */
    publicMiss: FixedWindowLimiter;
    publicNote: FixedWindowLimiter;
    publicUpload: FixedWindowLimiter;
    /** #107：Bearer token 路徑（key=`token:${userId}`），session 路徑不吃桶。 */
    tokenRead: FixedWindowLimiter;
    tokenWrite: FixedWindowLimiter;
    /** #107：無效 Bearer（key=ip）——consume 的觸發集合見 `BEARER_MISS_LIMIT` 註解。 */
    bearerMiss: FixedWindowLimiter;
    /** #107：`POST /api/auth/tokens`（key=userId）。 */
    patCreate: FixedWindowLimiter;
    /** #132：DCR／authorize／token 三個無認證端點（key=ip）。 */
    dcr: FixedWindowLimiter;
    authorize: FixedWindowLimiter;
    tokenEndpoint: FixedWindowLimiter;
  };
  /**
   * Task 5：`POST /api/notes/:id/links` 寫入函式（`notes/links.ts` 的 `writeNoteLinks`）的
   * 測試注入縫，透傳進 `NotesRouteDeps`。**選配**：production／未覆寫時整段為
   * `undefined`，`writeNoteLinks` 的 `hooks` 參數預設 `{}`，等同 no-op。整合測試唯一的
   * 注入面是 `buildTestApp({ linkSyncTestHooks })`——route deps 本身不對外暴露，不開這個
   * `AppDeps` 欄位測試就碰不到 `beforeLinkWrite`（見 links.ts 的 FK race 測試注入縫說明）。
   */
  linkSyncTestHooks?: WriteNoteLinksHooks;
  /**
   * #122 PR2：PATCH auto slug 的測試注入縫（語意見 `NotesRouteDeps.slugUpdateTestHook`）。
   * **選配**：production／未覆寫時 `undefined`＝no-op；整合測試唯一注入面是
   * `buildTestApp({ slugUpdateTestHook })`（比照 `linkSyncTestHooks`）。
   */
  slugUpdateTestHook?: (candidate: string) => void | Promise<void>;
  /**
   * Task 9：圖片上傳存放目錄的絕對路徑。**必填**——`buildApp` 啟動時會對它做一次
   * 可寫性探測（`assertUploadsDirWritable`，見該函式說明為何不用 `accessSync`），
   * 失敗即同步 throw、fail-fast，不等到第一個上傳請求才發現環境問題。
   *
   * 呼叫點：`src/index.ts`（production，目錄由 `mkdirSync(..., {recursive:true})`
   * 保證存在後才傳入）、`test/helpers.ts` 的 `buildTestApp`/`buildCollabTestApp`
   * （per-test 用 `mkdtempSync` 建真實 temp 目錄，`onTestFinished` 清理，比照
   * `freshDb()` 的慣例）、`test/env-admin-bootstrap.test.ts`（手動組裝 deps，同樣
   * 需要真實可寫目錄）。
   */
  uploadsDir: string;
  /**
   * Plan 4（spec §13）：AI 執行期狀態（目前只有 `degraded` 降級集合）。**必填**——
   * 本 task（Task 3）只建 runtime 本身與啟動自檢（`src/index.ts` 的
   * `createAiRuntime()` + `selfCheckAiKeys`），路由層的實際消費（resolve provider/
   * model、套用降級判斷）留給 Task 4；先把它擺進 `AppDeps` 而非暫存局部變數/TODO，
   * 是為了不讓 Task 4 又要回頭補一輪全部 deps 建構點（比照 Task 9 `uploadsDir` 的
   * 前車之鑑）。呼叫點同 `uploadsDir`：`src/index.ts`（production）、
   * `test/helpers.ts` 的 `buildTestApp`/`buildCollabTestApp`、
   * `test/env-admin-bootstrap.test.ts`（手動組裝 deps）。
   */
  ai: AiRuntime;
  /**
   * Task 8：`GET /api/auth/oidc/login`（Task 9 追加 callback）消費的 OIDC runtime
   * （lazy discovery 三態快取，`auth/oidc-client.ts`）。**測試注入 seam**——整合測試用
   * `createOidcRuntime(oidc, { fetch: fakeIdp.fetch })` 掛 in-process mock IdP（見
   * `test/helpers/fake-idp.ts`），不開真 socket。**選配，且 fallback 由 `buildApp`
   * 承擔**（不是「未傳就不掛路由」——`config.oidc` 有值而這裡 undefined 時，`buildApp`
   * 會自己用 `createOidcRuntime(deps.config.oidc)` 補上，避免「config.oidc 有值但
   * runtime 沒接上」這個矛盾狀態讓 login route 的 `runtime.getConfiguration()` 撞
   * TypeError 500（違反兩端點 302 語彙不變量，二輪 MINOR-8）。`config.oidc` 未設時
   * 這個欄位無論傳不傳都不會被用到（login route 的第一個分支就短路回
   * `oidc_unavailable` 302）。
   */
  oidc?: OidcRuntime;
}

export interface BuildAppOptions {
  /**
   * 覆寫 fastify logger 設定。預設 true——`Fastify({ logger })` 的全域 request
   * logging（production 部署需要它）。測試環境（`test/helpers.ts` 的
   * `buildTestApp`/`buildCollabTestApp`）每支整合測試預設關閉（`{ logger: false }`）
   * 以降低雜訊，可再覆寫回開（例如要除錯某個測試的實際請求日誌時）。
   *
   * 型別放寬到 fastify 自己的 logger 選項（涵蓋 `boolean`）：`test/admin-ai.test.ts` 需要
   * 掛一個 pino `logMethod` hook 去攔截「改 base URL」那行稽核日誌——docs 逐字引用了它的
   * 訊息字串，得有測試釘住。production 呼叫端照舊只傳 boolean。
   */
  logger?: FastifyServerOptions["logger"];
  /**
   * 前端建置產物目錄的絕對路徑（Task 9，spec §11.5 SPA fallback）。傳入時掛
   * `@fastify/static` 服務 `/assets/*` 等實際存在的檔案，並讓未命中路由的 GET/HEAD
   * （非 `/api`／`/collab`／`/healthz`／`/assets` 前綴、Accept 含 `text/html`）回
   * `index.html`；不傳（或 production `src/index.ts` 啟動檢查發現目錄不存在）時，
   * 未命中路由一律維持既有 JSON 404，行為與加這個 task 之前完全相同。見 `http/spa.ts`。
   */
  webDist?: string;
  /**
   * `POST /api/ai` SSE idle 逾時（無 delta 即中止）覆寫值，毫秒。**測試 seam**——見
   * `routes/ai.ts` 的 `AiRouteDeps.idleTimeoutMs` 說明（CI flake round 2：假時鐘 × 真
   * SSE I/O 在 CI 上不可靠，改用可注入的短真實逾時代替）。**選配**：不傳沿用生產預設
   * 60s（`routes/ai.ts` 的 `IDLE_TIMEOUT_MS`）——production（`src/index.ts` 從不傳這個
   * 選項）與既有測試（未特別覆寫時）行為不變。
   */
  aiIdleTimeoutMs?: number;
}

const CHANGE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// PLAN3（§12.4）：JSON CSRF hook 對 multipart 上傳路由的白名單豁免——`"METHOD url"`
// 形狀，`url` 用 `request.routeOptions.url`（route pattern，含 `:id` 這類參數佔位符，
// 不是實際請求路徑）比對，故單一字面值即可涵蓋所有 note id。
const MULTIPART_EXEMPT_ROUTES = new Set(["POST /api/notes/:id/uploads"]);

/**
 * 判定這個請求是否命中 multipart 豁免白名單。`request.is404` 必須先擋——404 請求的
 * `routeOptions.url` 是 `undefined`（fastify 型別註記：is404 為真時 config.url 未設），
 * 若不擋會讓 `undefined` 意外落進 Set.has 的比對（恆 false，但語意上不該讓 404 request
 * 走到這段判定，容易在之後改動時踩雷）。
 */
function isMultipartExemptRoute(request: FastifyRequest): boolean {
  if (request.is404) return false;
  const url = request.routeOptions.url;
  if (url === undefined) return false;
  return MULTIPART_EXEMPT_ROUTES.has(`${request.method} ${url}`);
}

/**
 * 兩側 `:80`/`:443` 預設 port 消去後再比對（spec §12.4：scheme 忽略、IPv6 方括號原樣）。
 *
 * 手寫 regex 而非借用 `new URL().host` 的內建預設 port 消去，是刻意選擇，不是偷懶：
 * 1. 比對的另一側（`request.host`）根本不是 URL——它是裸的 `Host`/`X-Forwarded-Host`
 *    header 值（例如 `example.com:443`），沒有 `URL` 物件可用，沒有 scheme 可言。
 * 2. `URL.host` 的預設 port 消去是 **scheme-bound** 的（`https://x:443` 消去、
 *    `http://x:443` 不會——443 不是 http 的預設 port）；但 spec 明文「scheme 忽略」——
 *    若真要湊出一個 `URL` 來讓內建消去生效，得先幫 `request.host` 那側**假造一個
 *    scheme**（例如硬套 `https://`）才能餵給 `new URL()`，這個假造的 scheme 會跟
 *    「scheme 忽略」的契約直接打架（相當於偷偷把 scheme 又塞回比對邏輯裡）。
 * 手寫、對稱地在兩側字面字串上剝 `:80`/`:443` 後綴，才是唯一不引入假 scheme 的作法。
 */
function stripDefaultPort(host: string): string {
  return host.replace(/:(?:80|443)$/, "");
}

/**
 * multipart 豁免路由的 CSRF 防線：Origin 驗證（spec §12.4）。比較對象是
 * `new URL(origin).host` 與 **`request.host`**——不是 `hostname`：後者剝除 port，會讓
 * LAN 形狀（`192.168.3.22:8006`）與 dev（`localhost:5173`）全部誤判不符。
 *
 * `Origin: "null"`（沙箱化 iframe 等情境瀏覽器字面送出的字串 "null"）與任何無法用
 * `new URL()` 解析的 Origin 值一律視為不符——保守以對，不放行無法驗證的來源。
 * 呼叫端負責「無 Origin header → 放行」（spec 明文；不在此函式內判定，因為
 * `undefined` 不該被硬塞進來解讀成某種「值」）。
 *
 * **已知前提（trustProxy）**：`request.host` 在信任代理時，若請求帶 `X-Forwarded-Host`
 * 且來源 socket 通過 trustProxy 判定，會採信該 header 而非實際的 `Host` header（fastify
 * `buildRequestWithTrustProxy` 的既定行為，非本函式決定）。issue #13 之後 `trustProxy`
 * 預設是 `false`，所以預設部署下這條前提根本不成立；設了 `TRUST_PROXY` 的部署則落在
 * 「只有被信任的來源送的 header 會被採信」這一側。
 *
 * 即使在最寬鬆的 `TRUST_PROXY=true` 下也**不可從瀏覽器利用**：本站無 CORS 設定，跨源
 * 請求若帶自訂 header（如 `X-Forwarded-Host`）會觸發 preflight，瀏覽器在收不到允許的
 * CORS 回應前就會擋下；`<form>` 提交（唯一免 preflight 的跨站攻擊面）無法附加自訂
 * header。**若日後加 CORS，這個前提會失效。**
 */
function isOriginAllowed(origin: string, requestHost: string): boolean {
  if (origin === "null") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return stripDefaultPort(originHost) === stripDefaultPort(requestHost);
}

// `sendError` 定義於 `./http/errors.js`（不被任何 routes/* 依賴的葉節點模組），
// app.ts 與各路由模組（setup.ts、auth.ts、…）都從那裡 import，不在此重新宣告——
// 避免 app.ts ↔ routes/* 之間的循環 import（前幾輪曾靠「具名 function 宣告會被
// ESM 整個 hoist」規避，現在直接消除循環，不用再依賴那個前提）。

/** 4xx 錯誤碼映射：已知的具體碼優先，其餘 4xx 一律歸類 bad_request（不可吞成 500）。 */
function clientErrorCode(statusCode: number): ErrorCode {
  if (statusCode === 415) return "unsupported_media_type";
  return "bad_request";
}

/**
 * Fastify app 工廠：掛好 cookie 解析、統一錯誤格式（含 404/415/4xx/500）、認證/授權
 * decorator（`authenticate`/`requireAdmin`）與 `/healthz`。路由本身由後續 task
 * （Task 8/9/10/12）以 `app.register(...)` 掛進來——本 task 只建骨架與接縫。
 */
/**
 * #72（Task 1c）：把 token 遮罩的 `req` serializer 合併進 fastify logger 設定。
 * - `false`（測試預設關 log）原樣通過；`true` 展開成物件形；物件形保留呼叫端的
 *   其餘欄位、**覆蓋 `serializers.req`**（呼叫端不得自帶——會被這裡蓋掉，這是
 *   刻意的：遮罩是安全不變量，不給關）。
 * - serializer 輸出鏡射 fastify 預設 req serializer 的欄位（method/url/version/host/
 *   remoteAddress/remotePort——與 logger-pino.js 逐欄對過：`host` 含 port、
 *   `version` 取 accept-version header），只差 url 過 `redactPublicTokens`。
 */
function withTokenRedaction(logger: FastifyServerOptions["logger"]): FastifyServerOptions["logger"] {
  if (logger === false) return false;
  const base = logger === true ? {} : (logger ?? {});
  return {
    ...base,
    serializers: {
      ...(typeof base === "object" && "serializers" in base ? base.serializers : {}),
      req(request: FastifyRequest) {
        return {
          method: request.method,
          url: redactPublicTokens(request.url),
          version: typeof request.headers["accept-version"] === "string" ? request.headers["accept-version"] : undefined,
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        };
      },
    },
  };
}
export function buildApp(deps: AppDeps, options: BuildAppOptions = {}): FastifyInstance {
  // Task 9：uploads 目錄可寫性探測放在最前面、任何 Fastify 初始化之前——這是一個
  // 獨立於 HTTP 框架的環境前置條件（同 index.ts 的 migration fail-fast 精神），
  // 失敗就不該繼續往下建 app。
  assertUploadsDirWritable(deps.uploadsDir);

  // maxParamLength 預設 100：find-my-way 是量「解碼後」的 UTF-16 code unit 數，跟
  // `titleSlug`／`validateSlug` 量的是 code point 數（60／100）不是同一把尺——
  // astral 字元（例如 𠮷）解碼後是 2 個 UTF-16 unit，60 個 astral 字算下來就破百。
  // #122 之後新網址不再組 `<vanity>-<uuid>` 長 ref，但**舊版發出去的長連結永久活著**
  // （uuid 尾碼解析），這個修正不能跟著消失——守衛見 notes-slug.test.ts 的
  // 「解碼後 UTF-16 長度 > 100 的舊形長 ref」案（414 URI Too Long 實測，連 handler
  // 都不會被呼叫）。512 給足緩衝，不必跟著 slug 規則同步微調。必須放進 `routerOptions`，不能當 Fastify 建構子的頂層選項——頂層
  // `maxParamLength` 是 deprecated 寫法（FSTDEP022），fastify@6 會整個移除，屆時會
  // 靜默退回預設值 100，等於這個修正自己失效又不出任何警告；`routerOptions` 這個
  // 寫法才是不會過期、也不會印 deprecation warning 的形式。
  // trustProxy 由 `TRUST_PROXY` 決定，預設 `false`（issue #13）：採信一個任何人都能自己
  // 填的 header，等於所有 per-IP 節流都能換個假 IP 繞過。反代拓撲要自己打開——見
  // `config.ts` 的 `parseTrustProxy`，以及下面那道一次性的錯配警告。
  const app = Fastify({
    // #72（Task 1c）：req serializer 由這裡**無條件合併**進最終 logger 設定——寫在
    // `?? true` 的預設側會被注入 logger 整份取代（測試注入 destination 後 production
    // 零遮罩照樣綠的假守衛形，spec B 不變量）。fastify 預設 req serializer 會印
    // `req.url`，分享 token 走 URL（/p/、/api/public/notes/），不遮就逐筆進 log。
    // 測試只注入 destination/stream、禁止自帶 serializers（帶了會被這裡覆蓋 req 鍵）。
    logger: withTokenRedaction(options.logger ?? true),
    trustProxy: deps.config.trustProxy,
    routerOptions: { maxParamLength: 512 },
  });

  // 設定錯配的一次性警告（issue #13）。`TRUST_PROXY` 沒設、請求卻帶著
  // `X-Forwarded-For`，代表前面確實有一層代理而我們沒被告知——後果不是「被繞過」而是
  // 「拒絕服務」：`request.ip` 會是代理的位址，於是**所有使用者共用同一個 IP 軌**，任何人
  // 連錯 5 次密碼就把整個站鎖進退避窗口。這種錯配從外部看只像「大家突然都登不進去」，
  // 沒有訊號的話幾乎不可能診斷出來。
  //
  // 只警告一次：這是部署設定問題，不是每個請求的事件，重複噴只會淹掉 log。
  if (!deps.config.trustProxy) {
    let warned = false;
    app.addHook("onRequest", async request => {
      // 不只看 `x-forwarded-for`：只送 `X-Real-IP`（很常見的 nginx 樣板）或 RFC 7239
      // `Forwarded` 的代理，症狀一模一樣（全站共用一份 IP 額度），但 fastify 推導
      // `request.ip` 只讀 `x-forwarded-for`——那種錯配更需要被講出來，不是更不需要。
      const forwardedHeaders = ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host", "x-forwarded-proto"];
      if (warned || !forwardedHeaders.some(name => request.headers[name] !== undefined)) return;
      warned = true;
      request.log.warn(
        { hint: "TRUST_PROXY" },
        "收到帶轉發 header 的請求，但 TRUST_PROXY 未設定：所有 per-IP 節流會以代理的位址為準（全站共用一份額度）。反代拓撲請設定 TRUST_PROXY，見 docs/self-hosting.md"
      );
    });
  }

  // 不用 secret：session 是自帶簽章的 JWT，cookie 本身不需要再簽一次。
  void app.register(fastifyCookie);

  // Task 10b：`@fastify/multipart` 必須註冊在頂層 `app`（這裡），**不可**移進
  // `uploadsRoutes` 自己的 register 函式內——`app.register(uploadsRoutes(...))` 對
  // `uploadsRoutes` 這個純函式（未用 `fastify-plugin` 包裝）而言會建立新的封裝
  // 子情境，若在那個子情境內才註冊 multipart，`@fastify/multipart` 掛的
  // content-type parser／decorator 只在該子情境內可見，不會外溢到 `app` 上其他
  // 路由（例如 `/api/auth/login`）。這件事本身雖不影響功能正確性，但會讓「multipart
  // parser 真的可用、只有白名單判定能擋下非豁免路由」這個不變量在生產拓撲下不成立
  // ——`test/uploads.test.ts` 的 CSRF 迴歸測試（multipart body 打 `/api/auth/login`
  // 仍 415）就是靠「parser 全域可用」這個前提才具備 mutation 鑑別力（見該測試檔說明），
  // 註冊位置一旦挪動，測試看起來還是綠，但鑑別力已經悄悄消失。
  //
  // `limits`（spec §12.4）：`fileSize` 用 `MAX_UPLOAD_BYTES`（10 MiB）；`parts`/`fields`/
  // `fieldSize` 是防病態 multipart body 的粗閘（32 parts、16 fields、每個 field 1 KiB）。
  // 刻意**不設 `limits.files`**——`routes/uploads.ts` 自己處理「多個 file part 只取
  // 第一個，其餘 drain」；設了 `files` 上限會讓外掛在偵測到第二個 file part 時自己
  // 丟 `FilesLimitError`（413），直接逃逸出我們手動控制的「取第一個」邏輯。
  //
  // `throwFileSizeLimit:false`：超過 `fileSize` 不丟例外，只把該 file part 的
  // `.truncated` 設為 true——`routes/uploads.ts` 自己判斷 truncated 狀態、映射成
  // 契約要求的 413 `file_too_large`，不吃外掛預設丟出的 `RequestFileTooLargeError`
  // （那個錯誤沒有我們要的錯誤碼語意，且會在其他 file part 還沒處理完時就中斷整個
  // `parts()` 迭代，讓「其餘 drain」做不到）。
  void app.register(fastifyMultipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, parts: 32, fields: 16, fieldSize: 1024 },
    throwFileSizeLimit: false,
  });

  // #132：`POST /oauth/token` 是 form 端點（OAuth 規格要求）。與 multipart 同層註冊在
  // 頂層 app——放進封裝 plugin 內 parser 不會外溢，守衛測試的鑑別力會靜默消失。
  void app.register(fastifyFormbody);

  // issue #101：`nosniff` 掛在**每一個**回應上。CSP 只對 HTML 文件有意義（掛在
  // `http/spa.ts` 回 index.html 那條路徑），但這個標頭是逐回應的便宜防線，JSON 錯誤
  // 與 `/assets/*.js` 也該有——擋掉「瀏覽器猜錯 content-type 就把回應當成別的型別執行」
  // 那一族。守衛：`test/spa.test.ts` 的「nosniff 掛在每個回應上」。
  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
  });

  // 全域 onRequest hook：只要有呼叫 setNotFoundHandler，onRequest 就會對「未匹配路由」
  // 也執行（fastify#3120 結論）——不可把這段邏輯改掛進 setNotFoundHandler 的 options，
  // 其只接受 preValidation/preHandler，掛 onRequest 會直接報錯。
  app.addHook("onRequest", async (request, reply) => {
    if (!CHANGE_METHODS.has(request.method)) return;

    // 有 body 的判定：content-length 存在且非 0，或用 chunked transfer-encoding
    // （這種請求沒有 content-length，但仍然帶 body，必須視為「有 body」）。
    // 無 body 的變更請求（例如 POST /logout 不帶 Content-Type/body）則放行——
    // 不能對這類請求一律要求 application/json。
    const transferEncoding = request.headers["transfer-encoding"];
    const contentLength = request.headers["content-length"];
    const hasBody = transferEncoding !== undefined || (contentLength !== undefined && contentLength !== "0");
    if (!hasBody) return;

    // MIME essence 等值比對（忽略 `;charset=...` 等參數）——不可用 substring
    // includes：`text/plain;charset=application/json` 是 CORS-safelisted 的
    // Content-Type，若用 includes 會被誤判為合法 JSON 請求而放行，等於繞過守衛。
    const contentType = request.headers["content-type"];
    const essence = contentType?.split(";")[0]?.trim().toLowerCase();

    // PLAN3（§12.4）：multipart 上傳路由豁免 JSON 檢查，改走「essence 必須是
    // multipart/form-data，否則 415」+ Origin 驗證。豁免不等於不驗證——四輪 gate m7：
    // 放行任意 Content-Type 會讓 `application/json` 打上傳端點落到 `@fastify/multipart`
    // 丟出非契約錯誤（而非我們的 415 統一格式）。
    //
    // drain 通則（四輪 gate M3；五輪 n1；**rev 5.9 §13.2：改由 `drainWithCap` helper
    // 承接**，語意不變、加位元組上限）：這兩條早退路徑（essence 415、Origin 403）
    // 回應前必須 drain 讓 Node 消費剩餘 body——不 await `end`（大檔
    // 上傳中途拒絕不能白等整個 body 傳完才回應），也不能完全不消費（完全不消費會讓
    // client 在傳輸中收到 network error 而非結構化 error body，i18n toast 拿不到
    // code）。下方既有的 JSON essence 415（非豁免路由）刻意不加 drain——spec §12.4 的
    // drain 通則逐字列舉的早退路徑只有「onRequest 的 Origin 403 與 essence 415」（指
    // multipart 豁免路由這兩條），不含一般路由的 JSON essence 415；後者在產品環境本來
    // 就幾乎不可達（正常 client 打 JSON API 一律帶 `application/json`，這條分支只在
    // 誤用/探測時觸發，非大檔上傳情境），不在這次擴充的 drain 範圍內。

    // #132：兩個 RFC 形前綴的 415 要走 RFC 形 body。用 URL 前綴判定（404 時
    // routeOptions.url 是 undefined），只有豁免路由收 form。
    const pathname = request.url.split("?")[0]!;
    if (isOauthScopedPath(pathname)) {
      const wantsForm = !request.is404 && FORM_EXEMPT_ROUTES.has(`${request.method} ${request.routeOptions.url}`);
      const expected = wantsForm ? "application/x-www-form-urlencoded" : "application/json";
      if (essence !== expected) {
        return sendOauthError(reply, 415, "invalid_request", `此請求需要 ${expected}`);
      }
      return;
    }

    if (isMultipartExemptRoute(request)) {
      if (essence !== "multipart/form-data") {
        drainWithCap(request);
        return sendError(reply, 415, "unsupported_media_type", "此請求需要 multipart/form-data");
      }
      const origin = request.headers.origin;
      if (origin !== undefined && !isOriginAllowed(origin, request.host)) {
        drainWithCap(request);
        return sendError(reply, 403, "forbidden", "Origin 驗證失敗");
      }
      // Origin 相符，或無 Origin header（spec 明文放行）——落到 preHandler/handler。
      return;
    }

    if (essence !== "application/json") {
      return sendError(reply, 415, "unsupported_media_type", "此請求需要 application/json");
    }
  });

  /**
   * cookie session 的解析，**不送回應**——回 null 就是「這個請求沒有有效 session」，
   * 由呼叫端決定那代表什麼。
   *
   * #107 把它從 `authenticate` 抽出來的理由：Bearer 那條路徑（`auth/bearer.ts` 的
   * `authenticateAny`）不能靠呼叫 `authenticate` 來做 cookie 回退。`sendError`
   * 內含 `reply.send()`，之後再 `reply.header()` 補 `WWW-Authenticate` 只會寫進
   * `kReplyHeaders`、而 onSend 鏈已經排程——header 會**靜默消失**（fastify 5 實測）。
   * 兩個 decorator 因此各自決定回應，只共用這一支解析。
   */
  async function resolveSessionUser(request: FastifyRequest): Promise<{ user: GateUser; tv: number } | null> {
    const token = request.cookies[SESSION_COOKIE];
    const session = token ? await verifySession(deps.config.appSecret, token) : null;
    if (!session) return null;
    const result = await deps.gate.check(session.userId, session.tv);
    if (result.status !== "ok") return null;
    return { user: result.user, tv: session.tv };
  }

  // 以下兩個 decorator 都以一般具名函式（而非箭頭函式綁 this）宣告，但內部完全不用
  // `this`——`requireAdmin` 呼叫 `authenticate` 是透過閉包捕捉的外層 `app` 變數，
  // 不依賴 fastify 呼叫時的 this 綁定，故用 `app.authenticate(...)`／
  // `app.requireAdmin(...)`（或當作 preHandler 傳給其他路由）皆可正確運作。
  app.decorate("authenticate", async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const resolved = await resolveSessionUser(request);
    if (!resolved) {
      sendError(reply, 401, "unauthorized", "未登入");
      return;
    }
    // ⚠ `sessionTv` 不得漏：`POST /api/notes/:id/collab-token` 是它全 repo 唯一的
    // 消費者，漏了會讓簽出的 collab token 帶 undefined tv。
    request.user = resolved.user;
    request.sessionTv = resolved.tv;
  });

  app.decorate("requireAdmin", async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (!request.user?.isAdmin) {
      sendError(reply, 403, "forbidden", "需要管理員權限");
    }
  });

  app.get("/healthz", async () => ({ ok: true }));

  // 未收到 AppDeps.limiters 時的生產預設（`buildTestApp`/`buildCollabTestApp` 一律自己
  // 注入全新實例，不會走到這裡；見 AppDeps.limiters 的說明）。
  const limiters =
    deps.limiters ??
    ({
      collabToken: new FixedWindowLimiter(COLLAB_TOKEN_LIMIT),
      slugPatch: new FixedWindowLimiter(SLUG_PATCH_LIMIT),
      upload: new FixedWindowLimiter(UPLOAD_LIMIT),
      ai: new FixedWindowLimiter(AI_LIMIT),
      oidcLogin: new FixedWindowLimiter(OIDC_LIMIT),
      oidcCallback: new FixedWindowLimiter(OIDC_LIMIT),
      publicLink: new FixedWindowLimiter(PUBLIC_LINK_LIMIT),
      publicMiss: new FixedWindowLimiter(PUBLIC_MISS_LIMIT),
      publicNote: new FixedWindowLimiter(PUBLIC_NOTE_LIMIT),
      publicUpload: new FixedWindowLimiter(PUBLIC_UPLOAD_LIMIT),
      tokenRead: new FixedWindowLimiter(TOKEN_READ_LIMIT),
      tokenWrite: new FixedWindowLimiter(TOKEN_WRITE_LIMIT),
      bearerMiss: new FixedWindowLimiter(BEARER_MISS_LIMIT),
      patCreate: new FixedWindowLimiter(PAT_CREATE_LIMIT),
      dcr: new FixedWindowLimiter(DCR_LIMIT),
      authorize: new FixedWindowLimiter(AUTHORIZE_LIMIT),
      tokenEndpoint: new FixedWindowLimiter(TOKEN_ENDPOINT_LIMIT),
    } satisfies NonNullable<AppDeps["limiters"]>);

  // #107：`limiters` 在上面才算出來，所以這個 decorate 必須排在它之後、任何
  // `app.register(路由)` 之前——路由模組的 register 內會呼叫 app.authenticateAny。
  // （`limiters` 為此上移到 authRoutes 之前；已查證 `AuthRouteDeps` 沒有 limiters 欄，
  // 上移不改變任何行為。）
  app.decorate(
    "authenticateAny",
    createAuthenticateAny({
      db: deps.db,
      gate: deps.gate,
      // D12：issuer 一律取 **origin**（`publicUrlIssuer`）。⚠ 寫成 `.href` 會多一個尾
      // 斜線（`http://localhost:3000/`），challenge 就變成 `…3000//.well-known/…`——
      // api-token-auth.test.ts 的第一個 it 對 resource_metadata 做逐字 toContain，會抓到。
      issuer: publicUrlIssuer(deps.config.publicUrl),
      resolveSessionUser,
      limiters: { bearerMiss: limiters.bearerMiss, tokenRead: limiters.tokenRead, tokenWrite: limiters.tokenWrite },
    })
  );

  void app.register(
    authRoutes({ db: deps.db, config: deps.config, gate: deps.gate, throttle: deps.throttle, collabHooks: deps.collabHooks })
  );
  // #107：PAT 管理端點——cookie 專用（token 不能簽發或撤銷 token），見 routes/api-tokens.ts 檔頭。
  void app.register(apiTokensRoutes({ db: deps.db, limiters: { patCreate: limiters.patCreate } }));
  // #132：同意頁的站內端點（cookie session、站內錯誤形），與 RFC 形的 /oauth 分開。
  void app.register(oauthApiRoutes({ db: deps.db, config: deps.config }));

  // Task 8（二輪 MINOR-8）：`deps.oidc` 未傳但 `config.oidc` 有值時在此補上 production
  // runtime——不能讓「config.oidc 有值而 runtime undefined」這個矛盾狀態流進
  // `oidcRoutes`，否則 login route 的 `runtime.getConfiguration()` 會撞 TypeError 500，
  // 違反「OIDC 相關端點一律回 302，不回未預期的 5xx」這個不變量。`config.oidc`
  // 未設時 `deps.oidc` 無論是否傳值都不會被用到（`oidcRoutes` 的第一個分支已經用
  // `config.oidc === undefined` 短路）。
  const oidcRuntime = deps.oidc ?? (deps.config.oidc ? createOidcRuntime(deps.config.oidc) : undefined);
  // Task 9：callback 需要 db（帳號解析交易）與 gate（連結/建帳/清 mustChangePassword
  // 後 invalidate 快取）——login 半邊不需要這兩個，但兩端點共用同一個 register 函式，
  // deps 一併傳入。
  void app.register(oidcRoutes({ config: deps.config, db: deps.db, gate: deps.gate, runtime: oidcRuntime, limiters: { oidcLogin: limiters.oidcLogin, oidcCallback: limiters.oidcCallback } }));

  void app.register(
    notesRoutes({
      db: deps.db,
      collabHooks: deps.collabHooks,
      config: deps.config,
      limiters,
      linkSyncTestHooks: deps.linkSyncTestHooks,
      slugUpdateTestHook: deps.slugUpdateTestHook,
      uploadsDir: deps.uploadsDir,
    })
  );
  void app.register(adminUsersRoutes({ db: deps.db, gate: deps.gate, collabHooks: deps.collabHooks }));
  void app.register(adminAiRoutes({ db: deps.db, config: deps.config, runtime: deps.ai }));
  void app.register(
    aiRoutes({ db: deps.db, config: deps.config, runtime: deps.ai, limiters: { ai: limiters.ai }, idleTimeoutMs: options.aiIdleTimeoutMs })
  );
  // `NotesRouteDeps.limiters` 的型別只列它實際用到的鍵（`collabToken`/`slugPatch`，
  // #72 起含 `publicLink`；見該 interface 說明）——這裡傳整包 `limiters`（含
  // `upload`）給它，屬於變數（非物件
  // 字面值）賦值給較窄的結構型別，TS 不做 excess property check，不需要另外
  // pick／窄化。`uploadsRoutes` 自己的 deps 只挑 `upload` 這一個節流器。
  void app.register(uploadsRoutes({ db: deps.db, config: deps.config, limiters: { upload: limiters.upload }, uploadsDir: deps.uploadsDir }));
  // #72 公開端點（免登入）：三步節流順序與 404 同形見 routes/public.ts 檔頭。
  void app.register(publicRoutes({ db: deps.db, uploadsDir: deps.uploadsDir, limiters: { publicMiss: limiters.publicMiss, publicNote: limiters.publicNote, publicUpload: limiters.publicUpload } }));
  // #107：/api/mcp 的 #108 前暫時形——沒有它，MCP client 的第一發會拿到不帶 challenge
  // 的 404，無從發現授權伺服器（見 routes/mcp.ts 檔頭）。
  void app.register(mcpRoutes());

  // #132：兩個 RFC 形 plugin 各自帶 prefix（root notFound 由 spa.ts 獨佔）。
  void app.register(
    oauthRoutes({
      db: deps.db,
      config: deps.config,
      limiters: { dcr: limiters.dcr, authorize: limiters.authorize, tokenEndpoint: limiters.tokenEndpoint },
    }),
    { prefix: "/oauth" }
  );
  void app.register(oauthMetadataRoutes({ config: deps.config }), { prefix: "/.well-known" });

  // 共編的 WebSocket 掛在底層 http server 的 upgrade 事件上，不經 Fastify 路由——
  // 因此與上面的路由註冊順序無關，也不會被 setNotFoundHandler／SPA fallback 攔到。
  deps.collab?.attach(app);

  // 擴充既有的 setNotFoundHandler（不是另開路由）：webDist 未傳時完全等同原本的
  // 純 JSON 404；傳入時額外處理 SPA fallback（見 registerSpaFallback 內的完整說明）。
  registerSpaFallback(app, options.webDist);

  // 4xx 不可吞成 500：fastify 內建錯誤（如壞 JSON body 的 FST_ERR_CTP_INVALID_JSON_BODY）
  // 帶有正確的 statusCode（400），只是訊息格式不是我們的統一格式；這裡沿用該
  // statusCode 並映射成對應的 code。只有 >=500（真正的伺服器端例外）才記錄
  // log.error 並回覆不洩漏細節的 `internal`。
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      // #107 §7：錯誤 log 若要記身分，**只記 authKind 與 tokenId**——不記 token 明文，
      // 也不記 Authorization header（`serializers.req` 本來就不印 headers）。
      request.log.error({ err: error, authKind: request.authKind, tokenId: request.tokenId }, "unhandled error");
      return sendError(reply, 500, "internal", "伺服器內部錯誤");
    }
    return sendError(reply, status, clientErrorCode(status), error.message || "請求錯誤");
  });

  return app;
}
