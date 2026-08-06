import { readFile } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
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
    void app.register(fastifyStatic, { root: webDist, wildcard: false, index: false });
  }

  app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    if (webDist !== undefined && FALLBACK_METHODS.has(request.method)) {
      const pathname = request.url.split("?")[0];
      if (!isExcludedPath(pathname) && acceptsHtml(request.headers.accept)) {
        try {
          const html = await readFile(path.join(webDist, "index.html"), "utf8");
          reply.header("content-type", "text/html; charset=utf-8");
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
