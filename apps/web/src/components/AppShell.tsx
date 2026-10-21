import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { Dialog as DialogPrimitive } from "radix-ui";
import { canonicalNotePath } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useCreateNote } from "@/api/notes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, Plus, Search } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { cardSurface } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { NARROW_QUERY, SidebarDrawerContext, useSidebarDrawer } from "@/lib/sidebar-drawer";
import { canonicalizedFrom } from "@/lib/real-location";
import { SidebarTabProvider, useSidebarTabState } from "@/lib/sidebar-tab";
import { NoteList } from "@/components/NoteList";
import { SidebarTabList, sidebarPanelId, sidebarTabId } from "@/components/sidebar/SidebarTabList";
import { UserMenu } from "@/components/UserMenu";
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STEP,
  readSidebarWidth,
  writeSidebarWidth,
} from "@/components/sidebar-width";
import { PaneResizeHandle } from "@/components/PaneResizeHandle";

// `<md` 的判準 `NARROW_QUERY` 住在 `lib/sidebar-drawer.ts`（`SidebarTabProvider` 也要用）。

// 抽屜開關的 context（`SidebarDrawerContext`／`useSidebarDrawer`）住在 `lib/sidebar-drawer.ts`。

/** 漢堡鈕（`md:hidden`）：NotePage 頁首與 `NarrowTopBar` 共用的抽屜入口。 */
export function SidebarDrawerButton() {
  const { t } = useTranslation();
  const { setOpen } = useSidebarDrawer();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={t("sidebar.openDrawer")}
      onClick={() => setOpen(true)}
      className="h-8 w-8 shrink-0 md:hidden"
    >
      <Menu aria-hidden="true" className="h-4 w-4" />
    </Button>
  );
}

interface SidebarContentProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** 搜尋框 ref——**兩個實例（靜態卡／抽屜）各傳自己的 ref 物件**，不得共用：
   * 共用同一個物件的話，抽屜 unmount 時 React 會把它清成 null，Ctrl+K 從此
   * 靜默失效（spec §3a）。 */
  searchRef: RefObject<HTMLInputElement | null>;
  onCreateNote: (groupId?: string) => void;
  newNotePending: boolean;
  shortcutBadge: string;
}

/** 側欄的內層堆疊（logo 列／搜尋／tab 列／tabpanel（NoteList）／新增鈕／UserMenu）。目前 tab 住在
 * `SidebarTabProvider`（靜態卡與抽屜兩份實例共用一份）。wrapper（靜態
 * `<aside>` 卡或抽屜 Content）由呼叫端提供——兩個 wrapper 都必須給
 * `flex flex-col` 脈絡，否則清單容器的 `min-h-0 flex-1 overflow-y-auto` 失去
 * 約束（spec §3a 邊界定案）。 */
function SidebarContent({
  query,
  onQueryChange,
  searchRef,
  onCreateNote,
  newNotePending,
  shortcutBadge,
}: SidebarContentProps) {
  const { t } = useTranslation();
  // 靜態卡與抽屜各自一份 `useId`，tab／tabpanel 的 id 才不會撞（spec §5.5）。
  const idBase = useId();
  const { tab } = useSidebarTabState();
  return (
    <>
      <div className="flex items-center gap-2 px-3 pt-3">
        <span
          aria-hidden="true"
          className="text-2xl font-bold italic text-brand"
          style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
        >
          K
        </span>
        <span className="text-sm font-semibold">Knotebook</span>
      </div>

      <div className="relative mx-2 mt-2">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            onQueryChange("");
            event.currentTarget.blur();
          }}
          aria-label={t("sidebar.searchLabel")}
          placeholder={t("sidebar.searchPlaceholder")}
          className="h-8 pl-7 pr-11 text-[13px]"
        />
        <kbd
          aria-hidden="true"
          className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 rounded border border-border px-1 text-[10px] text-muted-foreground"
        >
          {shortcutBadge}
        </kbd>
      </div>

      <SidebarTabList idBase={idBase} />

      <div
        role="tabpanel"
        id={sidebarPanelId(idBase)}
        aria-labelledby={sidebarTabId(idBase, tab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          <NoteList query={query} onCreateNote={onCreateNote} createNotePending={newNotePending} />
        </div>
      </div>

      <div className="m-2">
        <Button variant="brand" className="w-full" onClick={() => onCreateNote()} disabled={newNotePending}>
          <Plus aria-hidden="true" className="h-4 w-4" />
          {t("home.newNote")}
        </Button>
      </div>

      <div className="border-t border-border p-2">
        <UserMenu />
      </div>
    </>
  );
}

