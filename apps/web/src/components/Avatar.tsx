import { useState, type CSSProperties, type ReactNode } from "react";
import { AGENT_PRESENCE_COLOR, avatarUrl, type AvatarRef } from "@knotebook/shared";
import { firstGrapheme } from "@/components/presence/people";
import { Sparkles } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export interface AvatarProps {
  name: string;
  avatar: AvatarRef | null;
  size: number;
  ringColor?: string;
  /** 外框與底之間那 1 px 分隔圈的顏色（＝頭像所在的底色）；預設卡片底色。 */
  offsetColor?: string;
  kind?: "user" | "agent";
  className?: string;
}

/**
 * AI 圖示色：淺色＝`AGENT_PRESENCE_COLOR`（Tailwind 只認完整字面，Avatar.test 守兩者一致）；
 * 深色改用較亮的紫，淡底上才夠對比（WCAG 1.4.11）。
 */
const AGENT_ICON = "text-[#7c3aed] dark:text-[#a78bfa]";

/**
 * #293：頭像（圖、首字、AI 三形）。網址只經 `avatarUrl`，prop 只收 `AvatarRef`（N-a）；
 * 外框色是執行期動態值，只能 inline。目前 `avatar` 恆 null，圖分支是預先佈線。
 */
export function Avatar({ name, avatar, size, ringColor, offsetColor = "var(--color-card)", kind = "user", className }: AvatarProps) {
  // 記住「哪一版」載入失敗：id／v 變了就自然重試，不必另用 effect 重設。
  const imgKey = avatar ? `${avatar.id}:${avatar.v}` : null;
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const showImg = kind !== "agent" && avatar !== null && imgKey !== failedKey;
  const style: CSSProperties = {
    width: size,
    height: size,
    boxShadow: ringColor ? `0 0 0 2px ${ringColor}, 0 0 0 3px ${offsetColor}` : undefined,
  };
  let content: ReactNode;
  if (kind === "agent") {
    style.backgroundColor = `color-mix(in srgb, ${AGENT_PRESENCE_COLOR} 15%, transparent)`;
    content = <Sparkles className={cn("h-[55%] w-[55%]", AGENT_ICON)} />;
  } else if (showImg) {
    content = (
      <img
        src={avatarUrl(avatar.id, avatar.v)}
        alt=""
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover"
        onError={() => setFailedKey(imgKey)}
      />
    );
  } else {
    style.fontSize = Math.round(size * 0.42);
    content = firstGrapheme(name);
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
        kind !== "agent" && !showImg && "bg-muted font-semibold text-foreground",
        className,
      )}
      style={style}
    >
      {content}
    </span>
  );
}
