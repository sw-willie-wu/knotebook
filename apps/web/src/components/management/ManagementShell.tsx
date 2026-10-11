import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, type Location } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeft, X } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * 三個設定管理類面板（個人設定、群組、站台管理）的共用外殼（#247 §4）：托盤上兩張卡——
 * 左卡項次、右卡內容，與筆記頁「側欄卡＋內文卡」同一語彙。Dialog 由這裡持有；三個薄包裝
 * （`settings/SettingsModal`、`groups/GroupModal`、`admin/AdminModal`）只算 `onOpenChange`
 * 並把 boundary＋Suspense＋`<Outlet/>` 當 children 傳進來。
 *
 * 窄視窗（< md，§4.6，Willie W32）是**雙層**：一次只顯示一張卡，`layer` 決定是項次層還是內容層；
 * `md:` 以上兩卡恆顯示、`layer` 無作用。兩卡的基底 class 不帶 `flex`，display 全由 layer class
 * 決定、`cn` 合併時放最後（§4.2）——基底若帶 `flex`，twMerge 會把它與 `hidden` 合併成後者，
 * 但只要有人改成字串串接，`flex hidden` 並存、被隱藏的卡就會露出來（測試釘「被隱藏的卡不含裸 flex」）。
 *
 * 焦點（§4.6、§4.7）：
 * - 開啟：不寫 `onOpenAutoFocus`。Radix FocusScope 的自動聚焦會 `removeLinks` 濾掉所有 `<a>`，
 *   項次（NavLink）永遠不會被選中；落點依右卡 DOM 順序＝返回鈕（窄）或 ✕（寬，返回鈕 display:none）。
 *   所以右卡子節點順序固定：返回鈕 → ✕ → 內容容器。
 * - 返回／點項次（只在窄視窗）：目標元素要等 `setLayer` commit 後才脫離 `display:none`，在 click
 *   handler 裡同步 `focus()` 真瀏覽器會靜默失敗（jsdom 看不出來）。所以只設 `focusRequest`，由
 *   `useLayoutEffect` 在 commit 後聚焦；`seq` 每次遞增，點「目前所在」項次（layer、pathname 都不變）也會觸發。
 * - 點項次走 `onClick`（`onSelect`），不監聽 pathname：點目前所在的項次 pathname 不會變，也要切到內容層。
 */

export interface ManagementNavItemSpec {
  to: string;
  label: string;
  /** 轉給 NavLink（§4.4）：群組 modal 的「成員」是 `/groups/:id`，不帶 end 會在子頁也高亮。 */
  end?: boolean;
  /** 列右側灰字計數，可省。 */
  count?: ReactNode;
}

export interface ManagementShellProps {
  /** 左卡標題列＝唯一的 DialogTitle（§4.5）。 */
  title: string;
  /** 標題下的副文字（群組 modal 的我的角色）。 */
  subtitle?: string;
  /** sr-only 的 DialogDescription；省略時用 title。 */
  description?: string;
  items: ManagementNavItemSpec[];
  /** Esc 與 ✕ 都經過這裡（§4.7）。 */
  onOpenChange: (open: boolean) => void;
  /** 右卡內容（各面板的 ErrorBoundary＋Suspense＋<Outlet/>）。 */
  children: ReactNode;
}

type Layer = "items" | "content";
interface FocusRequest {
  target: Layer;
  seq: number;
}

/** `md` 斷點（768px）。matches === false ＝ 窄視窗，才做焦點搬移。 */
const WIDE_QUERY = "(min-width: 768px)";
function isNarrowViewport(): boolean {
  return !window.matchMedia(WIDE_QUERY).matches;
}

/**
 * 一條左卡項次。`state={backgroundLocation ? { backgroundLocation } : undefined}` 一律轉傳——
 * 沒有這個，項次互切一次之後 `location.state` 就變 undefined，關閉 modal 時找不回原本的背景頁，
 * 只能落回 `/`（靜默扯掉背景 `/n/…` 的共編 provider）。此不變量原本寫在 `SettingsModal.tsx` 的
 * `SettingsNavLink`，#247 搬來這裡，三個面板共用。
 */
