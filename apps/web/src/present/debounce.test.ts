import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncer, UPDATE_DEBOUNCE_MS, UPDATE_MAX_WAIT_MS } from "./debounce";

describe("createDebouncer（A8：trailing 500 ms＋maxWait 2 s）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("常數照 spec：500／2000", () => {
    expect(UPDATE_DEBOUNCE_MS).toBe(500);
    expect(UPDATE_MAX_WAIT_MS).toBe(2000);
  });

  it("100 ms 內 5 次 → 最後一次後 500 ms 才跑、恰一次（spec §13.2-6）", () => {
    const fn = vi.fn();
    const debouncer = createDebouncer(fn);
    for (let i = 0; i < 5; i++) {
      debouncer.schedule();
      vi.advanceTimersByTime(20);
    }
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS - 21);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("每 100 ms 一次、持續 3 s → 2 s 內至少跑一次（maxWait）", () => {
    const fn = vi.fn();
    const debouncer = createDebouncer(fn);
    for (let elapsed = 0; elapsed < 2000; elapsed += 100) {
      debouncer.schedule();
      vi.advanceTimersByTime(100);
    }
    expect(fn).toHaveBeenCalledTimes(1);
    for (let elapsed = 0; elapsed < 1000; elapsed += 100) {
      debouncer.schedule();
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancel 之後不跑", () => {
    const fn = vi.fn();
    const debouncer = createDebouncer(fn);
    debouncer.schedule();
    debouncer.cancel();
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
  });
});
