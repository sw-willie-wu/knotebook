import { createContext, useCallback, useContext } from "react";
import { UNSAFE_NavigationContext, type Location, type NavigationType } from "react-router";

/**
 * 瀏覽器**真實**的 router location（#179）——由 `App.tsx` 的 `AppRoutes` 在兩棵 `<Routes>`
 * 之外提供。
 *
 * 為什麼需要：主樹 `<Routes location={state?.backgroundLocation ?? location}>` 會覆寫
 * `useLocation()`——設定 modal 開著時，背景頁（例如 NotePage）讀到的是**背景** location，
 * 看不到真實的 `/settings/*` 網址與它的 `state`。NotePage 的網址收斂 effect 要靠真實 entry 的
 * `state.backgroundLocation` 判斷「modal 開著」而先不動網址（換成筆記網址會直接關掉 modal），
 * 所以要讀得到真實 location。
 *
 * 不在 `AppRoutes` 底下（例如只掛 NotePage 的單元測試樹）時是 `null`＝沒有背景覆寫可言。
 *
 * 同時帶真實的 `navigationType`：帶 `location` prop 的 `<Routes>` 給子樹的 navigationType **恆為
 * "POP"**（react-router `useRoutes` 的實作），主樹裡 `useNavigationType()` 量不到真正的 PUSH／REPLACE。
 */
export const RealLocationContext = createContext<{ location: Location; navigationType: NavigationType } | null>(
  null,
);

export function useRealLocation(): Location | null {
  return useContext(RealLocationContext)?.location ?? null;
}

/** 真實的導覽類型（POP＝上一頁／下一頁）；不在 `AppRoutes` 底下時 null，呼叫端退回 `useNavigationType()`。 */
export function useRealNavigationType(): NavigationType | null {
  return useContext(RealLocationContext)?.navigationType ?? null;
}

/**
 * 讀 history **此刻**的 location key（不是這一 render 拿到的那個）。
 *
 * 為什麼需要：react-router 的 `BrowserRouter`／`MemoryRouter` 把 location 更新包在
 * `startTransition` 裡——`navigate()` 當下 history 已同步換了 entry，但 router 的 location
 * 要等 transition commit 才跟上。這段空窗裡若有別的（非 transition）更新讓頁面重 render，
 * effect 看到的是**舊** location；這時再 `navigate(…, { replace: true })` 會把剛導過去的
 * entry（例如 401 導 `/login`、側欄點了別篇）換掉。呼叫端拿它跟 render 到的 `location.key`
 * 比，不等就表示有導覽在途、先別動。
 *
 * 用到 `UNSAFE_NavigationContext`：`navigator` 的型別只露 push/replace/go，但兩種 router 給的
 * 實體都是 history 物件、有 `location` getter。拿不到（別種 router）時回 undefined，呼叫端
 * 視為「無法判斷」照常進行。
 */
export function useHistoryLocationKey(): () => string | undefined {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  return useCallback(() => (navigator as { location?: { key?: string } }).location?.key, [navigator]);
}

/** history state 裡標記「這次換網址是同一篇筆記的 canonical 收斂」的鍵（值＝換之前的 pathname）。 */
const CANONICALIZED_FROM_KEY = "knotebookCanonicalizedFrom";

/**
 * NotePage 收斂 effect 用：保留既有 state（例如 openEdits 清掉後的 null、或其他鍵），再加上
 * `canonicalizedFrom` 標記。AppShell 看到「新 entry 的標記＝上一個 pathname」就知道這不是換頁
 * （#179 改走 router navigate 之後，換網址會觸發它「pathname 變了就關抽屜」的 effect）。
 */
export function withCanonicalizedFrom(state: unknown, fromPathname: string): Record<string, unknown> {
  const base = typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};
  return { ...base, [CANONICALIZED_FROM_KEY]: fromPathname };
}

/** 讀 `withCanonicalizedFrom` 寫的標記；沒有就 undefined。 */
export function canonicalizedFrom(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const value = (state as Record<string, unknown>)[CANONICALIZED_FROM_KEY];
  return typeof value === "string" ? value : undefined;
}
