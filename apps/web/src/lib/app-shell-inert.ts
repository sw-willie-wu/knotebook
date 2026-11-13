import { createContext, useContext, useLayoutEffect } from "react";

/**
 * 筆記頁交給外層側欄殼（`AppShellLayout`）的開關：簡報模式時整個殼不可互動。
 * 沒有 provider（單獨渲染頁面的測試、殼之外的頁面）＝no-op。
 */
export const AppShellInertContext = createContext<((inert: boolean) => void) | null>(null);

/** 依 `inert` 設定外層殼的 inert；卸載（離開這一頁）時一律清掉，不留在下一頁。 */
export function useAppShellInert(inert: boolean): void {
  const setInert = useContext(AppShellInertContext);
  useLayoutEffect(() => {
    if (setInert === null) return;
    setInert(inert);
    return () => setInert(false);
  }, [setInert, inert]);
}
