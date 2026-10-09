import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";
import { useCloseSidebarDrawer } from "@/lib/sidebar-drawer";
import { enterPresentationFullscreen } from "./fullscreen";
import { PRESENT_SEARCH, presentPushedState } from "./present-url";

/**
 * #229 進入簡報（spec §6.3-3）——**必須在使用者事件 handler 內同步呼叫**（requestFullscreen 只在手勢的同步段有效）。
 * - presentHere：頁首 ⋮、側欄 ⋮ 的「開著那篇」、公開頁按鈕——目前 pathname（不是 canonical，NoteMenu.tsx:99-101
 *   同理由）＋`?present`、清 hash、push，state **只放旗標**（不展開既有 state：openEdits 會重開對話框、
 *   knotebookCanonicalizedFrom 會誤導 AppShell 的抽屜判斷）。
 * - presentNote：側欄 ⋮ 的「別篇」——那篇的 canonical＋`?present`、push、無旗標（關閉時 replace 拿掉 present，
 *   落在那一篇的一般筆記頁，F2）。
 * 兩者都先關抽屜（§6.6-7；不在 AppShell 底下時是 no-op）。
 */
export function usePresentEntry(): { presentHere: () => void; presentNote: (pathname: string) => void } {
  const navigate = useNavigate();
  const location = useLocation();
  const closeDrawer = useCloseSidebarDrawer();

  const presentHere = useCallback(() => {
    closeDrawer();
    enterPresentationFullscreen();
    void navigate({ pathname: location.pathname, search: PRESENT_SEARCH, hash: "" }, { state: presentPushedState() });
  }, [closeDrawer, location.pathname, navigate]);

  const presentNote = useCallback(
    (pathname: string) => {
      closeDrawer();
      enterPresentationFullscreen();
      void navigate({ pathname, search: PRESENT_SEARCH });
    },
    [closeDrawer, navigate],
  );

  return { presentHere, presentNote };
}
