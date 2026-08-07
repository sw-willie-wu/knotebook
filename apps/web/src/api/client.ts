import type { ErrorCode } from "@knotebook/shared";

/**
 * 對映 server 的錯誤回應。所有非 2xx 回應最終都會化為一個 `ApiFail` 被 throw：
 * - `status`：HTTP 狀態碼。
 * - `code`：server 回的 `error.code`；body 無法辨識（非 JSON、形狀不符）時退回 `'internal'`。
 * - `message`：server 回的 `error.message`；同上退回時給通用訊息。
 * - `retryAfterMs`：僅登入 429（`too_many_attempts`）會在 body 頂層附這個欄位；
 *   有值才賦值，其餘情況維持 `undefined`。刻意不放進 constructor 參數列——
 *   這個型別是 Task 11+ 逐字依賴的介面，constructor 簽章不可變動。
 */
export class ApiFail extends Error {
  public retryAfterMs?: number;

  constructor(
    public status: number,
    public code: ErrorCode | string,
    message: string,
  ) {
    super(message);
    this.name = "ApiFail";
  }
}

interface ApiErrorBody {
  error: { code: string; message: string };
  retryAfterMs?: number;
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return typeof code === "string" && typeof message === "string";
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * 所有 API 呼叫的共用入口：
 * - 一律 `credentials: 'include'`（session cookie）。
 * - 變更請求（method 非 GET/HEAD）且**帶了 body**、呼叫端未自帶 Content-Type 時，
 *   補上 `Content-Type: application/json`。沒有 body 的變更請求（例如
 *   `POST /api/auth/logout`）刻意不補——Fastify v5 對「有 JSON Content-Type
 *   但 body 是空字串」一律回 400 `FST_ERR_CTP_EMPTY_JSON_BODY`，補了反而炸掉。
 * - 非 2xx：嘗試把 body 解成 `{error:{code,message}}` 丟 `ApiFail`；解不出來
 *   （非 JSON、形狀不符）一律退回 `code:'internal'`，不把原始錯誤內容洩露出去。
 * - 204 No Content → resolve `undefined`；其餘 2xx → 解析 JSON body 當作 `T`。
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  // `FormData` body（uploads，Task 13）：**不**補 `Content-Type`。瀏覽器的 `fetch`
  // 對 `FormData` body 會自己算出 `multipart/form-data; boundary=...` 並設定—— 若我們
  // 搶先補上不帶 boundary 的 `application/json`（或任何值），server 端的
  // `@fastify/multipart` 解析器會直接判定格式錯誤，整個上傳都收不到檔案。
  if (
    !SAFE_METHODS.has(method) &&
    init.body != null &&
    !(init.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: "include",
  });

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (isApiErrorBody(body)) {
      const fail = new ApiFail(response.status, body.error.code, body.error.message);
      if (typeof body.retryAfterMs === "number") {
        fail.retryAfterMs = body.retryAfterMs;
      }
      throw fail;
    }

    throw new ApiFail(response.status, "internal", "Unexpected error response from server");
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
