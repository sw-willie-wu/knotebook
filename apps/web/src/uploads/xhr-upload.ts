import type { UploadResponseDto } from "@knotebook/shared";
import { ApiFail, apiFailFromBody } from "@/api/client";

export interface XhrUploadOptions {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

/** XHR rather than fetch: fetch exposes no upload progress. */
export function xhrUpload(path: string, form: FormData, opts: XhrUploadOptions = {}): Promise<UploadResponseDto> {
  const { onProgress, signal } = opts;
  return new Promise<UploadResponseDto>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload aborted", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const onSignalAbort = () => xhr.abort();
    const done = () => signal?.removeEventListener("abort", onSignalAbort);

    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.responseType = "text";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      done();
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300 && typeof body === "object" && body !== null) {
        resolve(body as UploadResponseDto);
        return;
      }
      reject(apiFailFromBody(xhr.status, body));
    };
    // A refusal sent while the body is still uploading is often lost by the browser and surfaces here too.
    const interrupted = () => {
      done();
      reject(new ApiFail(0, "upload_interrupted", "Upload interrupted"));
    };
    xhr.onerror = interrupted;
    xhr.ontimeout = interrupted;
    xhr.onabort = () => {
      done();
      reject(new DOMException("Upload aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onSignalAbort, { once: true });
    xhr.send(form);
  });
}
