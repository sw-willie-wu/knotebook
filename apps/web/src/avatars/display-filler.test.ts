import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFail } from "@/api/client";
import { syncFillerUser } from "./filler-user";
import {
  clearFillerState,
  configureFiller,
  dropQueuedFill,
  enqueueFill,
  fillKey,
  getQuotaFailed,
  notifyAvatarWritten,
  registerCropOpen,
  resetFiller,
  type EncodeModule,
  type FillerDeps,
} from "./display-filler";

const A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const B = "1a2b3c4d-d9cb-469f-a165-70867728950f";

interface Harness {
  deps: FillerDeps;
  fetchOriginal: ReturnType<typeof vi.fn>;
  putDisplay: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
  loadEncode: ReturnType<typeof vi.fn>;
  bitmapClosed: ReturnType<typeof vi.fn>;
}

function harness(over: Partial<FillerDeps> = {}): Harness {
  const bitmapClosed = vi.fn();
  const encode: EncodeModule = {
    decodeImage: async () => ({ width: 600, height: 400, close: bitmapClosed }) as unknown as ImageBitmap,
    renderDisplay: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }),
  };
  const fetchOriginal = vi.fn(async () => new Blob([new Uint8Array([9])], { type: "image/png" }));
  const putDisplay = vi.fn(async () => ({}));
  const invalidate = vi.fn();
  const loadEncode = vi.fn(async () => encode);
  const deps: FillerDeps = { fetchOriginal, putDisplay, invalidate, loadEncode, backoffMs: 20, ...over };
  configureFiller(deps);
  return { deps, fetchOriginal, putDisplay, invalidate, loadEncode, bitmapClosed };
}

const fail = (status: number, code: string) => new ApiFail(status, code, "x");
const idle = () => new Promise<void>(resolve => setTimeout(resolve, 60));

