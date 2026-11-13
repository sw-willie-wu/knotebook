import { vi } from "vitest";
import { OVERLAY_QUERY, PHONE_QUERY } from "@/lib/layout-tiers";

/** `"overlay"` 只指 640-1279px 的浮動段；手機（< 640）另列 `"phone"`，兩者在 `OVERLAY_QUERY` 下都成立。 */
export type LayoutTier = "phone" | "overlay" | "docked";

/** 各段下 `PHONE_QUERY`／`OVERLAY_QUERY` 是否成立：手機兩者皆成立，浮動只有後者，固定皆不成立。 */
export function tierMatches(tier: LayoutTier, query: string): boolean {
  if (query === PHONE_QUERY) return tier === "phone";
  if (query === OVERLAY_QUERY) return tier !== "docked";
  return false;
}

/** 視窗寬度（px）落在哪一段：與 CSS 的 `sm`（640）、`xl`（1280）同界。 */
export function tierForWidth(widthPx: number): LayoutTier {
  if (widthPx < 640) return "phone";
  if (widthPx < 1280) return "overlay";
  return "docked";
}

/**
 * `vi.stubGlobal("matchMedia")`：`PHONE_QUERY`／`OVERLAY_QUERY` 依 `tier` 成立與否；`others(query)` 為 true 的 query -> true；其餘 false。
 * 每個 query 一組 change 監聽；`setLayoutTier(next)` 改段，只通知結果翻轉的 query，呼叫監聽時帶 `{ matches, media }`
 * （與真瀏覽器一致；呼叫端自己包 act）。
 * 呼叫端 `afterEach(() => { vi.unstubAllGlobals(); })` 還原。
 */
export function stubLayoutTier(
  tier: LayoutTier,
  others?: (query: string) => boolean,
): { setLayoutTier(next: LayoutTier): void; listenerCount(query: string): number } {
  let current = tier;
  type ChangeEvent = { matches: boolean; media: string };
  type Listener = (event: ChangeEvent) => void;
  const listeners = new Map<string, Set<Listener>>();
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
        return query === PHONE_QUERY || query === OVERLAY_QUERY ? tierMatches(current, query) : (others?.(query) ?? false);
      },
      media: query,
      onchange: null,
      addListener: (listener: Listener) => {
        set.add(listener);
      },
      removeListener: (listener: Listener) => {
        set.delete(listener);
      },
      addEventListener: (_type: string, listener: Listener) => {
        set.add(listener);
      },
      removeEventListener: (_type: string, listener: Listener) => {
        set.delete(listener);
      },
      dispatchEvent: () => false,
    };
  });
  return {
    setLayoutTier(next: LayoutTier) {
      const previous = current;
      current = next;
      for (const query of [PHONE_QUERY, OVERLAY_QUERY]) {
        const before = tierMatches(previous, query);
        const after = tierMatches(next, query);
        if (before === after) continue;
        for (const listener of [...listenersOf(query)]) listener({ matches: after, media: query });
      }
    },
    listenerCount(query: string) {
      return listenersOf(query).size;
    },
  };
}
