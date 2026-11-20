import type { ReactElement, SVGProps } from "react";
import { Clock, Share, Star, Trash, User, Users } from "@/components/ui/icons";
import { SIDEBAR_TABS, type SidebarTab } from "@/lib/sidebar-tab";

export type HeaderActionId = "tagFilter" | "newPersonalNote" | "newGroup" | "newFolder" | "selectMode" | "emptyTrash";

export interface SidebarTabSpec {
  id: SidebarTab;
  labelKey: "sidebar.recent" | "sidebar.favorites" | "sidebar.myNotes" | "sidebar.workspace" | "sidebar.shared" | "sidebar.trash";
  Icon: (props: SVGProps<SVGSVGElement>) => ReactElement;
  actions: readonly HeaderActionId[];
}

// A Record per tab (a missing tab doesn't compile); order comes only from `SIDEBAR_TABS`.
const SPEC_BY_ID: Record<SidebarTab, SidebarTabSpec> = {
  recent: { id: "recent", labelKey: "sidebar.recent", Icon: Clock, actions: ["selectMode"] },
  favorites: { id: "favorites", labelKey: "sidebar.favorites", Icon: Star, actions: ["selectMode"] },
  myNotes: { id: "myNotes", labelKey: "sidebar.myNotes", Icon: User, actions: ["tagFilter", "selectMode", "newFolder", "newPersonalNote"] },
  workspace: { id: "workspace", labelKey: "sidebar.workspace", Icon: Users, actions: ["tagFilter", "selectMode", "newGroup"] },
  shared: { id: "shared", labelKey: "sidebar.shared", Icon: Share, actions: ["selectMode", "newFolder"] },
  trash: { id: "trash", labelKey: "sidebar.trash", Icon: Trash, actions: ["selectMode", "emptyTrash"] },
};

export const SIDEBAR_TAB_SPECS: readonly SidebarTabSpec[] = SIDEBAR_TABS.map((id) => SPEC_BY_ID[id]);

export function tabSpec(tab: SidebarTab): SidebarTabSpec {
  return SPEC_BY_ID[tab];
}
