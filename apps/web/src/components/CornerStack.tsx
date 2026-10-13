import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { History } from "@/components/ui/icons";
import { useIsNarrow, useVersions } from "@/lib/versions-context";
import { cn } from "@/lib/utils";

/**
 * 右下角泡泡容器（spec 2026-10-09 §8.1）。#263 起 AI 泡泡拿掉（改由框選 AI 框處理），容器裡只剩歷史泡泡；容器留著，因為定位與捲動淡出都掛在它上面。
 *
 * 位置沿用 #115 的值：`<md` 距右下 20px、`md+` 24px。捲動淡出：scroll 不冒泡，掛 window 的 **capture** 監聽才收得到內文捲動容器；
 * 只在泡泡渲染時掛（effect guard 與渲染守門同一個條件）。鍵盤焦點落在泡泡上時強制現形。
 * 版本面板開著時泡泡不渲染，所以不再需要「讓到面板外側」的位移 class（那是 AI 泡泡與面板並存時才用得到）。
 */
export function CornerStack() {
  const { t } = useTranslation();
  const versions = useVersions();
  const narrow = useIsNarrow();
  // 窄視窗沒有泡泡；與 ⋮ 的「版本歷史」項讀同一個 `useIsNarrow()`，同一寬度恰好一個入口。
  const showVersions = versions.enabled && !versions.panelOpen && !narrow;

  const [scrolling, setScrolling] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!showVersions) return;
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
  }, [showVersions]);

  if (!showVersions) return null;

  return (
    <div
      data-testid="corner-stack"
      className={cn(
        "fixed bottom-5 right-5 z-30 flex flex-col-reverse gap-3 md:bottom-6 md:right-6",
        "transition-opacity duration-200 focus-within:pointer-events-auto focus-within:opacity-100",
        scrolling && "pointer-events-none opacity-0",
      )}
    >
      <Button
        type="button"
        variant="brand"
        size="icon"
        data-testid="versions-bubble"
        aria-label={t("versions.bubble")}
        onClick={versions.open}
        className="h-12 w-12 rounded-full border border-border shadow-lg"
      >
        <History aria-hidden="true" className="h-5 w-5" />
      </Button>
    </div>
  );
}
