import { useCallback, useContext, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { toast } from "@/components/ui/toast";
import { BlockAnchorContext } from "@/hooks/block-anchor-context";

export interface WikilinkClickTarget {
  /** 一般點擊要去的地方（member 命中＝canonical＋錨點；清單未到＝/notes/<id>[#b-…]；公開＝/p/…[#b-…]；公開同篇＝#b-…）。 */
  href: string;
  /** null ＝公開頁的同篇錨點（公開頁不知道本篇 id）。 */
  targetNoteId: string | null;
  anchorBlockId: string;
  broken: boolean;
}

/** 一般左鍵、無修飾鍵。其餘（Ctrl／Cmd／Shift／Alt、非左鍵）一律交給瀏覽器原生行為（新分頁／新視窗）。 */
export function isPlainLeftClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** 一般點擊語意：斷鏈 toast、同篇只捲動、其他 navigate(push)。 */
export function useWikilinkActivate() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const anchors = useContext(BlockAnchorContext);
  return useCallback(
    (target: WikilinkClickTarget) => {
      if (target.broken) {
        toast({ title: t("note.wikilinkBroken") });
        return;
      }
      const samePage =
        target.targetNoteId === null ||
        (anchors.currentNoteId !== null && target.targetNoteId.toLowerCase() === anchors.currentNoteId.toLowerCase());
      if (samePage) {
        if (target.anchorBlockId !== "") {
          anchors.requestAnchor(target.anchorBlockId);
          void navigate({ search: location.search, hash: `#b-${target.anchorBlockId}` }, { replace: false });
        } else {
          anchors.scrollToTop();
        }
        return;
      }
      void navigate(target.href);
    },
    [anchors, location.search, navigate, t],
  );
}

/**
 * #269 §7.2：wikilink 點擊的**唯一**實作（member、public、公開頁同篇 `#b-` 形都用它；rev 7 起可編輯時也直接跳轉，工具列改由 hover／長按開）。
 * - **不用 `<Link>`**：同路徑同 hash 時它預設 REPLACE，上一頁回不到點擊前。
 * - **不留給原生 `<a href>` 預設行為**：fragment 導航不經 react-router，而且區塊只有 `data-id` 沒有 `id`，瀏覽器捲不到。
 * - 同篇錨點先 `requestAnchor` 再 `navigate({ search, hash }, { replace: false })`：捲動由待處理錨點驅動，不依賴 router 是否產生新 key。
 */
export function useWikilinkClick() {
  const activate = useWikilinkActivate();
  return useCallback(
    (event: MouseEvent<HTMLElement>, target: WikilinkClickTarget) => {
      if (!isPlainLeftClick(event)) return;
      event.preventDefault();
      activate(target);
    },
    [activate],
  );
}
