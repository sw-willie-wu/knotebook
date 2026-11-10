import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMenuContext } from "@mantine/core";
import { useBlockNoteEditor } from "@blocknote/react";
import { pushRecentColor } from "@/lib/recent-colors";
import { applyColor } from "./apply-color";
import { CustomColorPanel } from "./CustomColorPanel";
import type { PanelRequest } from "./types";

interface ColorMenuApi {
  openPanel(req: PanelRequest): void;
  back(): void;
}

const ColorMenuContext = createContext<ColorMenuApi | null>(null);

/** 在 `ColorMenuBody` 裡面才拿得到；外面回 null。 */
export function useColorMenu(): ColorMenuApi | null {
  return useContext(ColorMenuContext);
}

/**
 * 放在顏色選單根 dropdown 裡的內容：平常顯示 children（項目列表），`openPanel` 之後整個換成自訂色面板。
 * 面板要開在根 dropdown 而不是子選單：子選單是 hover 開關，拖曳方塊或在色碼框打字時指標一移開就會關掉。
 * dropdown 關閉時本元件跟著卸載，下次開選單一定回到項目列表。
 */
export function ColorMenuBody({ children }: { children: ReactNode }) {
  const editor = useBlockNoteEditor();
  const menu = useMenuContext();
  const [view, setView] = useState<"items" | PanelRequest>("items");
  const panelRef = useRef<HTMLDivElement>(null);
  // 返回後要聚焦的項目：記下 dropdown 節點與 `data-kb-color-return` 的值，等項目列表掛回來再找
  const pendingReturn = useRef<{ dropdown: Element | null; key: string } | null>(null);

  const api = useMemo<ColorMenuApi>(
    () => ({
      openPanel: (req) => setView(req),
      back: () => {
        if (view === "items") return;
        pendingReturn.current = {
          dropdown: panelRef.current?.closest("[data-menu-dropdown]") ?? null,
          key: view.returnTo,
        };
        setView("items");
      },
    }),
    [view],
  );

  useLayoutEffect(() => {
    const pending = pendingReturn.current;
    if (view !== "items" || !pending) return;
    pendingReturn.current = null;
    pending.dropdown?.querySelector<HTMLElement>(`[data-kb-color-return="${pending.key}"]`)?.focus();
  }, [view]);

  const onApply = (req: PanelRequest, hex: string) => {
    if (applyColor(editor, req.section, req.target, hex)) pushRecentColor(hex);
    // 面板裡是一般 <button>，不會像 Menu.Item 那樣自己關選單
    menu.closeDropdownImmediately();
    // 等選單關掉、focus trap 放手後再把焦點還給編輯器
    setTimeout(() => editor.focus());
  };

  return (
    <ColorMenuContext.Provider value={api}>
      {view === "items" ? (
        children
      ) : (
        <CustomColorPanel ref={panelRef} request={view} onBack={api.back} onApply={(hex) => onApply(view, hex)} />
      )}
    </ColorMenuContext.Provider>
  );
}
