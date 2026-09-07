/**
 * #108：`/api/mcp` 整合測試共用的請求 helper。
 *
 * 這個檔案存在的理由只有兩個，兩個都是「不集中就會空轉半天」的雷：
 *
 * 1. **`Accept` 只有一份真相**（規格 §14.1 開頭紀律）。SDK 的 transport 要求 `Accept`
 *    同時含 `application/json` 與 `text/event-stream`；少了它——包括完全不帶、只帶
 *    `application/json`、以及只帶通配符（星號／星號）——一律 `406`，通配符不算數，
 *    而且錯誤訊息與被測行為完全無關。
 * 2. **`origin` 一旦給了就必須連 `host` 一起給**（plan P4）。`app.inject` 的預設 Host 是
 *    `localhost:80`，而 `testConfig.PUBLIC_URL` 是 `http://localhost:3000`——只設 `origin`
 *    的測試會恆得 403（落在案 7b 那一格），症狀同樣與被測行為無關。
 */
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { SESSION_COOKIE } from "@knotebook/shared";

/** transport 唯一收得下的 `Accept`（通配符不算數）。 */
export const MCP_ACCEPT = "application/json, text/event-stream";

/** `testConfig.PUBLIC_URL` 的 host——帶 `Origin` 的正向案要用它當 `host`。 */
export const PUBLIC_HOST = "localhost:3000";

export interface McpRequestOpts {
  /** PAT 明文；不給就不帶 `Authorization`（＝走未認證那一側）。 */
  token?: string;
  /** session cookie 值。 */
  cookie?: string;
  /** `null` ＝ 完全不帶 `Accept`；不傳 ＝ 帶 {@link MCP_ACCEPT}。 */
  accept?: string | null;
  /** `null` ＝ 完全不帶 `Content-Type`；不傳 ＝ `application/json`。 */
  contentType?: string | null;
  /** 帶 `Origin` 時**務必**一起給 `host`（見檔頭第 2 點）。 */
  origin?: string;
  host?: string;
  /** 原樣送出的 body 字串（壞 JSON／空 body 兩案用），優先於 `body`。 */
  raw?: string;
}

function buildHeaders(opts: McpRequestOpts, withContentType: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  const accept = opts.accept === undefined ? MCP_ACCEPT : opts.accept;
  if (accept !== null) headers.accept = accept;
  if (withContentType) {
    const contentType = opts.contentType === undefined ? "application/json" : opts.contentType;
    if (contentType !== null) headers["content-type"] = contentType;
  }
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.host !== undefined) headers.host = opts.host;
  return headers;
}

/**
 * `POST /api/mcp`。`body` 為 `undefined` 且沒給 `raw` ＝**完全不送 body**（P1 的變體 (i)）。
 * body 一律由這裡序列化，不交給 `inject` 自動處理——否則它會擅自補 `content-type`。
 */
export function mcpPost(app: FastifyInstance, body: unknown, opts: McpRequestOpts = {}): Promise<LightMyRequestResponse> {
  const payload = opts.raw !== undefined ? opts.raw : body === undefined ? undefined : JSON.stringify(body);
  const inject: InjectOptions = {
    method: "POST",
    url: "/api/mcp",
    headers: buildHeaders(opts, true),
    ...(payload === undefined ? {} : { payload }),
    ...(opts.cookie === undefined ? {} : { cookies: { [SESSION_COOKIE]: opts.cookie } }),
  };
  return app.inject(inject);
}

/** `GET`／`DELETE /api/mcp`（兩者都不帶 body，所以不帶 `Content-Type`）。 */
export function mcpRequest(
  app: FastifyInstance,
  method: "GET" | "DELETE",
  opts: McpRequestOpts = {}
): Promise<LightMyRequestResponse> {
  const inject: InjectOptions = {
    method,
    url: "/api/mcp",
    headers: buildHeaders(opts, false),
    ...(opts.cookie === undefined ? {} : { cookies: { [SESSION_COOKIE]: opts.cookie } }),
  };
  return app.inject(inject);
}

/** JSON-RPC 請求信封。 */
export const rpc = (method: string, params?: unknown, id: number | string = 1): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

/** 每個 MCP session 的第一發。`protocolVersion` 用 SDK 支援的最新版。 */
export const INITIALIZE = rpc("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "plan-test", version: "0" },
});
