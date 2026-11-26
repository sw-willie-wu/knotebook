import type { FastifyRequest } from "fastify";
import { SITE_LIMITS } from "@knotebook/shared";

const DRAIN_CAP_BYTES = SITE_LIMITS.uploadMaxBytes.max * 2;

const drainedRequests = new WeakSet<object>();

/**
 * Discards the rest of a request body, counting bytes and destroying the socket past DRAIN_CAP_BYTES: a bare
 * `request.raw.resume()` counts nothing, so a client could make us read an unbounded body. `part.file.resume()` (multipart file stream) is out of scope.
 * `resume()` is still called explicitly: after a busboy limit error `request.unpipe(bb)` calls `pause()`, pinning `flowing` to false, and a `data`
 * listener only auto-resumes when `flowing !== false`; without it nothing is ever read (the real-socket test hangs in `app.close()`).
 * After `destroy()` a client may see a socket error instead of the structured error (RST can drop an unread response); accepted, since normal
 * early returns carry small bodies. On loopback the structured 403/400 usually still arrives (the caller's sendError runs synchronously, before
 * the next `data` event can trigger destroy); the connection is then closed without keep-alive. Idempotent per `request.raw` (WeakSet) so stacked listeners don't double-count.
 */
export function drainWithCap(request: FastifyRequest, capBytes: number = DRAIN_CAP_BYTES): void {
  const raw = request.raw;
  if (drainedRequests.has(raw)) {
    return;
  }
  drainedRequests.add(raw);

  let received = 0;
  raw.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > capBytes) {
      raw.destroy();
    }
  });
  raw.resume();
}
