import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
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
import { NoteList } from "@/components/NoteList";
import { UserMenu } from "@/components/UserMenu";

/** `<md`（Tailwind `md` 斷點以下）的判準——與 index.css 的 `.bn-editor.bn-editor`
 * 覆寫、`max-md:` variant 同界。range 語法需 Chrome 104+；更舊的瀏覽器
 * `matches:false` 落寬分支（Ctrl+K 在窄視窗靜默無效），可接受的漸進劣化。 */
const NARROW_QUERY = "(width < 48rem)";

interface SidebarDrawerState {
  setOpen: (open: boolean) => void;
}

/** #115：側欄抽屜的開關。刻意 null 起始＋throwing hook——`AppErrorFallback`
 * 那類「零 context 相依」的畫面本來就不該掛 `SidebarDrawerButton`，掛了要大聲
 * 炸在開發期，而不是渲染一顆點了沒反應的死鈕。 */
const SidebarDrawerContext = createContext<SidebarDrawerState | null>(null);

function useSidebarDrawer(): SidebarDrawerState {
  const ctx = useContext(SidebarDrawerContext);
  if (!ctx) throw new Error("SidebarDrawerButton must be rendered inside AppShell");
  return ctx;
}

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
  onNewNote: () => void;
  newNotePending: boolean;
  shortcutBadge: string;
}

/** 側欄的內層堆疊（logo 列／搜尋／NoteList／新增鈕／UserMenu）。wrapper（靜態
 * `<aside>` 卡或抽屜 Content）由呼叫端提供——兩個 wrapper 都必須給
 * `flex flex-col` 脈絡，否則清單容器的 `min-h-0 flex-1 overflow-y-auto` 失去
 * 約束（spec §3a 邊界定案）。 */
function SidebarContent({ query, onQueryChange, searchRef, onNewNote, newNotePending, shortcutBadge }: SidebarContentProps) {
  const { t } = useTranslation();
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <NoteList query={query} />
      </div>

      <div className="m-2">
        <Button variant="brand" className="w-full" onClick={onNewNote} disabled={newNotePending}>
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
}

/**
 * 主佈局：側欄（`md+`＝固定卡片；`<md`＝隱藏，改由抽屜承載，入口是
 * `SidebarDrawerButton` 漢堡鈕——NotePage 頁首或 `NarrowTopBar` 提供）、右側主
 * 內容區（呼叫端傳入的 `children`）。四個呼叫端共用同一個插槽：`HomePage`（`/`）、
 * `NotePage`（`/notes/:ref`）、`NotePageFallback`、`NoteRouteErrorFallback`。
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
 * （`preventDefault`）；任何**非抽屜的** `[role="dialog"]` 開著時放棄（避免跟
 * Radix Dialog 的 focus trap 互搶焦點——判別靠 `:not([data-sidebar-drawer])`
 * 屬性選擇器，不是元件身分；⋮ 選單是 `role="menu"`，不在判定範圍，快捷鍵仍會
 * 觸發（寬分支會把焦點搶去搜尋框，Radix menu 因此自行關閉，副作用可接受）。
 * 然後分斷點：
 * **窄**（`matchMedia(NARROW_QUERY).matches`）→ 抽屜未開就開抽屜（聚焦交給
 * `onOpenAutoFocus`，靜態搜尋框是 display:none、focus() 無效）；**寬** → 照舊
 * 聚焦靜態搜尋框。**按鍵比對用嚴格 `event.key === "k"`**（不 `toLowerCase()`）：
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
 * `canonicalNotePath`（#122 起 slug 恆為字串——新筆記吃 DB default 的
 * `untitled-<uuid8>`，落在 `/notes/<slug>` 那一態）；失敗則跟 ⋮ 選單（`NoteMenu.tsx`）
 * 的刪除項同一套錯誤處理慣例：ApiFail → `errors.<code>`、否則 `errors.fallback`，
 * 用 toast 顯示（不像 LoginPage 用行內 `errorMessage` state——這裡沒有表單可以
 * 掛錯誤文案）。
 */
export function AppShell({ children }: AppShellProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const createNote = useCreateNote();
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);

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
      event.preventDefault();
      if (window.matchMedia(NARROW_QUERY).matches) {
        if (!drawerOpenRef.current) {
          openedByShortcutRef.current = true;
          setDrawerOpen(true);
        } else {
          // 已開（漢堡開的話焦點在 Content 容器、不在搜尋框）：Ctrl+K 的語意是
          // 「聚焦搜尋」，直接把焦點放進抽屜的搜尋框。
          drawerSearchRef.current?.focus();
        }
      } else {
        searchInputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 路由變化（點抽屜裡的筆記、導向新筆記）→ 關抽屜。deps 是 pathname：mount 時
  // 跑一次 setDrawerOpen(false) 是無害的 no-op（初值本來就 false）。
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

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

  async function handleNewNote(): Promise<void> {
    try {
      const note = await createNote.mutateAsync(undefined);
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
    onNewNote: () => void handleNewNote(),
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
      <div className="flex h-screen gap-3 overflow-hidden bg-background p-3">
        <aside className={cn(cardSurface, "hidden w-64 shrink-0 md:flex md:flex-col")}>
          <SidebarContent {...sidebarProps} searchRef={searchInputRef} />
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
                if (openedByShortcutRef.current) {
                  drawerSearchRef.current?.focus();
                  openedByShortcutRef.current = false;
                } else {
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
    </SidebarDrawerContext.Provider>
  );
}