interface AppShellProps {
  children: ReactNode;
  /** #229：簡報模式時整個背景不可互動（spec §6.6-7）；簡報層是 AppShell 的兄弟、不在它底下。 */
  inert?: boolean;
}

/**
 * 主佈局：側欄（`md+`＝固定卡片；`<md`＝隱藏，改由抽屜承載，入口是
 * `SidebarDrawerButton` 漢堡鈕——NotePage 頁首或 `NarrowTopBar` 提供）、右側主
 * 內容區（呼叫端傳入的 `children`）。四個呼叫端：`HomePage`（`/`）、
 * `NotePage`（`/n/:handle/:slug`、`/g/:groupId/:slug`（#175）與舊形 `/notes/:ref` 三條 route 共用）、
 * `NotePageFallback`、`NoteRouteErrorFallback`（#247 起站台管理是 modal，不再用 AppShell）。
 *
 * 側欄內容抽成 `SidebarContent`，靜態卡與抽屜共用；抽屜開著時 DOM 上同時有兩份
 * （靜態那份 `hidden`——真實瀏覽器 display:none 不進 a11y tree、不可聚焦；jsdom
 * 沒有 CSS，所以測試端一律 `within(drawer)` 圈定查詢）。
 *
 * 搜尋字串 state 放在這裡（不是 `NoteList`）：Ctrl/Cmd+K 要跨元件把焦點打進
 * 輸入框，搜尋字串又要往下傳給 `NoteList` 做「先分組、後過濾」，且靜態與抽屜兩份
 * 搜尋框要顯示同一個值——state 提升到共同祖先最單純。
 *
 * Ctrl/Cmd+K 語意（#115 改版後）：蓋掉瀏覽器網址列搜尋的預設行為
 * （`preventDefault`；僅在有事可做時——窄＝開/聚焦抽屜、寬＝靜態搜尋框已掛上，見下）；任何**非抽屜的** `[role="dialog"]` 開著時放棄（避免跟
 * Radix Dialog 的 focus trap 互搶焦點——判別靠 `:not([data-sidebar-drawer])`
 * 屬性選擇器，不是元件身分；⋮ 選單是 `role="menu"`，不在判定範圍，快捷鍵仍會
 * 觸發（寬分支會把焦點搶去搜尋框，Radix menu 因此自行關閉，副作用可接受）。
 * 然後分斷點：
 * **窄**（`matchMedia(NARROW_QUERY).matches`）→ 抽屜未開就開抽屜（聚焦交給
 * `onOpenAutoFocus`：Ctrl+K 開的聚焦抽屜搜尋框，漢堡開的聚焦抽屜容器；靜態搜尋框
 * 是 display:none、focus() 無效）；**寬** → 聚焦靜態搜尋框。**按鍵比對用嚴格 `event.key === "k"`**（不 `toLowerCase()`）：
 * 刻意排除 Ctrl+Shift+K——瀏覽器對有 Shift 的字母鍵回報大寫 `"K"`，嚴格比對讓
 * 這個快捷鍵只認「不按 Shift」這一種按法，行為釘在 `AppShell.test.tsx` 的
 * Ctrl/Cmd+K 案組。**讓路規則**：
 * BlockNote 的建立連結工具在編輯器 DOM 上綁原生 `keydown` 監聽 Ctrl/Cmd+K，
 * `preventDefault()` 但不 `stopPropagation()`——見 handler 內
 * `event.defaultPrevented` 判斷，不讓路的話編輯器自己的建立連結彈窗永遠打不開。
 *
 * 抽屜（Radix Dialog 直組——不用 `ui/dialog.tsx` 的 `DialogContent`，它寫死置中
 * 樣式還強制塞右上 X）：focus trap（**需焦點先落進容器才武裝**，見
 * `onOpenAutoFocus`）／Escape／backdrop 關閉／scroll lock 由 Radix 給；路由變化
 * （點側欄筆記）與跨斷點 resize（change → `matches:false`）時自行關閉。
 *
 * 新增筆記：`POST /api/notes`（`useCreateNote`）成功後直接導向新筆記的
 * `canonicalNotePath`（個人筆記 `/n/<ownerHandle>/<slug>`；群組段「＋」建的群組筆記導
 * `/g/<groupId>/<slug>`（#175）——新筆記吃 DB default 的 `untitled-<uuid8>` slug）；失敗則跟 ⋮ 選單（`NoteMenu.tsx`）
 * 的刪除項同一套錯誤處理慣例：ApiFail → `errors.<code>`、否則 `errors.fallback`，
 * 用 toast 顯示（不像 LoginPage 用行內 `errorMessage` state——這裡沒有表單可以
 * 掛錯誤文案）。
 *
 * 側欄 tab：state 由 `SidebarTabProvider`（包住整個版面、在抽屜 context 之內）持有；`AppShell` 隨
 * 首頁↔筆記頁重掛（各自渲染一份），tab 靠 localStorage 在重掛間帶回，切 tab 不重繪 `AppShell` 本身。
 *
 * 側欄寬度（Task 4）：靜態卡寬度是 `<aside style={{ width }}>` 的 React state，範圍
 * 200–480、預設 256（＝改版前的 `w-64`），存在 localStorage（`sidebar-width.ts`）。下限讓
 * 群組內筆記列還留得下約 3 個中文字；上限不相對視窗——窄視窗下拉到最寬會擠壓內文，
 * 雙擊把手即回 256。把手（共用的 `PaneResizeHandle`，`edge="right"`）是 `<aside>` 內
 * `absolute left-full w-3` 的子元素，約略蓋在根容器既有的 `gap-3` 上（以 padding box 定位，
 * 壓住 aside 右框一個框寬）——所以根的 `gap-3`
 * 與 `main` 都不動；`<aside>` 在 `<md` 是 `hidden`，把手跟著消失。抽屜仍固定 `w-64`。
 */