export function ManagementNavItem({
  to,
  label,
  end,
  count,
  backgroundLocation,
  onSelect,
}: ManagementNavItemSpec & { backgroundLocation: Location | undefined; onSelect: () => void }) {
  return (
    <NavLink
      to={to}
      end={end}
      state={backgroundLocation ? { backgroundLocation } : undefined}
      onClick={onSelect}
      className={({ isActive }) =>
        cn(
          "flex h-9 items-center gap-2 rounded-lg px-3 text-sm transition-colors " +
            "hover:bg-brand-soft hover:text-brand-on-soft active:bg-brand-soft-strong",
          isActive && "bg-brand-soft font-medium text-brand-on-soft hover:bg-brand-soft-strong",
        )
      }
    >
      <span className="min-w-0 truncate">{label}</span>
      {/* aria-hidden：計數只是視覺輔助，連結的可及名稱維持項次名（e2e 以名稱找項次）。 */}
      {count !== undefined && (
        <span aria-hidden="true" className="ml-auto text-xs text-muted-foreground">
          {count}
        </span>
      )}
    </NavLink>
  );
}

export function ManagementShell({ title, subtitle, description, items, onOpenChange, children }: ManagementShellProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const backgroundLocation = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  // 初值 "content"：索引 route 都在 modal 外轉到第一個項次（群組的 /groups/:id 本身就是「成員」），
  // modal 掛上時 URL 必定指著一個項次；深連結在手機上也要直接看到那一頁（§4.6）。
  const [layer, setLayer] = useState<Layer>("content");
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const seqRef = useRef(0);
  const navRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  function switchTo(target: Layer): void {
    setLayer(target);
    if (!isNarrowViewport()) return; // md 以上維持 NavLink 的原生焦點行為
    seqRef.current += 1;
    setFocusRequest({ target, seq: seqRef.current });
  }

  useLayoutEffect(() => {
    if (focusRequest === null) return;
    if (focusRequest.target === "content") {
      contentRef.current?.focus();
    } else {
      const nav = navRef.current;
      const current = nav?.querySelector<HTMLElement>('[aria-current="page"]') ?? nav?.querySelector<HTMLElement>("a");
      current?.focus();
    }
    setFocusRequest(null);
  }, [focusRequest]);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      {/* 點外面不關：內容區的 inline 表單（改密碼、改名…）有未存輸入；Esc／✕ 照常關閉。 */}
      <DialogContent size="panel" dismissOnOutside={false}>
        {/* 托盤（§4.3）：頁底色 45%＋毛玻璃，陰影只在這一層；卡本身不投影。 */}
        <div className="flex h-full w-full gap-2 rounded-2xl bg-background/45 p-2 shadow-[0_20px_60px_rgba(0,0,0,.35)] backdrop-blur-md md:gap-3 md:p-3">
          <div
            data-management-card="items"
            className={cn(
              cardSurface,
              "w-full shrink-0 flex-col overflow-hidden p-4 md:w-64",
              layer === "items" ? "flex" : "hidden",
              "md:flex",
            )}
          >
            <div className="mb-3 flex h-10 items-center gap-2 px-3">
              <div className="min-w-0">
                <DialogTitle className="truncate text-[15px] font-semibold leading-tight tracking-normal">{title}</DialogTitle>
                {subtitle !== undefined && <p className="truncate text-xs font-normal text-muted-foreground">{subtitle}</p>}
              </div>
            </div>
            <DialogDescription className="sr-only">{description ?? title}</DialogDescription>
            <nav ref={navRef} aria-label={title} className="flex flex-col gap-1">
              {items.map((item) => (
                <ManagementNavItem
                  key={item.to}
                  {...item}
                  backgroundLocation={backgroundLocation}
                  onSelect={() => switchTo("content")}
                />
              ))}
            </nav>
          </div>
          <div
            data-management-card="content"
            className={cn(
              cardSurface,
              "relative min-w-0 flex-1 flex-col overflow-hidden",
              layer === "content" ? "flex" : "hidden",
              "md:flex",
            )}
          >
            {/* 子節點順序是承重的：返回鈕 → ✕ → 內容容器（開啟焦點落點，§4.7）。 */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute left-2 top-2 z-10 h-7 w-7 bg-card md:hidden"
              aria-label={t("management.back")}
              onClick={() => switchTo("items")}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-2 top-2 z-10 h-7 w-7 bg-card"
                aria-label={t("management.close")}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DialogClose>
            <div
              ref={contentRef}
              data-management-content=""
              tabIndex={-1}
              className="flex-1 overflow-y-auto p-4 pt-12 focus:outline-none md:p-8"
            >
              {children}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
