import { writeFileSync, unlinkSync } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import send from "@fastify/send";
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import { UPLOAD_TYPES, uploadServedName } from "@knotebook/shared";
import { sendError } from "../http/errors.js";

export const UPLOAD_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

/** Deletes `*.tmp` files older than `olderThanMs` (left behind when a restart cut an upload off); returns how many. Avatars also write short-lived `.tmp` files here, hence the age rule. */
export async function sweepUploadTemps(
  uploadsDir: string,
  opts: { olderThanMs: number; now?: number; log: Pick<FastifyBaseLogger, "warn"> },
): Promise<number> {
  const now = opts.now ?? Date.now();
  let deleted = 0;
  for (const name of await readdir(uploadsDir)) {
    if (!name.endsWith(".tmp")) continue;
    const filePath = path.join(uploadsDir, name);
    try {
      const st = await lstat(filePath);
      if (!st.isFile() || now - st.mtimeMs <= opts.olderThanMs) continue;
      await unlink(filePath);
      deleted++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      opts.log.warn({ err, file: name }, "could not delete a leftover upload temp file");
    }
  }
  return deleted;
}

/** Not `accessSync(W_OK)` (always passes as root) nor `existsSync` (exists is not writable): writing a probe is the only reliable check. */
export function assertUploadsDirWritable(uploadsDir: string): void {
  const probePath = path.join(uploadsDir, `.write-probe-${randomBytes(8).toString("hex")}`);
  try {
    writeFileSync(probePath, "");
  } catch (err) {
    throw new Error(
      `uploads 目錄不可寫（${uploadsDir}）：請確認該路徑存在、是目錄（不是檔案）、且執行 process 的使用者有寫入權限`,
      { cause: err }
    );
  }
  try {
    unlinkSync(probePath);
  } catch {
    // The probe write already proved the directory is writable; a failed cleanup doesn't change that.
  }
}

/**
 * `sandbox` puts a directly opened upload in an opaque origin with scripts off, `default-src 'none'` blocks its fetches and frames,
 * and `style-src 'unsafe-inline'` keeps inline styles working.
 */
export const UPLOAD_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

// No `sandbox`: it disables the browsers' built-in PDF viewers.
export const UPLOAD_PDF_CSP = "default-src 'none'; frame-ancestors 'none'";

const UPLOAD_CACHE_CONTROL = "private, max-age=31536000, immutable";

/** `filename` is a plain-ASCII fallback for old clients; `filename*` (RFC 5987) carries the real name. */
export function contentDisposition(kind: "inline" | "attachment", servedName: string): string {
  // Lone surrogates would make encodeURIComponent throw; format characters (RTL overrides) could disguise the extension in a save dialog.
  const name = servedName.replace(/\p{Cs}/gu, "\uFFFD").replace(/[\p{Cc}\p{Cf}]/gu, "");
  const fallback = name.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/g, "");
  // encodeURIComponent leaves these four unescaped, but they are not RFC 5987 attr-chars.
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function hasUtf8Charset(mime: string): boolean {
  return mime
    .split(";")
    .slice(1)
    .some(param => {
      const [key, value] = param.split("=").map(s => s.trim().toLowerCase());
      return key === "charset" && value?.replace(/^"|"$/g, "") === "utf-8";
    });
}

/** Any mime outside the accepted table is served as an opaque download. */
export function uploadResponseHeaders(mime: string, servedName: string): Record<string, string> {
  const essence = (mime.split(";")[0] ?? "").trim().toLowerCase();
  const base = { "x-content-type-options": "nosniff", "cache-control": UPLOAD_CACHE_CONTROL };
  const download = (contentType: string) => ({
    ...base,
    "content-type": contentType,
    "content-security-policy": UPLOAD_CSP,
    "content-disposition": contentDisposition("attachment", servedName),
  });
  switch (UPLOAD_TYPES[essence]?.category) {
    case "image":
      return { ...base, "content-type": mime, "content-security-policy": UPLOAD_CSP };
    case "audio":
    case "video":
      return { ...base, "content-type": mime, "content-security-policy": UPLOAD_CSP, "content-disposition": contentDisposition("inline", servedName) };
    case "pdf":
      return { ...base, "content-type": mime, "content-security-policy": UPLOAD_PDF_CSP, "content-disposition": contentDisposition("inline", servedName) };
    case "text":
      // Without a verified UTF-8 charset the browser would guess the encoding, so such text is only downloaded.
      if (!hasUtf8Charset(mime)) return download(mime);
      // text/plain whatever the stored text type, so the browser never renders it as markup.
      return {
        ...base,
        "content-type": "text/plain; charset=utf-8",
        "content-security-policy": UPLOAD_CSP,
        "content-disposition": contentDisposition("inline", servedName),
      };
    case "office":
      return download(mime);
    default:
      return download("application/octet-stream");
  }
}

