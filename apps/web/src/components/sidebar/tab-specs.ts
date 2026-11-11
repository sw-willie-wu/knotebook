import type { ReactElement, SVGProps } from "react";
import { Clock, Share, Star, Trash, User, Users } from "@/components/ui/icons";
import { SIDEBAR_TABS, type SidebarTab } from "@/lib/sidebar-tab";

/**
 * 標題列動作是插槽：tab 宣告要哪些動作，NoteList 的標題列照 id 渲染。
 * 最愛 tab 目前不宣告動作（沒有選取、新增）；其餘五個都宣告 `selectMode`：垃圾桶由 `TrashPanel` 渲染，其餘由 `NoteList`。
 * `emptyTrash` 只有垃圾桶。
 */
export type HeaderActionId = "newPersonalNote" | "newGroup" | "newFolder" | "selectMode" | "emptyTrash";

export interface SidebarTabSpec {
  id: SidebarTab;
  labelKey: "sidebar.recent" | "sidebar.favorites" | "sidebar.myNotes" | "sidebar.workspace" | "sidebar.shared" | "sidebar.trash";
  Icon: (props: SVGProps<SVGSVGElement>) => ReactElement;
  actions: readonly HeaderActionId[];
}

// 以 Record 逐 tab 宣告（少一個 tab 編譯不過），順序由 `SIDEBAR_TABS` 單一決定——不另寫第二份順序。
const SPEC_BY_ID: Record<SidebarTab, SidebarTabSpec> = {
  recent: { id: "recent", labelKey: "sidebar.recent", Icon: Clock, actions: ["selectMode"] },
  favorites: { id: "favorites", labelKey: "sidebar.favorites", Icon: Star, actions: [] },
  // 資料夾：選取、新增資料夾、新增個人筆記（稿 `Personal`）。
  myNotes: { id: "myNotes", labelKey: "sidebar.myNotes", Icon: User, actions: ["selectMode", "newFolder", "newPersonalNote"] },
  workspace: { id: "workspace", labelKey: "sidebar.workspace", Icon: Users, actions: ["selectMode", "newGroup"] },
  // 資料夾：選取、新增資料夾（建在與我共享空間的根層）。
  shared: { id: "shared", labelKey: "sidebar.shared", Icon: Share, actions: ["selectMode", "newFolder"] },
  trash: { id: "trash", labelKey: "sidebar.trash", Icon: Trash, actions: ["selectMode", "emptyTrash"] },
};

export const SIDEBAR_TAB_SPECS: readonly SidebarTabSpec[] = SIDEBAR_TABS.map((id) => SPEC_BY_ID[id]);

export function tabSpec(tab: SidebarTab): SidebarTabSpec {
  return SPEC_BY_ID[tab];
}
