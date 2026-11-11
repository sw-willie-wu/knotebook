import { vi } from "vitest";
import { WIDE_POINTER_QUERY } from "@/lib/wide-pointer";

/**
 * `vi.stubGlobal("matchMedia")`：`WIDE_POINTER_QUERY` -> `wide`；`others(query)` 為 true 的 query -> true；其餘 false。
 * 每個 query 一組 change 監聽；`setWide(next)` 改值並同步通知 `WIDE_POINTER_QUERY` 的監聽（呼叫端自己包 act）。
 * 呼叫端 `afterEach(() => { vi.unstubAllGlobals(); })` 還原。
 */
export function mockWidePointer(wide: boolean, others?: (query: string) => boolean): { setWide(next: boolean): void; listenerCount(): number } {
  let current = wide;
  const listeners = new Map<string, Set<() => void>>();
  const listenersOf = (query: string) => {
    let set = listeners.get(query);
    if (set === undefined) {
      set = new Set();
      listeners.set(query, set);
    }
    return set;
  };
  vi.stubGlobal("matchMedia", (query: string) => {
    const set = listenersOf(query);
    return {
      get matches() {
        return query === WIDE_POINTER_QUERY ? current : (others?.(query) ?? false);
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, listener: () => void) => {
        set.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        set.delete(listener);
      },
      dispatchEvent: () => false,
    };
  });
  return {
    setWide(next: boolean) {
      current = next;
      for (const listener of [...listenersOf(WIDE_POINTER_QUERY)]) listener();
    },
    /** `WIDE_POINTER_QUERY` 目前註冊中的 change 監聽數。 */
    listenerCount() {
      return listenersOf(WIDE_POINTER_QUERY).size;
    },
  };
}
