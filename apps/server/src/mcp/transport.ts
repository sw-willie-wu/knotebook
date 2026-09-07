/**
 * #108 §4.5：Fastify 的 `request`／`reply` 與 Web-Standard `Request`／`Response` 之間的橋。
 *
 * - `toWebRequest`：標頭正規化（Fastify 的 `IncomingHttpHeaders` 值是 `string | string[]`，
 *   `Headers` 只收字串——陣列逐值 `append`）；`Request` 需要絕對 URL，由 `PUBLIC_URL` 組。
 *   **刻意不帶 body**——body 走 `handleRequest` 的 `parsedBody`（Fastify 已經解析過一次，
 *   再讓 undici 讀一次原始串流是白工，而且串流已經被消費掉了）。⚠ 硬寫
 *   `method: "POST"`，只服務 `/api/mcp` 的 POST 路徑；函式名字是通用的，Task 3 之後
 *   若被誤用在別的 method 上會靜默錯（不是 throw，是組出一個假的 `Request`）。
 * - `sendWebResponse`：`Response` 的 status／headers／text **必須先具現成值**才能關閉 server
 *   （M1(b)）——所以本函式只收已經具現好的三樣東西，拿不到 `Response` 物件。
 *   ⚠ M1(b) **今天沒有有鑑別力的驗收**（`enableJsonResponse` ＋ 只有 POST 的形狀下 SDK
 *   沒有串流路徑），它是紀律不是事實，別在別處寫成「有測試守著」。
 */
import type { FastifyReply, FastifyRequest } from "fastify";

/** 已經具現成值的 Web `Response`。 */
export interface MaterializedResponse {
  status: number;
  headers: [string, string][];
  text: string;
}

export function toWebRequest(request: FastifyRequest, endpointUrl: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const one of value) headers.append(key, one);
    } else {
      headers.append(key, value);
    }
  }
  return new Request(endpointUrl, { method: "POST", headers });
}

export function sendWebResponse(reply: FastifyReply, res: MaterializedResponse): FastifyReply {
  reply.code(res.status);
  for (const [key, value] of res.headers) reply.header(key, value);
  return reply.send(res.text);
}
