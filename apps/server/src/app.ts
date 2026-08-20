import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import { MAX_UPLOAD_BYTES, SESSION_COOKIE, type ErrorCode } from "@knotebook/shared";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/index.js";
import { verifySession, type GateUser, type UserGate } from "./auth/session.js";
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
import { oidcRoutes } from "./routes/oidc.js";
import { drainWithCap } from "./http/drain.js";
import { sendError } from "./http/errors.js";
import { AI_LIMIT, COLLAB_TOKEN_LIMIT, FixedWindowLimiter, OIDC_LIMIT, SLUG_PATCH_LIMIT, UPLOAD_LIMIT } from "./http/rate-limit.js";
import { registerSpaFallback } from "./http/spa.js";
import { assertUploadsDirWritable } from "./uploads/service.js";
import type { AiRuntime } from "./ai/runtime.js";
import { createOidcRuntime, type OidcRuntime } from "./auth/oidc-client.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
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
   */
  logger?: boolean;
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
 * **已知前提（trustProxy，非本次引入的漏洞，據實註記）**：`request.host` 在
 * `trustProxy: true` 下，若請求帶 `X-Forwarded-Host` 且來源 socket 通過 trustProxy
 * 判定（本專案設定下恆真——見 buildApp 的 `trustProxy: true`），會採信該 header 而非
 * 實際的 `Host` header（fastify `buildRequestWithTrustProxy` 的既定行為，非本函式
 * 決定）。**目前不可從瀏覽器利用**：本站無 CORS 設定，跨源請求若帶自訂 header（如
 * `X-Forwarded-Host`）會觸發 preflight，瀏覽器在收不到允許的 CORS 回應前就會擋下、
 * 不會把實際請求送達 server；`<form>` 提交（唯一免 preflight 的跨站攻擊面）無法附加
 * 自訂 header。**若日後加 CORS，或部署在允許 client 端透傳自訂 `X-Forwarded-Host` 的
 * 代理拓撲下，這個前提會失效**——見 backlog「trustProxy 可設定化」（Plan 1 遺留項）。
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
export function buildApp(deps: AppDeps, options: BuildAppOptions = {}): FastifyInstance {
  // Task 9：uploads 目錄可寫性探測放在最前面、任何 Fastify 初始化之前——這是一個
  // 獨立於 HTTP 框架的環境前置條件（同 index.ts 的 migration fail-fast 精神），
  // 失敗就不該繼續往下建 app。
  assertUploadsDirWritable(deps.uploadsDir);

  // maxParamLength 預設 100：find-my-way 是量「解碼後」的 UTF-16 code unit 數，跟
  // `titleSlug`／`validateSlug` 量的是 code point 數（60／100）不是同一把尺——
  // astral 字元（例如 𠮷）解碼後是 2 個 UTF-16 unit，60 個 astral 字算下來就破百，
  // 會讓 `canonicalNotePath` 組出的 `<vanity>-<uuid>` ref 在路由層直接被 find-my-way
  // 拒絕（414 URI Too Long，連 handler 都不會被呼叫，見 notes-slug.test.ts 的 astral
  // 標題 regression test 實測）。512 給足與 slug 上限的落差當緩衝，不必跟著 slug 規則
  // 同步微調。必須放進 `routerOptions`，不能當 Fastify 建構子的頂層選項——頂層
  // `maxParamLength` 是 deprecated 寫法（FSTDEP022），fastify@6 會整個移除，屆時會
  // 靜默退回預設值 100，等於這個修正自己失效又不出任何警告；`routerOptions` 這個
  // 寫法才是不會過期、也不會印 deprecation warning 的形式。
  const app = Fastify({ logger: options.logger ?? true, trustProxy: true, routerOptions: { maxParamLength: 512 } });

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

  // 以下兩個 decorator 都以一般具名函式（而非箭頭函式綁 this）宣告，但內部完全不用
  // `this`——`requireAdmin` 呼叫 `authenticate` 是透過閉包捕捉的外層 `app` 變數，
  // 不依賴 fastify 呼叫時的 this 綁定，故用 `app.authenticate(...)`／
  // `app.requireAdmin(...)`（或當作 preHandler 傳給其他路由）皆可正確運作。
  app.decorate("authenticate", async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies[SESSION_COOKIE];
    const session = token ? await verifySession(deps.config.appSecret, token) : null;
    if (!session) {
      sendError(reply, 401, "unauthorized", "未登入");
      return;
    }
    const result = await deps.gate.check(session.userId, session.tv);
    if (result.status !== "ok") {
      sendError(reply, 401, "unauthorized", "未登入");
      return;
    }
    request.user = result.user;
    request.sessionTv = session.tv;
  });

  app.decorate("requireAdmin", async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (!request.user?.isAdmin) {
      sendError(reply, 403, "forbidden", "需要管理員權限");
    }
  });

  app.get("/healthz", async () => ({ ok: true }));

  void app.register(
    authRoutes({ db: deps.db, config: deps.config, gate: deps.gate, throttle: deps.throttle, collabHooks: deps.collabHooks })
  );
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
    } satisfies NonNullable<AppDeps["limiters"]>);

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
      uploadsDir: deps.uploadsDir,
    })
  );
  void app.register(adminUsersRoutes({ db: deps.db, gate: deps.gate, collabHooks: deps.collabHooks }));
  void app.register(adminAiRoutes({ db: deps.db, config: deps.config, runtime: deps.ai }));
  void app.register(
    aiRoutes({ db: deps.db, config: deps.config, runtime: deps.ai, limiters: { ai: limiters.ai }, idleTimeoutMs: options.aiIdleTimeoutMs })
  );
  // `NotesRouteDeps.limiters` 的型別只列 `collabToken`/`slugPatch`（刻意不改，見該
  // interface 說明）——這裡傳整包 `limiters`（含 `upload`）給它，屬於變數（非物件
  // 字面值）賦值給較窄的結構型別，TS 不做 excess property check，不需要另外
  // pick／窄化。`uploadsRoutes` 自己的 deps 只挑 `upload` 這一個節流器。
  void app.register(uploadsRoutes({ db: deps.db, config: deps.config, limiters: { upload: limiters.upload }, uploadsDir: deps.uploadsDir }));

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
      request.log.error(error);
      return sendError(reply, 500, "internal", "伺服器內部錯誤");
    }
    return sendError(reply, status, clientErrorCode(status), error.message || "請求錯誤");
  });

  return app;
}
