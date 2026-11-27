import type { ErrorCode, StorageQuotaErrorDetail } from "@knotebook/shared";

/** `retryAfterMs`, `storage` and `noteId` are not constructor params: many callers depend on the constructor signature. */
export class ApiFail extends Error {
  public retryAfterMs?: number;
  /** `usedBytes`/`quotaBytes` are present only when visible to the caller; any malformed field drops the whole object. */
  public storage?: StorageQuotaErrorDetail;
  public noteId?: string;

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
  storage?: unknown;
  noteId?: unknown;
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return typeof code === "string" && typeof message === "string";
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseStorageDetail(value: unknown): StorageQuotaErrorDetail | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (!(v.incomingBytes === null || isNum(v.incomingBytes))) return undefined;
  const detail: StorageQuotaErrorDetail = { incomingBytes: v.incomingBytes };
  if ("usedBytes" in v) {
    if (!isNum(v.usedBytes)) return undefined;
    detail.usedBytes = v.usedBytes;
  }
  if ("quotaBytes" in v) {
    if (!(v.quotaBytes === null || isNum(v.quotaBytes))) return undefined;
    detail.quotaBytes = v.quotaBytes;
  }
  return detail;
}

/** Unrecognised bodies become `"internal"` so raw server content isn't surfaced. */
export function apiFailFromBody(status: number, body: unknown): ApiFail {
  if (!isApiErrorBody(body)) return new ApiFail(status, "internal", "Unexpected error response from server");
  const fail = new ApiFail(status, body.error.code, body.error.message);
  if (typeof body.retryAfterMs === "number") {
    fail.retryAfterMs = body.retryAfterMs;
  }
  if (body.error.code === "storage_quota_exceeded") {
    const storage = parseStorageDetail(body.storage);
    if (storage) fail.storage = storage;
  }
  if (body.error.code === "in_trash" && typeof body.noteId === "string") fail.noteId = body.noteId;
  return fail;
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** `Content-Type: application/json` only when there is a body: Fastify v5 answers 400 `FST_ERR_CTP_EMPTY_JSON_BODY`
 * to an empty JSON body (e.g. logout). */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  // FormData: the browser sets `multipart/form-data` with its boundary; any preset value breaks `@fastify/multipart` parsing.
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

    throw apiFailFromBody(response.status, body);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
