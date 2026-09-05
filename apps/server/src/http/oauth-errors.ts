import type { FastifyReply } from "fastify";

/**
 * #132：`/oauth/*` 與 `/.well-known/*` 的 RFC 6749 §5.2 錯誤形，全站唯一例外
 * （其餘路由是 `{error:{code,message}}`）。葉節點模組，避免 app.ts ↔ routes 循環。
 */
export function sendOauthError(
  reply: FastifyReply,
  statusCode: number,
  error: string,
  description: string
): FastifyReply {
  return reply
    .code(statusCode)
    .header("cache-control", "no-store")
    .header("pragma", "no-cache")
    .send({ error, error_description: description });
}

/**
 * pathname 是否落在兩個 RFC 形 plugin 的前綴下（裸路徑也算）。用 URL 前綴判定而非
 * `routeOptions.url`——後者在未匹配路由上是 undefined。
 *
 * ⚠ 這兩個前綴同時也在 shared 的 `EXCLUDED_PREFIXES` 裡，加第三個時**兩邊都要改**。
 */
export function isOauthScopedPath(pathname: string): boolean {
  for (const prefix of ["/oauth", "/.well-known"]) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/** 要求 `application/x-www-form-urlencoded` 而非 JSON 的路由（`routeOptions.url` 含 prefix）。 */
export const FORM_EXEMPT_ROUTES: ReadonlySet<string> = new Set(["POST /oauth/token"]);
