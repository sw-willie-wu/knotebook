import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { MAX_UPLOAD_BYTES } from "@knotebook/shared";
import { drainWithCap } from "../../src/http/drain.js";

/**
 * `drainWithCap` 只用到 `request.raw`（`.on("data", …)` + `.resume()` + `.destroy()`）
 * ——不需要一個真的 `http.IncomingMessage`，一個掛得上 `EventEmitter` 介面的假物件
 * 即可（比照 `http/rate-limit.ts` 的純函式單元測試慣例，不需要 `buildTestApp`／DB）。
 * `.resume()` 這裡刻意也是假的（no-op mock）——這支單元測試用 `raw.emit("data", …)`
 * 直接模擬資料到達，不依賴真實 `Readable` 的 flowing/paused 狀態機（那條分支是
 * `drainWithCap` 為何要顯式呼叫 `resume()` 的理由，見 `http/drain.ts` 說明；此處只
 * 驗證計數/冪等/destroy 的邏輯，不是驗證 Node stream 的 flowing 語意本身）。
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

describe("drainWithCap（安全 backlog ③，spec §13.2）", () => {
  it("累計位元組數 <= cap（MAX_UPLOAD_BYTES * 2）：不 destroy() 底層連線", () => {
    const { request, raw } = fakeRequest();
    drainWithCap(request);

    raw.emit("data", Buffer.alloc(MAX_UPLOAD_BYTES));
    raw.emit("data", Buffer.alloc(MAX_UPLOAD_BYTES));

    expect(raw.destroy).not.toHaveBeenCalled();
  });

  it("累計位元組數 > cap：destroy() 底層連線（超限＝放棄結構化 body，明文取捨）", () => {
    const { request, raw } = fakeRequest();
    drainWithCap(request);

    raw.emit("data", Buffer.alloc(MAX_UPLOAD_BYTES));
    raw.emit("data", Buffer.alloc(MAX_UPLOAD_BYTES + 1));

    expect(raw.destroy).toHaveBeenCalledTimes(1);
  });

  it("裸位元組累計精確：剛好等於 cap 不 destroy，多 1 byte 才 destroy（`>` 不是 `>=`）", () => {
    const exact = fakeRequest();
    drainWithCap(exact.request);
    exact.raw.emit("data", Buffer.alloc(MAX_UPLOAD_BYTES * 2));
    expect(exact.raw.destroy).not.toHaveBeenCalled();

    const over = fakeRequest();
    drainWithCap(over.request);
    over.raw.emit("data", Buffer.alloc(MAX_UPLOAD_BYTES * 2 + 1));
    expect(over.raw.destroy).toHaveBeenCalledTimes(1);
  });

  it("顯式呼叫 resume()（不能只靠掛 data listener 的自動 resume——busboy unpipe() 後 flowing 會被顯式釘成 false，見 drain.ts 說明）", () => {
    const { request, raw } = fakeRequest();
    drainWithCap(request);
    expect(raw.resume).toHaveBeenCalledTimes(1);
  });

  it("冪等：同一個 request 重複呼叫只掛一個 data listener，不疊加計數", () => {
    const { request, raw } = fakeRequest();
    drainWithCap(request);
    drainWithCap(request);
    drainWithCap(request);

    expect(raw.listenerCount("data")).toBe(1);

    // 若疊了 3 個 listener，同一個 chunk 會被計 3 次，MAX_UPLOAD_BYTES 一個 chunk
    // 就會誤判成超限（3 * MAX_UPLOAD_BYTES > cap）；冪等成立則不會。
    raw.emit("data", Buffer.alloc(MAX_UPLOAD_BYTES));
    expect(raw.destroy).not.toHaveBeenCalled();
  });

  it("不同 request 各自獨立計數，互不干擾", () => {
    const a = fakeRequest();
    const b = fakeRequest();
    drainWithCap(a.request);
    drainWithCap(b.request);

    a.raw.emit("data", Buffer.alloc(MAX_UPLOAD_BYTES * 2 + 1));
    expect(a.raw.destroy).toHaveBeenCalledTimes(1);
    expect(b.raw.destroy).not.toHaveBeenCalled();
  });
});