export function AppShell({ children, inert }: AppShellProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const createNote = useCreateNote();
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const handleSidebarWidth = (px: number, commit: boolean) => {
    setSidebarWidth(px);
    if (commit) writeSidebarWidth(px);
  };

  const searchInputRef = useRef<HTMLInputElement>(null);
  /** 抽屜實例的搜尋框 ref——與 `searchInputRef` 是**兩個不同的物件**（見
   * SidebarContentProps.searchRef 的說明）。 */
  const drawerSearchRef = useRef<HTMLInputElement>(null);
  const drawerContentRef = useRef<HTMLDivElement>(null);
  /** Ctrl+K 開抽屜時設 true，`onOpenAutoFocus` 讀完即清——漢堡開的不聚焦搜尋框
   * （觸控裝置會彈鍵盤蓋掉半個抽屜）。 */
  const openedByShortcutRef = useRef(false);
  const drawerOpenRef = useRef(drawerOpen);
  drawerOpenRef.current = drawerOpen;

  // Ctrl/Cmd+K。deps 刻意留空——handler 只讀 ref（穩定物件）與當下的
  // matchMedia/DOM，不需要隨 state 重新掛聽。
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey) || event.key !== "k") return;
      // 讓路規則：這個按鍵已經被別人（例如 BlockNote 的建立連結工具）處理過了。
      if (event.defaultPrevented) return;
      // 非抽屜的 dialog 開著（設定 modal、分享 dialog…）→ 放棄，不搶 focus trap。
      if (document.querySelector('[role="dialog"]:not([data-sidebar-drawer])')) return;
      if (window.matchMedia(NARROW_QUERY).matches) {
        event.preventDefault();
        if (!drawerOpenRef.current) {
          openedByShortcutRef.current = true;
          setDrawerOpen(true);
        } else {
          // 已開（漢堡開的話焦點在 Content 容器、不在搜尋框）：Ctrl+K 的語意是
          // 「聚焦搜尋」，直接把焦點放進抽屜的搜尋框。
          drawerSearchRef.current?.focus();
        }
      } else if (searchInputRef.current) {
        // 寬：聚焦靜態搜尋框（ref 尚未掛上時不吞鍵）。
        event.preventDefault();
        searchInputRef.current.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 路由變化（點抽屜裡的筆記、導向新筆記）→ 關抽屜。mount 時不動作（初值本來就 false）。
  // #179：NotePage 的 canonical 收斂（改標題、他人改名）也會換 pathname，但那是**同一篇**換網址，
  // 不是換頁——抽屜開著就留著。判準是新 entry 的 `canonicalizedFrom` 標記等於上一個 pathname
  // （只認這一步；之後經上一頁回到帶標記的 entry 時，上一個 pathname 對不上，照常關）。
  // 只有 state 變、pathname 沒變（例如 openEdits 被清掉）不算路由變化，與先前只看 pathname 一致。
  const previousPathnameRef = useRef(location.pathname);
  useEffect(() => {
    const previous = previousPathnameRef.current;
    previousPathnameRef.current = location.pathname;
    if (previous === location.pathname) return;
    if (canonicalizedFrom(location.state) === previous) return;
    setDrawerOpen(false);
  }, [location.pathname, location.state]);

  // 抽屜關閉（任何路徑：Esc/backdrop/route/resize）→ 清捷徑旗標。Ctrl+K 開啟後
  // 若在 Content 掛載、onOpenAutoFocus 消化旗標**之前**就被關掉，殘留的旗標會讓
  // 下一次漢堡開誤聚焦搜尋框（觸控彈鍵盤）。
  useEffect(() => {
    if (!drawerOpen) openedByShortcutRef.current = false;
  }, [drawerOpen]);

  // 跨斷點 resize（旋轉平板、拉寬視窗）→ 關抽屜，否則靜態側欄與抽屜同時出現、
  // overlay 蓋住全畫面。⚠ jsdom 的 matchMedia stub 的 addEventListener 是 no-op，
  // 這條的行為測試用可控 stub 手動 dispatch change（AppShell.test）。
  useEffect(() => {
    const mql = window.matchMedia(NARROW_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      if (!event.matches) setDrawerOpen(false);
    };
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

  /** 建立筆記並導向。`groupId` 給群組段的「＋」（#103，server 預設 editor）；失敗
   * 一律 toast（含群組剛被刪的 404 `group_not_found`）。 */
  async function handleNewNote(groupId?: string): Promise<void> {
    try {
      const note = await createNote.mutateAsync(groupId === undefined ? undefined : { groupId });
      navigate(canonicalNotePath(note));
    } catch (err) {
      const message =
        err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback");
      toast({ title: message, variant: "destructive" });
    }
  }

  // `navigator.platform` 已棄用但仍是目前偵測平台最簡單可靠的方式，這裡只用來
  // 決定快捷鍵徽章的顯示文字（⌘K vs Ctrl K），不影響任何行為判斷。`?? ""`
  // 防呆：某些環境（如部分測試/嵌入式 WebView）這個欄位可能是空字串以外的
  // falsy 值，讓 `.toLowerCase()` 不會炸在 undefined 上。
  const platform = typeof navigator !== "undefined" ? (navigator.platform ?? "") : "";
  const shortcutBadge = platform.toLowerCase().includes("mac") ? "⌘K" : "Ctrl K";

  const sidebarProps = {
    query,
    onQueryChange: setQuery,
    onCreateNote: (groupId?: string) => void handleNewNote(groupId),
    newNotePending: createNote.isPending,
    shortcutBadge,
  };

  return (
    // 高度/捲動鏈（PR2（BC2 卡片版面）起）：三個面板要各自固定高度、內文獨立捲動，
    // 頁面本身不得整體捲動。`min-h-screen` 只設下限——內容一旦比視口高，這個 row
    // 容器（連帶 `main`）就會跟著撐高，逼出**文件層級**的捲動，下游各卡片的
    // `overflow-y-auto` 因此永遠沒機會真的裁切。必須 `h-screen`（鎖視口）＋
    // `overflow-hidden`（防殘留捲軸），`h-full`／`min-h-0` 這條鏈才從這裡開始鎖住
    // 視口高度。捲動全部內移到各卡片自己的捲動容器，`main` 只留
    // `min-h-0 min-w-0 flex-1 flex flex-col` 撐開版面（`min-w-0` 顯式宣告——
    // `main` 沒有 overflow、少了隱含的自我裁切途徑，寬度鏈全靠它）。
    <SidebarDrawerContext.Provider value={{ setOpen: setDrawerOpen }}>
      <SidebarTabProvider>
        <div inert={inert} className="flex h-screen gap-3 overflow-hidden bg-background p-3">
          <aside className={cn(cardSurface, "relative hidden shrink-0 md:flex md:flex-col")} style={{ width: sidebarWidth }}>
            <SidebarContent {...sidebarProps} searchRef={searchInputRef} />
            <PaneResizeHandle
              width={sidebarWidth}
              onChange={handleSidebarWidth}
              min={SIDEBAR_WIDTH_MIN}
              max={SIDEBAR_WIDTH_MAX}
              defaultWidth={SIDEBAR_WIDTH_DEFAULT}
              step={SIDEBAR_WIDTH_STEP}
              edge="right"
              label={t("sidebar.resize")}
              placementClassName="left-full"
            />
          </aside>

          <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
            <DialogPrimitive.Portal>
              <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
              <DialogPrimitive.Content
                ref={drawerContentRef}
                data-sidebar-drawer=""
                // 底色與 flex 脈絡缺一不可：沒底色透出 overlay 的黑、沒 flex-col 則
                // SidebarContent 的 min-h-0 flex-1 清單失去約束（spec §3a）。貼齊
                // 左緣故意不用 cardSurface 的圓角——抽屜不是卡片。
                className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border bg-card"
                onOpenAutoFocus={(event) => {
                  event.preventDefault();
                  if (openedByShortcutRef.current && drawerSearchRef.current) {
                    drawerSearchRef.current.focus();
                    openedByShortcutRef.current = false;
                  } else {
                    openedByShortcutRef.current = false;
                    // 漢堡開：不聚焦搜尋框（觸控裝置會彈鍵盤；Radix 預設聚焦第一個
                    // 可聚焦元素恰好就是它，必須 preventDefault 擋掉），但焦點必須
                    // 落進抽屜本身——Radix 的 focus trap 要焦點先進容器才武裝
                    // （lastFocusedElement 為 null 時 handleFocusIn 拉不回焦點、Tab
                    // 攔截掛在容器 onKeyDown 也不會觸發），只 preventDefault 不補
                    // 聚焦＝trap 沒建立、Tab 逃進 aria-hidden 的背景。
                    drawerContentRef.current?.focus();
                  }
                }}
              >
                {/* Radix 的 aria-labelledby 只在 Title 存在時輸出——不放＝一個無
                    可及名稱的 dialog（釘住的 radix-ui 1.6.7 已不再 console 警告，
                    沒有訊號提醒你）。 */}
                <DialogPrimitive.Title className="sr-only">{t("sidebar.drawerTitle")}</DialogPrimitive.Title>
                <SidebarContent {...sidebarProps} searchRef={drawerSearchRef} />
              </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
          </DialogPrimitive.Root>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
        </div>
      </SidebarTabProvider>
    </SidebarDrawerContext.Provider>
  );
}
