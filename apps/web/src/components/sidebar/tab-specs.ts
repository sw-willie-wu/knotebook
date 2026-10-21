import type { ReactElement, SVGProps } from "react";
import { Clock, Share, User, Users } from "@/components/ui/icons";
import { SIDEBAR_TABS, type SidebarTab } from "@/lib/sidebar-tab";

/** 標題列動作是插槽（spec §9-3）：tab 宣告要哪些動作，NoteList 的標題列照 id 渲染；步驟 2、3 往這裡加。 */
export type HeaderActionId = "newPersonalNote" | "newGroup";

export interface SidebarTabSpec {
  id: SidebarTab;
  labelKey: "sidebar.recent" | "sidebar.myNotes" | "sidebar.workspace" | "sidebar.shared";
  Icon: (props: SVGProps<SVGSVGElement>) => ReactElement;
  actions: readonly HeaderActionId[];
}

// 以 Record 逐 tab 宣告（少一個 tab 編譯不過），順序由 `SIDEBAR_TABS` 單一決定——不另寫第二份順序。
const SPEC_BY_ID: Record<SidebarTab, SidebarTabSpec> = {
  recent: { id: "recent", labelKey: "sidebar.recent", Icon: Clock, actions: [] },
  myNotes: { id: "myNotes", labelKey: "sidebar.myNotes", Icon: User, actions: ["newPersonalNote"] },
  workspace: { id: "workspace", labelKey: "sidebar.workspace", Icon: Users, actions: ["newGroup"] },
  shared: { id: "shared", labelKey: "sidebar.shared", Icon: Share, actions: [] },
};

export const SIDEBAR_TAB_SPECS: readonly SidebarTabSpec[] = SIDEBAR_TABS.map((id) => SPEC_BY_ID[id]);

export function tabSpec(tab: SidebarTab): SidebarTabSpec {
  return SPEC_BY_ID[tab];
}
