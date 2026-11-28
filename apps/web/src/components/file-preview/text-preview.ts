export const TEXT_PREVIEW_BYTES = 1024 * 1024;

export interface TextPreview {
  text: string;
  truncated: boolean;
}

// Total length from "bytes 0-9/1234" or "bytes */1234"; null when unknown ("/*") or absent.
function rangeTotal(header: string | null): number | null {
  const match = header === null ? null : /\/(\d+)\s*$/.exec(header);
  return match ? Number(match[1]) : null;
}

/** Exactly the server's inline text class: anything else is a download (Office, PDF, or text that isn't UTF-8). */
function isInlineUtf8Text(contentType: string | null): boolean {
  if (contentType === null) return false;
  const [essence, ...params] = contentType.split(";").map(s => s.trim().toLowerCase());
  return essence === "text/plain" && params.some(p => p.replace(/\s/g, "") === "charset=utf-8");
}

async function readAtMost(res: Response, limit: number): Promise<{ bytes: Uint8Array; cut: boolean }> {
  if (res.body === null) {
    const all = new Uint8Array(await res.arrayBuffer());
    return { bytes: all.subarray(0, limit), cut: all.length > limit };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= limit) {
      // Exactly at the limit, only one more read tells whether anything follows (a chunked body has no length to compare).
      cut = size > limit || !(await reader.read()).done;
      // A server or proxy that ignored the range would otherwise send the whole file.
      void reader.cancel().catch(() => undefined);
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(size, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.length;
    if (offset === bytes.length) break;
  }
  return { bytes, cut };
}

export async function loadTextPreview(url: string, signal?: AbortSignal): Promise<TextPreview> {
  const res = await fetch(url, { headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` }, credentials: "same-origin", signal });
  // A range on an empty file can't be satisfied.
  if (res.status === 416 && rangeTotal(res.headers.get("content-range")) === 0) return { text: "", truncated: false };
  if ((res.status !== 200 && res.status !== 206) || !isInlineUtf8Text(res.headers.get("content-type"))) {
    throw new Error(`text preview: HTTP ${res.status}`);
  }
  const total = res.status === 206 ? rangeTotal(res.headers.get("content-range")) : Number(res.headers.get("content-length") ?? NaN);
  const { bytes, cut } = await readAtMost(res, TEXT_PREVIEW_BYTES);
  const truncated = cut || (total !== null && total > TEXT_PREVIEW_BYTES);
  // `stream` holds back a character split at the cut instead of decoding it as U+FFFD.
  const text = new TextDecoder("utf-8").decode(bytes, { stream: truncated });
  return { text, truncated };
}