describe("display-filler", () => {
  beforeEach(() => resetFiller());
  afterEach(() => resetFiller());

  it("置中最小縮放補產：讀原圖、編碼、帶版本與裁切送回、關掉 bitmap、失效快取", async () => {
    const h = harness();
    enqueueFill({ id: A, v: 3 });
    await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
    const input = h.putDisplay.mock.calls[0]![0] as { id: string; version: number; crop: Record<string, number>; display: Blob };
    expect(input.id).toBe(A);
    expect(input.version).toBe(3);
    expect(input.crop).toEqual({ x: 100, y: 0, size: 400, width: 600, height: 400 });
    expect(input.display.type).toBe("image/webp");
    await vi.waitFor(() => expect(h.invalidate).toHaveBeenCalledTimes(1));
    expect(h.bitmapClosed).toHaveBeenCalledTimes(1);
  });

  it("同一 (id, v) 只處理一次；新版本照常處理", async () => {
    const h = harness();
    enqueueFill({ id: A, v: 1 });
    enqueueFill({ id: A, v: 1 });
    await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
    enqueueFill({ id: A, v: 1 });
    await idle();
    expect(h.putDisplay).toHaveBeenCalledTimes(1);
    enqueueFill({ id: A, v: 2 });
    await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(2));
  });

  it("失敗過的版本（500）不重試", async () => {
    const h = harness({ putDisplay: vi.fn(async () => Promise.reject(fail(500, "internal"))) });
    enqueueFill({ id: A, v: 1 });
    await vi.waitFor(() => expect(h.deps.putDisplay).toHaveBeenCalledTimes(1));
    enqueueFill({ id: A, v: 1 });
    await idle();
    expect(h.deps.putDisplay).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, "not_found"],
    [413, "payload_too_large"],
    [415, "unsupported_media_type"],
    [429, "too_many_requests"],
    [500, "internal"],
  ])("%i %s：不重試、不進配額失敗、不失效", async (status, code) => {
    const h = harness({ putDisplay: vi.fn(async () => Promise.reject(fail(status, code))) });
    enqueueFill({ id: A, v: 1 });
    await vi.waitFor(() => expect(h.deps.putDisplay).toHaveBeenCalledTimes(1));
    await idle();
    expect(h.deps.putDisplay).toHaveBeenCalledTimes(1);
    expect(getQuotaFailed().size).toBe(0);
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it("解碼失敗（非 API 錯誤）也記為失敗、不重試，且後面的照常處理", async () => {
    const decodeImage = vi
      .fn()
      .mockRejectedValueOnce(new Error("cannot decode"))
      .mockResolvedValue({ width: 10, height: 10, close: vi.fn() });
    const h = harness({
      loadEncode: async () => ({ decodeImage, renderDisplay: async () => new Blob([new Uint8Array([1])], { type: "image/webp" }) }),
    });
    enqueueFill({ id: A, v: 1 });
    enqueueFill({ id: B, v: 1 });
    await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
    expect((h.putDisplay.mock.calls[0]![0] as { id: string }).id).toBe(B);
  });

  it("一次只跑一張：第二張等第一張結束", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const h = harness({
      putDisplay: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        active -= 1;
        return {};
      }),
    });
    enqueueFill({ id: A, v: 1 });
    enqueueFill({ id: B, v: 1 });
    await vi.waitFor(() => expect(h.deps.putDisplay).toHaveBeenCalledTimes(1));
    await idle();
    expect(h.deps.putDisplay).toHaveBeenCalledTimes(1);
    expect(h.fetchOriginal).toHaveBeenCalledTimes(1);
    release?.();
    await vi.waitFor(() => expect(h.deps.putDisplay).toHaveBeenCalledTimes(2));
    expect(maxActive).toBe(1);
  });

  it("解碼編碼模組只在第一次需要時載入一次", async () => {
    const h = harness();
    expect(h.loadEncode).not.toHaveBeenCalled();
    enqueueFill({ id: A, v: 1 });
    enqueueFill({ id: B, v: 1 });
    await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(2));
    expect(h.loadEncode).toHaveBeenCalledTimes(1);
  });

  describe("裁切框互斥", () => {
    it("登記中的候選被跳過（別張照常），解除登記後處理", async () => {
      const h = harness();
      const release = registerCropOpen(A);
      enqueueFill({ id: A, v: 1 });
      enqueueFill({ id: B, v: 1 });
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
      expect((h.putDisplay.mock.calls[0]![0] as { id: string }).id).toBe(B);
      await idle();
      expect(h.putDisplay).toHaveBeenCalledTimes(1);
      release();
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(2));
      expect((h.putDisplay.mock.calls[1]![0] as { id: string }).id).toBe(A);
    });

    it("同一張登記兩次，要兩次都解除才放行", async () => {
      const h = harness();
      const first = registerCropOpen(A);
      const second = registerCropOpen(A);
      enqueueFill({ id: A, v: 1 });
      first();
      first();
      await idle();
      expect(h.putDisplay).not.toHaveBeenCalled();
      second();
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
    });
  });

  describe("server_busy", () => {
    it("退避後重試一次，成功就結束", async () => {
      const put = vi.fn().mockRejectedValueOnce(fail(409, "server_busy")).mockResolvedValue({});
      const h = harness({ putDisplay: put, backoffMs: 200 });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
      expect(h.invalidate).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(h.invalidate).toHaveBeenCalledTimes(1));
    });

    it("退避期間不卡住後面的候選", async () => {
      const put = vi.fn(async ({ id }: { id: string }) => {
        if (id === A && put.mock.calls.filter(c => (c[0] as { id: string }).id === A).length === 1) throw fail(409, "server_busy");
        return {};
      });
      harness({ putDisplay: put, backoffMs: 80 });
      enqueueFill({ id: A, v: 1 });
      enqueueFill({ id: B, v: 1 });
      await vi.waitFor(() => expect(put.mock.calls.map(c => (c[0] as { id: string }).id)).toEqual([A, B]));
    });

    it("再失敗就記為失敗，不再重試", async () => {
      const put = vi.fn(async () => Promise.reject(fail(409, "server_busy")));
      harness({ putDisplay: put });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
      await idle();
      expect(put).toHaveBeenCalledTimes(2);
      expect(getQuotaFailed().size).toBe(0);
    });

    it("重試時裁切框開著就等它關掉", async () => {
      let open: (() => void) | undefined;
      const gate = new Promise<void>(resolve => {
        open = resolve;
      });
      const put = vi
        .fn()
        .mockImplementationOnce(async () => {
          await gate;
          throw fail(409, "server_busy");
        })
        .mockResolvedValue({});
      harness({ putDisplay: put });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
      const release = registerCropOpen(A);
      open?.();
      await idle();
      expect(put).toHaveBeenCalledTimes(1);
      release();
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    });
  });

  it("avatar_outdated：失效快取、不記配額失敗、不重試同一版；新版本照常處理", async () => {
    const put = vi.fn().mockRejectedValueOnce(fail(409, "avatar_outdated")).mockResolvedValue({});
    const h = harness({ putDisplay: put });
    enqueueFill({ id: A, v: 1 });
    await vi.waitFor(() => expect(h.invalidate).toHaveBeenCalledTimes(1));
    await idle();
    expect(put).toHaveBeenCalledTimes(1);
    expect(getQuotaFailed().size).toBe(0);
    enqueueFill({ id: A, v: 2 });
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
  });

  describe("補產途中開了裁切框", () => {
    function gate() {
      let open: () => void = () => undefined;
      const promise = new Promise<void>(resolve => {
        open = resolve;
      });
      return { promise, open };
    }

    it("已在跑的那張也不送出：放回佇列，裁切框關閉後才送一次", async () => {
      const g = gate();
      const h = harness({
        fetchOriginal: vi.fn(async () => {
          await g.promise;
          return new Blob([new Uint8Array([9])], { type: "image/png" });
        }),
      });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(h.deps.fetchOriginal).toHaveBeenCalledTimes(1));
      const release = registerCropOpen(A);
      g.open();
      await idle();
      expect(h.putDisplay).not.toHaveBeenCalled();
      expect(h.invalidate).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
      await idle();
      expect(h.putDisplay).toHaveBeenCalledTimes(1);
    });
  });

  describe("avatar_outdated 不算寫入", () => {
    it("不重排配額失敗的項目（沒有任何東西被寫入）", async () => {
      const put = vi.fn(async ({ id }: { id: string }) => {
        if (id === A) throw fail(409, "storage_quota_exceeded");
        throw fail(409, "avatar_outdated");
      });
      const h = harness({ putDisplay: put });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(getQuotaFailed().size).toBe(1));
      enqueueFill({ id: B, v: 1 });
      await vi.waitFor(() => expect(h.invalidate).toHaveBeenCalledTimes(1));
      await idle();
      expect(put).toHaveBeenCalledTimes(2);
      expect(getQuotaFailed().size).toBe(1);
    });
  });

  describe("dropQueuedFill", () => {
    it("排隊中、等重試、配額失敗的項目都丟掉；別張不受影響", async () => {
      const g = gate2();
      const put = vi.fn(async ({ id }: { id: string }) => {
        if (id === "q") throw fail(409, "storage_quota_exceeded");
        if (id === "r") throw fail(409, "server_busy");
        return {};
      });
      const h = harness({
        putDisplay: put,
        backoffMs: 400,
        fetchOriginal: vi.fn(async (id: string) => {
          if (id === A) await g.promise;
          return new Blob([new Uint8Array([9])], { type: "image/png" });
        }),
      });
      enqueueFill({ id: "q", v: 1 });
      await vi.waitFor(() => expect(getQuotaFailed().size).toBe(1));
      enqueueFill({ id: "r", v: 1 });
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(h.deps.fetchOriginal).toHaveBeenCalledTimes(3));
      enqueueFill({ id: B, v: 1 }); // 排在在途的 A 後面
      dropQueuedFill("q", 1);
      dropQueuedFill("r", 1);
      dropQueuedFill(B, 1);
      expect(getQuotaFailed().size).toBe(0);
      g.open();
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(3));
      await idle();
      await idle();
      expect(put.mock.calls.map(c => (c[0] as { id: string }).id)).toEqual(["q", "r", A]);
    });

    it("丟的只有版本 ≤ v 的項目：更新的版本留著", async () => {
      const h = harness();
      const release = registerCropOpen(A); // 讓 A 的項目留在佇列裡
      enqueueFill({ id: A, v: 1 });
      enqueueFill({ id: A, v: 2 });
      enqueueFill({ id: A, v: 3 });
      dropQueuedFill(A, 2);
      release();
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
      await idle();
      expect(h.putDisplay.mock.calls.map(c => (c[0] as { version: number }).version)).toEqual([3]);
    });

    function gate2() {
      let open: () => void = () => undefined;
      const promise = new Promise<void>(resolve => {
        open = resolve;
      });
      return { promise, open };
    }
  });

  describe("逾時", () => {
    it("讀原圖卡住 → 逾時中止、記為失敗不重試，後面的照常處理", async () => {
      const signals: (AbortSignal | undefined)[] = [];
      const h = harness({
        timeoutMs: 30,
        fetchOriginal: vi.fn((id: string, signal?: AbortSignal) => {
          signals.push(signal);
          if (id === B) return Promise.resolve(new Blob([new Uint8Array([9])], { type: "image/png" }));
          return new Promise<Blob>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason));
          });
        }),
      });
      enqueueFill({ id: A, v: 1 });
      enqueueFill({ id: B, v: 1 });
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
      expect((h.putDisplay.mock.calls[0]![0] as { id: string }).id).toBe(B);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      await idle();
      expect(h.deps.fetchOriginal).toHaveBeenCalledTimes(2);
      expect(getQuotaFailed().size).toBe(0);
    });

    it("送回顯示圖也帶逾時用的 signal", async () => {
      const h = harness();
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
      expect((h.putDisplay.mock.calls[0]![0] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("clearFillerState（換使用者）", () => {
    it("清掉排隊與已處理記憶；已在跑的那張跑完後結果被丟掉", async () => {
      let open: () => void = () => undefined;
      const gateP = new Promise<void>(resolve => {
        open = resolve;
      });
      const h = harness({
        fetchOriginal: vi.fn(async (id: string) => {
          if (id === A) await gateP;
          return new Blob([new Uint8Array([9])], { type: "image/png" });
        }),
      });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(h.deps.fetchOriginal).toHaveBeenCalledTimes(1));
      enqueueFill({ id: B, v: 1 });
      clearFillerState();
      open();
      await idle();
      expect(h.invalidate).not.toHaveBeenCalled();
      expect(h.putDisplay).not.toHaveBeenCalled(); // A 在清掉之前就已經取得原圖，但送出的結果不算；B 已被清掉
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
    });
  });

  describe("換使用者時 PUT 正在途中", () => {
    it.each([
      ["storage_quota_exceeded"],
      ["server_busy"],
    ])("PUT 回 %s：不記配額失敗、不排重試、不失效", async code => {
      let reject: (err: unknown) => void = () => undefined;
      const h = harness({
        backoffMs: 20,
        putDisplay: vi.fn(
          () =>
            new Promise<unknown>((_resolve, rej) => {
              reject = rej;
            }),
        ),
      });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(h.deps.putDisplay).toHaveBeenCalledTimes(1));
      clearFillerState();
      reject(fail(409, code));
      await idle();
      await idle();
      expect(getQuotaFailed().size).toBe(0);
      expect(h.fetchOriginal).toHaveBeenCalledTimes(1);
      expect(h.deps.putDisplay).toHaveBeenCalledTimes(1);
      expect(h.invalidate).not.toHaveBeenCalled();
    });
  });

  describe("syncFillerUser", () => {
    it("換了另一位使用者才清；同一位、還沒載入（undefined）都不清", async () => {
      const h = harness();
      const release = registerCropOpen(A);
      enqueueFill({ id: A, v: 1 });
      syncFillerUser(undefined);
      syncFillerUser("u-alice");
      syncFillerUser("u-alice");
      release();
      await vi.waitFor(() => expect(h.putDisplay).toHaveBeenCalledTimes(1));
      // 換人：A 排在佇列裡、等裁切框的項目被清掉。
      const again = registerCropOpen(B);
      enqueueFill({ id: B, v: 1 });
      syncFillerUser("u-bob");
      again();
      await idle();
      expect(h.putDisplay).toHaveBeenCalledTimes(1);
    });
  });

  describe("storage_quota_exceeded", () => {
    it("記下配額失敗（以 (id, v) 為鍵）；之後任何一次頭貼寫入成功才重排", async () => {
      const put = vi.fn().mockRejectedValueOnce(fail(409, "storage_quota_exceeded")).mockResolvedValue({});
      const h = harness({ putDisplay: put });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(getQuotaFailed().has(fillKey({ id: A, v: 1 }))).toBe(true));
      await idle();
      expect(put).toHaveBeenCalledTimes(1);
      expect(h.invalidate).not.toHaveBeenCalled();
      notifyAvatarWritten();
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
      expect(getQuotaFailed().size).toBe(0);
    });

    it("訂閱者在記下與清掉時都收到通知，且快照換新物件", async () => {
      const { subscribeFiller } = await import("./display-filler");
      const put = vi.fn().mockRejectedValueOnce(fail(409, "storage_quota_exceeded")).mockResolvedValue({});
      harness({ putDisplay: put });
      const listener = vi.fn();
      const off = subscribeFiller(listener);
      const before = getQuotaFailed();
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
      expect(getQuotaFailed()).not.toBe(before);
      notifyAvatarWritten();
      expect(listener).toHaveBeenCalledTimes(2);
      off();
    });

    it("沒有配額失敗時 notifyAvatarWritten 不通知、不排任何東西", () => {
      const h = harness();
      notifyAvatarWritten();
      expect(h.fetchOriginal).not.toHaveBeenCalled();
    });

    it("補產自己成功也算一次寫入：清掉別張的配額失敗並重排", async () => {
      const put = vi
        .fn()
        .mockRejectedValueOnce(fail(409, "storage_quota_exceeded"))
        .mockResolvedValue({});
      harness({ putDisplay: put });
      enqueueFill({ id: A, v: 1 });
      await vi.waitFor(() => expect(getQuotaFailed().size).toBe(1));
      enqueueFill({ id: B, v: 1 });
      // B 成功 → A 重排 → A 成功
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(3));
      expect(put.mock.calls.map(c => (c[0] as { id: string }).id)).toEqual([A, B, A]);
    });
  });
});
