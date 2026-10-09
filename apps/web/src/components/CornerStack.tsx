import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { History } from "@/components/ui/icons";
import { AiBubble } from "@/components/ai/AiPanel";
import { useAiSession } from "@/components/ai/AiSession";
import { useVersions } from "@/lib/versions-context";
import { cn } from "@/lib/utils";

/**
 * 右下角泡泡堆疊（spec §8.1）：由下往上 AI 泡泡、歷史泡泡（`flex-col-reverse`，DOM 順序＝由下往上）。
 * AI 泡泡不渲染時歷史泡泡自然落到最底格；兩顆都沒有就整個不渲染。
 *
 * 位置沿用 #115 AI bubble 的值：`<md` 距右下 20px、`md+` 24px（e2e `10-responsive` 量 20px）。
 * 捲動淡出（#115 的語意搬到容器）：scroll 不冒泡，掛 window 的 **capture** 監聽才收得到內文捲動容器；
 * 只在「容器內至少一顆泡泡在渲染」時掛（effect guard 與渲染守門同一組條件）。鍵盤焦點落在任一顆時強制現形。
 *
 * **互斥橋接**（必須在 `AiSessionProvider` 之下，`NoteEditor` 內）：版本面板 **false → true 的那一刻** 收合 AI；
 * AI **true → false**（`start()` 自動展開或點 AI 泡泡）的那一刻關版本面板——預覽不關（由橫幅 ✕ 關）。
 * 兩邊都用 ref 存前值做邊緣觸發：用位準（「面板開著就收合 AI」）會讓 AI 一展開就被立刻收回，兩邊互踢。
 */
export function CornerStack() {
  const { t } = useTranslation();
  const ai = useAiSession();
  const versions = useVersions();

  const prevPanelOpen = useRef(versions.panelOpen);
  useEffect(() => {
    if (versions.panelOpen && !prevPanelOpen.current) ai.setCollapsed(true);
    prevPanelOpen.current = versions.panelOpen;
  }, [versions.panelOpen, ai]);

  const prevCollapsed = useRef(ai.collapsed);
  useEffect(() => {
    if (!ai.collapsed && prevCollapsed.current) versions.close();
    prevCollapsed.current = ai.collapsed;
  }, [ai.collapsed, versions]);

  const aiAvailable = ai.editable && ai.actions.length > 0;
  const showAi = ai.collapsed && aiAvailable;
  const showVersions = versions.enabled && !versions.panelOpen;
  const anyBubble = showAi || showVersions;
  // 起草裁定 22（gate r1 I-4，待 Willie 確認、需回寫 spec §8.1）：md+ 任一第三欄面板展開時整個容器讓到面板外側，
  // 泡泡不蓋面板（底部「套用 vN」在右下）。right＝20rem（面板 md:w-80）＋0.75rem（AppShell 根層 p-3：面板右緣距視窗）
  // ＋1.5rem（泡泡與面板左緣的間距，沿用原本 md:right-6 的 24px）＝22.25rem。幾何：泡泡右緣距面板左緣 24px，泡泡壓進內文卡右側
  // 12px（根 row gap-3 只有 12px）——與今天 right-6 時泡泡壓進卡內 12px 相同（gate r2 N-1 的實算）。
  const panelExpanded = versions.panelOpen || (!ai.collapsed && aiAvailable);

  const [scrolling, setScrolling] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!anyBubble) return;
    const handleScroll = () => {
      setScrolling(true);
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = setTimeout(() => setScrolling(false), 800);
    };
    window.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll, { capture: true });
      clearTimeout(fadeTimerRef.current);
      setScrolling(false);
    };
  }, [anyBubble]);

  if (!anyBubble) return null;

  return (
    <div
      data-testid="corner-stack"
      className={cn(
        "fixed bottom-5 right-5 z-30 flex flex-col-reverse gap-3 md:bottom-6",
        panelExpanded ? "md:right-[calc(20rem+2.25rem)]" : "md:right-6",
        "transition-opacity duration-200 focus-within:pointer-events-auto focus-within:opacity-100",
        scrolling && "pointer-events-none opacity-0",
      )}
    >
      {showAi && <AiBubble />}
      {showVersions && (
        <Button
          type="button"
          variant="brand"
          size="icon"
          data-testid="versions-bubble"
          aria-label={t("versions.bubble")}
          onClick={versions.open}
          className="h-12 w-12 rounded-full border border-border shadow-lg max-md:hidden"
        >
          <History aria-hidden="true" className="h-5 w-5" />
        </Button>
      )}
    </div>
  );
}