export function setUploadResponseHeaders(reply: FastifyReply, mime: string, servedName: string): void {
  reply.headers(uploadResponseHeaders(mime, servedName));
}

/** The caller has already authorized and rate-limited the request. Error responses carry neither class headers nor send's HTML body. */
export async function sendUploadFile(
  request: FastifyRequest,
  reply: FastifyReply,
  row: { id: string; mime: string; fileName: string | null },
  uploadsDir: string,
): Promise<FastifyReply> {
  // send reads only `method` and `headers`; a copy lets onFile rewrite the Range header without touching the incoming request.
  const sendRequest = { method: request.raw.method, headers: { ...request.raw.headers } };
  // The id is the path under `root`: given the whole absolute path, send would 404 a dot segment in uploadsDir and 400 on a `%` in it.
  // Ids are lowercase UUIDs, so they need no encoding.
  const result = await send(sendRequest as unknown as Readable, row.id, {
    root: uploadsDir,
    contentType: false,
    cacheControl: false,
    acceptRanges: true,
    etag: true,
    lastModified: true,
    // Runs after stat and before send parses the range. send answers a suffix longer than the file with 416; RFC 9110 says to serve the whole file.
    onFile: (_path, stat) => {
      const range = sendRequest.headers.range;
      const suffix = typeof range === "string" ? /^\s*bytes=\s*-\s*(\d+)\s*$/.exec(range) : null;
      if (suffix !== null && Number(suffix[1]) > stat.size) sendRequest.headers.range = "bytes=0-";
    },
  });
  if (result.type === "file") {
    reply.code(result.statusCode);
    reply.headers(result.headers);
    setUploadResponseHeaders(reply, row.mime, uploadServedName(row.fileName, row.mime, row.id));
    return reply.send(result.stream);
  }
  if (result.statusCode === 416 || result.statusCode === 412) {
    const range = result.headers["Content-Range"];
    if (range !== undefined) reply.header("content-range", range);
    return reply.code(result.statusCode).send();
  }
  if (result.statusCode === 404) {
    // A row without a file (volume wiped, manual deletion) isn't user-fixable: log for ops, return the uniform 404.
    request.log.error({ uploadId: row.id }, "upload row has no file on disk");
  } else {
    request.log.error(
      { uploadId: row.id, status: result.statusCode, err: result.type === "error" ? result.metadata.error : undefined },
      "serving an upload file failed",
    );
  }
  return sendError(reply, 404, "not_found", "No file with that id.");
}

/** Shared with the DELETE-note transaction so both compute the same path. */
export function uploadFilePath(uploadsDir: string, id: string): string {
  return path.join(uploadsDir, id);
}

export interface UploadDeleteLogger {
  error(obj: unknown, msg?: string): void;
}

/** Runs after the DELETE-note commit (a rollback can't restore files). Each file has its own try/catch: a failure (ENOENT included) is only logged. A blob linked from other notes is deleted with its single owning row (those links 404, intended). */
export async function deleteUploadFiles(uploadsDir: string, ids: readonly string[], log: UploadDeleteLogger): Promise<void> {
  await Promise.all(
    ids.map(async id => {
      try {
        await unlink(uploadFilePath(uploadsDir, id));
      } catch (err) {
        log.error({ name: (err as Error).name, code: (err as NodeJS.ErrnoException).code, uploadId: id }, "刪除上傳檔案失敗（best-effort，DB 列已刪除，磁碟孤兒檔案需維運排查）");
      }
    })
  );
}
