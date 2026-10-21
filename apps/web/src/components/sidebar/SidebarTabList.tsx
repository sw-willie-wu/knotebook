import { useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { SIDEBAR_TABS, useSidebarTabActions, useSidebarTabState, type SidebarTab } from "@/lib/sidebar-tab";
import { SIDEBAR_TAB_SPECS } from "@/components/sidebar/tab-specs";

export function sidebarTabId(idBase: string, tab: SidebarTab): string {
  return `${idBase}-tab-${tab}`;
}

export function sidebarPanelId(idBase: string): string {
  return `${idBase}-panel`;
}

/**
 * 側欄 tab 列（WAI-ARIA tablist，spec §5.1／§5.6）。`idBase` 由呼叫端的 `useId` 給——靜態卡與抽屜兩份
 * 實例的 id 不能撞。選中者 `tabIndex 0`、其餘 `-1`（roving）；方向鍵循環並同時切換，Home／End 到頭尾。
 */
export function SidebarTabList({ idBase }: { idBase: string }) {
  const { t } = useTranslation();
  const { tab: current } = useSidebarTabState();
  const { showTab } = useSidebarTabActions();
  const buttonRefs = useRef<Record<SidebarTab, HTMLButtonElement | null>>({
    recent: null,
    myNotes: null,
    workspace: null,
    shared: null,
  });

  function moveTo(tab: SidebarTab): void {
    showTab(tab);
    buttonRefs.current[tab]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const last = SIDEBAR_TABS.length - 1;
    let target: number;
    switch (event.key) {
      case "ArrowRight":
        target = index === last ? 0 : index + 1;
        break;
      case "ArrowLeft":
        target = index === 0 ? last : index - 1;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    moveTo(SIDEBAR_TABS[target]);
  }

  return (
    <div role="tablist" aria-label={t("sidebar.tabsLabel")} className="mx-2 mt-2 flex border-b border-border">
      {SIDEBAR_TAB_SPECS.map(({ id, labelKey, Icon }, index) => {
        const selected = id === current;
        const name = t(labelKey);
        return (
          <button
            key={id}
            ref={(node) => {
              buttonRefs.current[id] = node;
            }}
            type="button"
            role="tab"
            id={sidebarTabId(idBase, id)}
            aria-selected={selected}
            aria-controls={sidebarPanelId(idBase)}
            aria-label={name}
            title={name}
            tabIndex={selected ? 0 : -1}
            onClick={() => showTab(id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={
              selected
                ? "flex h-11 flex-1 items-center justify-center border-b-2 -mb-px transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:h-9 border-brand text-brand-on-soft"
                : "flex h-11 flex-1 items-center justify-center border-b-2 -mb-px transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:h-9 border-transparent text-muted-foreground hover:text-foreground"
            }
          >
            <Icon aria-hidden="true" className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}
