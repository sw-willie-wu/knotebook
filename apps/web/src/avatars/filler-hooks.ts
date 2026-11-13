import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { enqueueFill, getQuotaFailed, subscribeFiller, type FillTarget } from "./display-filler";
import { configureForClient } from "./filler-runtime";

/** 把一批待補的候選排進背景補產（同一 `(id, v)` 只會處理一次）。只給設定頁（lazy chunk）用，首包不引用。 */
export function useFillPending(targets: readonly FillTarget[]): void {
  const queryClient = useQueryClient();
  configureForClient(queryClient);
  const signature = targets.map(target => `${target.id}:${target.v}`).join(",");
  useEffect(() => {
    for (const target of signature === "" ? [] : signature.split(",")) {
      const separator = target.lastIndexOf(":");
      enqueueFill({ id: target.slice(0, separator), v: Number(target.slice(separator + 1)) });
    }
  }, [signature]);
}

/** 因空間不足補不出顯示圖的版本，key 為 `fillKey`。 */
export function useQuotaFailed(): ReadonlyMap<string, FillTarget> {
  return useSyncExternalStore(subscribeFiller, getQuotaFailed);
}
