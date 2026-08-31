import { readFile } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { securityHeaders } from "./security-headers.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "./errors.js";

/**
 * SPA fallback 排除的路由前綴——spec §11.5：segment 邊界比對，`/x` 本身或 `/x/...`
 * 才算命中，`/collaborators` 不受 `/collab` 排除規則牽連（純字串 startsWith("/collab")
 * 會誤傷，故逐一比對 `prefix` 與 `${prefix}/`）。
 */
const EXCLUDED_PREFIXES = ["/api", "/collab", "/healthz", "/assets"];

function isExcludedPath(pathname: string): boolean {
  return EXCLUDED_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// Accept 子字串含 `text/html` 才算——萬用字元 accept（curl/fetch/app.inject 預設）不算。
function acceptsHtml(accept: string | undefined): boolean {
  return accept !== undefined && accept.includes("text/html");
}

const FALLBACK_METHODS = new Set(["GET", "HEAD"]);

/**
 * 掛 SPA 服務（spec §11.5）：`webDist` 存在時註冊 `@fastify/static`
 * `{ root: webDist, wildcard: false, index: false }`——`wildcard: false` 只為啟動當下
 * 「實際存在」的檔案建路由（例如 `/assets/app.js`），不存在的檔案／目錄完全不註冊
 * 路由，一律落入 Fastify 正常的「未命中路由」流程，最終走到下面同一個
 * `setNotFoundHandler`（`/assets/missing.js` 即是如此：不是被 fallback 攔下再拒絕，
 * 是壓根沒有路由可匹配）。`index: false` 讓 `GET /`／`GET /some/dir/` 也一律落到
 * `setNotFoundHandler`，不被外掛自動生出的 index 路由攔截，維持「index.html 一律由
 * 本函式手動讀檔回傳」單一路徑。
 *
 * 接著**擴充既有的** `setNotFoundHandler`（不是另開一條路由）：GET/HEAD 且 pathname
 * （`request.url` 去掉 query string）非 `/api`／`/collab`／`/healthz`／`/assets` 的
 * segment 前綴、且 `Accept` header 子字串含 `text/html` → 回 `index.html`（200）；其餘
 * 情況（`webDist` 未傳、其他 method、其他 Accept、被排除的前綴）一律落回既有的 JSON
 * 404——與 app.ts 原本的 `setNotFoundHandler` 行為一致，呼叫方無感知差異。
 *
 * `webDist` 是否存在的啟動檢查由呼叫方（`src/index.ts`）負責（`fs.existsSync` +
 * warn 後不傳）——本函式假設收到非 undefined 的 `webDist` 就是真實存在的目錄，
 * 不重複檢查（測試用的臨時目錄同理，由呼叫方保證存在）。
 */
export function registerSpaFallback(app: FastifyInstance, webDist: string | undefined): void {
  if (webDist !== undefined) {
    void app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      index: false,
      /**
       * ⚠ **`index.html` 一律不由 static 送**（issue #101 的 gate 審查抓到）。
       * `wildcard: false` 只是不建萬用路由，root 底下**實際存在的每個檔案**仍會各得
       * 一條路由——`index.html` 就是其中之一。於是 `GET /index.html` 會由 static 回出
       * 同一份 SPA（`App.tsx` 的 `/*` route 讓它渲染首頁，session cookie 是 lax 照送，
       * 使用者是登入狀態），卻**繞過下面那條掛安全標頭的路徑**：整份 CSP 加 11 個字元
       * 就沒了。擋掉之後它落入 `setNotFoundHandler`，與 `/`、`/notes/:ref` 同一條路。
       * 守衛：`test/spa.test.ts` 的「GET /index.html 也要有 CSP」。
       *
       * ⚠ 這裡只排除字面上的 `/index.html`，因為今天的 `apps/web/dist` 只有它一個
       * `.html`（其餘是 `assets/*.js|css`）。**dist 若哪天多出任何其他 `.html`**
       * （例如 `sub/index.html`），static 會直接把它送出去、不帶任何安全標頭——那時
       * 要把這條改成 `!pathName.endsWith(".html")` 並補守衛。
       */
      allowedPath: (pathName) => pathName !== "/index.html",
    });
  }

  app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    if (webDist !== undefined && FALLBACK_METHODS.has(request.method)) {
      const pathname = request.url.split("?")[0];
      if (!isExcludedPath(pathname) && acceptsHtml(request.headers.accept)) {
        try {
          const html = await readFile(path.join(webDist, "index.html"), "utf8");
          reply.header("content-type", "text/html; charset=utf-8");
          // issue #101：安全標頭掛在**這裡**——CSP 只對 HTML 文件有意義（`/api` 與
          // `/assets` 不需要）。標頭由**這份 html** 推導（script-src 的 hash），所以
          // 不可能與送出的內容不同步，見 `security-headers.ts` 檔頭。
          for (const [name, value] of Object.entries(securityHeaders(html))) {
            reply.header(name, value);
          }
          reply.send(html);
          return;
        } catch {
          // index.html 讀不到（理論上啟動檢查已排除這個狀況）——落回下方 JSON 404，
          // 不讓例外變成未捕捉的 500。
        }
      }
    }
    sendError(reply, 404, "not_found", "找不到此路由");
  });
}
