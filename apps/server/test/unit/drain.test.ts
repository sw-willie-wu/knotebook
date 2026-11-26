import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { MAX_UPLOAD_BYTES } from "@knotebook/shared";
import { drainWithCap } from "../../src/http/drain.js";

/**
 * `drainWithCap` only uses `request.raw` (`.on("data", ...)` + `.resume()` + `.destroy()`), so a fake object with an `EventEmitter` interface
 * is enough instead of a real `http.IncomingMessage` (same convention as the pure-function unit tests of `http/rate-limit.ts`; no
 * `buildTestApp`/DB). `.resume()` is deliberately a no-op mock: `raw.emit("data", ...)` simulates data arrival without depending on a real
 * `Readable`'s flowing/paused state machine (that is why `drainWithCap` must call `resume()` explicitly, see `http/drain.ts`); this test
 * only checks counting, idempotency and destroy.
 */
function fakeRequest(): {
  request: FastifyRequest;
  raw: EventEmitter & { destroy: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> };
} {
  const raw = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> };
  raw.destroy = vi.fn();
  raw.resume = vi.fn();
  return { request: { raw } as unknown as FastifyRequest, raw };
}

describe("drainWithCap", () => {
  it("cumulative bytes <= cap (MAX_UPLOAD_BYTES * 2): does not destroy() the underlying connection", () => {
    const { request, raw } = fakeRequest();
    drainWithCap(request);

    raw.emit("data", Buffer.alloc(MAX_UPLOAD_BYTES));
    raw.emit("data", Buffer.alloc(MAX_UPLOAD_BYTES));

    expect(raw.destroy).not.toHaveBeenCalled();
  });

  it("cumulative bytes > cap: destroy() the underlying connection (over the limit = give up on a structured body, an explicit trade-off)", () => {
    const { request, raw } = fakeRequest();
    drainWithCap(request);

    raw.emit("data", Buffer.alloc(MAX_UPLOAD_BYTES));
    raw.emit("data", Buffer.alloc(MAX_UPLOAD_BYTES + 1));

    expect(raw.destroy).toHaveBeenCalledTimes(1);
  });

  it("exact byte accounting: exactly cap does not destroy, one more byte does (`>` not `>=`)", () => {
    const exact = fakeRequest();
    drainWithCap(exact.request);
    exact.raw.emit("data", Buffer.alloc(MAX_UPLOAD_BYTES * 2));
    expect(exact.raw.destroy).not.toHaveBeenCalled();

    const over = fakeRequest();
    drainWithCap(over.request);
    over.raw.emit("data", Buffer.alloc(MAX_UPLOAD_BYTES * 2 + 1));
    expect(over.raw.destroy).toHaveBeenCalledTimes(1);
  });

  it("calls resume() explicitly (the automatic resume from attaching a data listener is not enough: after busboy's unpipe() flowing is explicitly pinned to false, see drain.ts)", () => {
    const { request, raw } = fakeRequest();
    drainWithCap(request);
    expect(raw.resume).toHaveBeenCalledTimes(1);
  });

  it("idempotent: repeated calls on the same request attach one data listener and counts do not stack", () => {
    const { request, raw } = fakeRequest();
    drainWithCap(request);
    drainWithCap(request);
    drainWithCap(request);

    expect(raw.listenerCount("data")).toBe(1);

    // With 3 stacked listeners the same chunk would be counted 3 times and a single MAX_UPLOAD_BYTES chunk would be misjudged as over
    // the limit (3 * MAX_UPLOAD_BYTES > cap); idempotency avoids that.
    raw.emit("data", Buffer.alloc(MAX_UPLOAD_BYTES));
    expect(raw.destroy).not.toHaveBeenCalled();
  });

  it("an explicit cap replaces the default: exactly the cap does not destroy, one more byte does", () => {
    const exact = fakeRequest();
    drainWithCap(exact.request, 1000);
    exact.raw.emit("data", Buffer.alloc(1000));
    expect(exact.raw.destroy).not.toHaveBeenCalled();

    const over = fakeRequest();
    drainWithCap(over.request, 1000);
    over.raw.emit("data", Buffer.alloc(1001));
    expect(over.raw.destroy).toHaveBeenCalledTimes(1);
  });

  it("different requests are counted independently", () => {
    const a = fakeRequest();
    const b = fakeRequest();
    drainWithCap(a.request);
    drainWithCap(b.request);

    a.raw.emit("data", Buffer.alloc(MAX_UPLOAD_BYTES * 2 + 1));
    expect(a.raw.destroy).toHaveBeenCalledTimes(1);
    expect(b.raw.destroy).not.toHaveBeenCalled();
  });
});
