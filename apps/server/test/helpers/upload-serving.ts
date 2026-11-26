import { expect } from "vitest";
import type { LightMyRequestResponse } from "fastify";

export type ServeRequest = (opts?: { method?: "GET" | "HEAD"; headers?: Record<string, string> }) => Promise<LightMyRequestResponse>;

const CLASS_HEADERS = ["content-type", "content-disposition", "content-security-policy", "cache-control", "x-content-type-options", "etag", "last-modified"] as const;

function classHeaders(res: LightMyRequestResponse): Record<string, unknown> {
  return Object.fromEntries(CLASS_HEADERS.map(h => [h, res.headers[h]]));
}

/** Makes 14 requests: the Range, validator and HEAD traffic a media player sends. `bytes` is the stored file (at least 16 bytes). */
export async function expectRangeServing(request: ServeRequest, bytes: Buffer): Promise<void> {
  const size = bytes.length;
  expect(size).toBeGreaterThanOrEqual(16);

  const full = await request();
  expect(full.statusCode, full.body).toBe(200);
  expect(full.rawPayload.equals(bytes)).toBe(true);
  expect(full.headers["accept-ranges"]).toBe("bytes");
  expect(full.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
  expect(full.headers["x-content-type-options"]).toBe("nosniff");
  expect(full.headers["content-length"]).toBe(String(size));
  expect(full.headers.etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
  expect(Number.isNaN(Date.parse(String(full.headers["last-modified"])))).toBe(false);
  expect(full.headers["content-type"]).toBeDefined();
  const expected = classHeaders(full);

  const probe = await request({ headers: { range: "bytes=0-1" } });
  expect(probe.statusCode).toBe(206);
  expect(probe.headers["content-range"]).toBe(`bytes 0-1/${size}`);
  expect(probe.headers["content-length"]).toBe("2");
  expect(probe.rawPayload.equals(bytes.subarray(0, 2))).toBe(true);
  expect(classHeaders(probe)).toEqual(expected);

  const openEnded = await request({ headers: { range: "bytes=4-" } });
  expect(openEnded.statusCode).toBe(206);
  expect(openEnded.headers["content-range"]).toBe(`bytes 4-${size - 1}/${size}`);
  expect(openEnded.rawPayload.equals(bytes.subarray(4))).toBe(true);

  const suffix = await request({ headers: { range: "bytes=-10" } });
  expect(suffix.statusCode).toBe(206);
  expect(suffix.headers["content-range"]).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
  expect(suffix.headers["content-length"]).toBe("10");
  expect(suffix.rawPayload.equals(bytes.subarray(size - 10))).toBe(true);
  expect(classHeaders(suffix)).toEqual(expected);

  // RFC 9110: a suffix longer than the representation selects all of it (send alone would answer 416).
  const longSuffix = await request({ headers: { range: `bytes=-${size * 2}` } });
  expect(longSuffix.statusCode).toBe(206);
  expect(longSuffix.headers["content-range"]).toBe(`bytes 0-${size - 1}/${size}`);
  expect(longSuffix.rawPayload.equals(bytes)).toBe(true);
  expect(classHeaders(longSuffix)).toEqual(expected);

  const emptySuffix = await request({ headers: { range: "bytes=-0" } });
  expect(emptySuffix.statusCode).toBe(416);
  expect(emptySuffix.headers["content-range"]).toBe(`bytes */${size}`);

  // send merges overlapping ranges into one 206 and answers disjoint ones with the whole file (no multipart/byteranges).
  const overlapping = await request({ headers: { range: "bytes=0-5,3-9" } });
  expect(overlapping.statusCode).toBe(206);
  expect(overlapping.headers["content-range"]).toBe(`bytes 0-9/${size}`);
  expect(overlapping.rawPayload.equals(bytes.subarray(0, 10))).toBe(true);

  const disjoint = await request({ headers: { range: "bytes=0-1,10-11" } });
  expect(disjoint.statusCode).toBe(200);
  expect(disjoint.headers["content-range"]).toBeUndefined();
  expect(disjoint.rawPayload.equals(bytes)).toBe(true);

  // The 304 keeps the class headers; they match the cached response, so this is harmless.
  const notModified = await request({ headers: { "if-none-match": String(full.headers.etag) } });
  expect(notModified.statusCode).toBe(304);
  expect(notModified.rawPayload.length).toBe(0);
  expect(classHeaders(notModified)).toEqual(expected);

  const pastEnd = await request({ headers: { range: `bytes=${size}-` } });
  expect(pastEnd.statusCode).toBe(416);
  expect(pastEnd.headers["content-range"]).toBe(`bytes */${size}`);
  expect(pastEnd.headers["content-disposition"]).toBeUndefined();
  expect(pastEnd.headers["content-type"]).toBeUndefined();
  expect(pastEnd.headers["content-security-policy"]).toBeUndefined();
  expect(pastEnd.rawPayload.length).toBe(0);

  const fresh = await request({ headers: { range: "bytes=0-1", "if-range": String(full.headers.etag) } });
  expect(fresh.statusCode).toBe(206);
  expect(fresh.headers["content-range"]).toBe(`bytes 0-1/${size}`);

  const stale = await request({ headers: { range: "bytes=0-1", "if-range": 'W/"0-0"' } });
  expect(stale.statusCode).toBe(200);
  expect(stale.rawPayload.equals(bytes)).toBe(true);

  const precondition = await request({ headers: { "if-match": '"other"' } });
  expect(precondition.statusCode).toBe(412);
  expect(precondition.rawPayload.length).toBe(0);
  expect(precondition.headers["content-type"]).toBeUndefined();

  const head = await request({ method: "HEAD" });
  expect(head.statusCode).toBe(200);
  expect(head.rawPayload.length).toBe(0);
  expect(head.headers["content-length"]).toBe(String(size));
  expect(head.headers["accept-ranges"]).toBe("bytes");
  expect(classHeaders(head)).toEqual(expected);
}
