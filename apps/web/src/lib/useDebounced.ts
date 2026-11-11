import { useEffect, useState } from "react";

/** 值停止變動 `ms` 之後才更新；初值立即生效（與 `UserEmailCombobox` 的私有版同一規則）。 */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
