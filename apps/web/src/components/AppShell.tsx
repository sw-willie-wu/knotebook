import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { canonicalNotePath } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useCreateNote } from "@/api/notes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { NoteList } from "@/components/NoteList";
import { UserMenu } from "@/components/UserMenu";

interface AppShellProps {
  children: ReactNode;
}

/**
 * 主佈局：側欄卡（logo 列 + 搜尋框 + `NoteList` + 新增筆記鈕 + 底部 `UserMenu`）、
 * 右側主內容區（呼叫端傳入的 `children`）。四個呼叫端共用同一個插槽：
 * `HomePage`（`/`）、`NotePage`（`/notes/:ref`）、`NotePageFallback`（chunk 尚未
 * 載入完成時的過渡畫面）、`NoteRouteErrorFallback`（`/notes/:ref` 的錯誤畫面）。
 *
 * 搜尋字串 state 放在這裡（不是 `NoteList`）：Ctrl/Cmd+K 要跨元件把焦點打進
 * 輸入框，搜尋字串又要往下傳給 `NoteList` 做「先分組、後過濾」（見
 * `NoteList` 檔頭），state 提升到共同祖先最單純。Ctrl/Cmd+K 語意：蓋掉瀏覽器
 * 網址列搜尋的預設行為（`preventDefault`）；任何 `[role="dialog"]` 開著時放棄
 * （避免跟 Radix Dialog 的 focus trap 互搶焦點——⋮ 選單是 `role="menu"`，不在
 * 這個判定範圍內，快捷鍵仍會觸發並把焦點搶去搜尋框，Radix menu 因此自行關閉，
 * 這個副作用可接受）；監聽掛在 `window`、卸載時移除。**按鍵比對用嚴格
 * `event.key === "k"`（不 `toLowerCase()`）：刻意排除 Ctrl+Shift+K——瀏覽器對
 * 有 Shift 的字母鍵回報大寫 `"K"`，嚴格比對讓這個快捷鍵只認「不按 Shift」
 * 這一種按法，行為釘在 `AppShell.test.tsx` 的 Ctrl/Cmd+K 案組。**讓路規則
 * （review 追加）**：BlockNote 的建立連結工具在編輯器 DOM 上綁原生
 * `keydown` 監聽 Ctrl/Cmd+K，`preventDefault()` 但不 `stopPropagation()`，事件
 * 因此仍會冒泡到 `window`；若我們不放行會搶在編輯器前面把焦點拉去搜尋框，
 * 編輯器自己的建立連結彈窗永遠打不開——見下方 `event.defaultPrevented` 判斷。
 *
 *
 * 新增筆記：`POST /api/notes`（`useCreateNote`）成功後直接導向新筆記的
 * `canonicalNotePath`（NoteDto.slug 此時必為 `null`，會落在 vanity-slug+id 或純
 * id 那兩態——見 `canonicalNotePath` 的說明）；失敗則跟 ⋮ 選單（`NoteMenu.tsx`）
 * 的刪除項同一套錯誤處理慣例：ApiFail → `errors.<code>`、否則 `errors.fallback`，
 * 用 toast 顯示（不像 LoginPage 用行內 `errorMessage` state——這裡沒有表單可以
 * 掛錯誤文案）。
 */
export function AppShell({ children }: AppShellProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const createNote = useCreateNote();
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Ctrl/Cmd+K 聚焦搜尋框。deps 刻意留空——handler 只讀 `searchInputRef`
  // （穩定的 ref 物件，不是 reactive 值），不需要隨任何 state/prop 重新掛聽。
  // `event.key === "k"` 嚴格比對（不 `toLowerCase()`）：Ctrl+Shift+K 因此
  // 不會觸發（Shift 讓瀏覽器回報大寫 `"K"`）——見上方檔頭說明。
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey) || event.key !== "k") return;
      // 讓路規則：這個按鍵已經被別人（例如 BlockNote 的建立連結工具）處理過了
      // ——`defaultPrevented` 是判斷「有沒有人已經處理過這次按鍵」的標準做法。
      // 已處理過就不再插手，讓對方的行為生效，我們不搶焦點。
      if (event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
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

  return (
    // 手動 UI 驗收回饋：NotePage 的三個面板（編輯器欄／AI 側欄／backlinks 區）要各自
    // 固定高度、內文獨立捲動，頁面本身不得整體捲動。根源在這裡——`min-h-screen`
    // 只設下限，內容一旦比視口高，這個 row 容器（連帶下面 `main`）就會跟著撐高，
    // 逼出**文件層級**的捲動，下游各卡片內部各自的 `overflow-y-auto` 因此永遠沒有
    // 機會真的裁切（它們的高度從沒被鎖住過，只是跟著內容長）。改成 `h-screen`
    // （鎖視口）＋ `overflow-hidden`（防殘留捲軸）才能讓 `h-full`／`min-h-0` 這條鏈
    // 從這裡開始真的鎖住視口高度，下游 `main`／`NotePage`／`NoteEditor` 的
    // `min-h-0` 才會生效。
    // PR2（BC2 卡片版面）：捲動已全部內移到各卡片自己的捲動容器，`main` 只留
    // `min-h-0 min-w-0 flex-1 flex flex-col` 撐開版面、不再自己 `overflow-y-auto`；
    // 側欄卡（與未來的內文卡／AI 卡）浮在這個 `p-3` 留白＋`bg-background` 深底上，
    // 卡與卡之間用根層的 `gap-3` 隔開。
    <div className="flex h-screen gap-3 overflow-hidden bg-background p-3">
      <aside className="flex w-64 shrink-0 flex-col rounded-xl border border-border bg-card">
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
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setQuery("");
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
          <Button
            variant="brand"
            className="w-full"
            onClick={() => void handleNewNote()}
            disabled={createNote.isPending}
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {t("home.newNote")}
          </Button>
        </div>

        <div className="border-t border-border p-2">
          <UserMenu />
        </div>
      </aside>
      {/* `min-h-0`：`main` 是這個 row 容器裡的 flex 子項，`h-screen` 讓它靠
          `align-items: stretch` 拿到明確高度，但 Safari/舊版瀏覽器對「stretch 出來的
          高度是否算明確」不一致；補一個 `min-h-0` 保險，確保它不會因為子孫內容
          （`NotePage` 的 `h-full` 鏈）而被撐高。`min-w-0`：原本靠自己的
          `overflow-y-auto` 隱含取得（會自我裁切、不需要顯式宣告）；PR2 把捲動
          移進側欄與各卡片自己的容器後，`main` 不再有 `overflow-y-auto`，這條
          隱含途徑消失，因此改成顯式宣告——寬度鏈能不能一路傳下去全靠它。 */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
