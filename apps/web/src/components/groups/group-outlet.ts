import { useOutletContext } from "react-router";
import type { GroupDto } from "@knotebook/shared";

/**
 * 群組 modal（#247 §6.0）交給四個區塊的 Outlet context：`GroupModal` 已用 `useGroups()` 解析出的那一個群組。
 * 區塊只在群組解析成功時才被渲染（載入中／錯誤／找不到三形由 `GroupModal` 自己畫在右卡），所以這裡恆有值。
 * 獨立成檔是為了讓 lazy 的 `GroupSections` 不必 import `GroupModal.tsx`（首包）。
 */
export interface GroupOutletContext {
  group: GroupDto;
}

export function useGroupOutlet(): GroupDto {
  return useOutletContext<GroupOutletContext>().group;
}
