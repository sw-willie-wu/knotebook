import "@/i18n/shortcuts-strings";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { fetchAiActions } from "@/api/ai";
import { useSession } from "@/auth/useSession";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { ArrowLeft } from "@/components/ui/icons";
import { managementNavItemClass } from "@/components/management/tray";
import { cn } from "@/lib/utils";
import { isMacPlatform } from "@/lib/platform";
import { useTour } from "@/lib/tour-context";
import { findUserMenuReturnTarget } from "@/lib/tour-targets";
import type { ShortcutsStartPage } from "@/lib/shortcuts-dialog";
import { RELEASE_HIGHLIGHTS, visibleHighlightItems } from "./release-highlights";
import { visibleShortcuts, type KeyToken, type ShortcutCategory, type ShortcutEntry, type ShortcutKeys } from "./shortcut-list";

/**
 * 說明視窗的內容（lazy chunk，第一次打開才下載；外殼見 `ShortcutsDialog`）。左欄由上而下是「功能導覽」「這一版新增」兩頁、分隔線、
 * 「快捷鍵」小標題與底下的各分類；右卡只顯示所選那一頁。
 *
 * 快捷鍵清單資料在 `shortcut-list.ts`，字串在 `i18n/shortcuts.*.json`（由上面那行 import 註冊）。站台能力：
 * `["ai-actions"]` 查詢有資料才列 AI 段；有 `kind === "instruct"` 的動作才列「送出指令」。載入中、錯誤、空陣列一律視為都沒有。
 *
 * 鍵面：Mac 顯示 ⌘ ⇧ ⌥，其他平台 Ctrl Shift Alt。符號鍵 `aria-hidden`、旁邊放 sr-only 名稱（報讀器讀不出 ⌘ ⇧ ↑ 的意義）；
 * 組合鍵之間的「+」與多種按法之間的「／」也 `aria-hidden`，旁邊的 sr-only 依條目的 `sep` 讀「或」（同一件事的不同按法）
 * 或「、」（各是不同動作）。
 *
 * 版面（不是單卡）：跟設定同一套兩塊 panel——左卡列分類、右卡**只顯示所選分類**；窄螢幕（< md）
 * 一次只顯示一塊（左＝分類層、右＝內容層，右卡的返回鈕回左）。不走 route，所以左欄是 state 驅動的按鈕（`aria-current`），
 * 不是 `ManagementShell` 的 NavLink；托盤、卡面、項次 class 與設定共用（`management/tray.ts`、`ui/card.ts`）。
 *
 * 焦點（比照設定）：開啟落在右卡內容區（可聚焦的捲動容器，PageDown 立刻能捲）；寬螢幕選分類後焦點留在被點的項次
 * （`aria-current` 與右卡的 region 名稱＝分類名，報讀器據此知道內容換了）；窄螢幕選分類後焦點移進內容區、返回後回到目前項次。
 *
 * 左卡底部 `<div data-shortcuts-footer>` 只有提示句、沒有按鈕：導覽的入口是「功能導覽」頁的〔開始導覽〕。
 * 「功能導覽」頁經首包的 `useTour()` 開始導覽，這個檔只 import 首包裡的 `lib/tour-context`、`lib/tour-targets`，不 import `components/tour/` 底下的模組與導覽字串包（字串包與站點表不進這個 chunk）。
 */

type TFn = (key: string) => string;

/** 符號鍵：可見的是符號（aria-hidden），旁邊放給報讀器的名稱。 */
function SymbolKey({ symbol, name }: { symbol: string; name: string }) {
  return (
    <>
      <span aria-hidden="true">{symbol}</span>
      <span className="sr-only">{name}</span>
    </>
  );
}

function keyLabel(token: KeyToken, mac: boolean, t: TFn): ReactNode {
  switch (token) {
    case "Mod":
      return mac ? <SymbolKey symbol="⌘" name={t("shortcutsGuide.srKeys.command")} /> : "Ctrl";
    case "Shift":
      return mac ? <SymbolKey symbol="⇧" name={t("shortcutsGuide.srKeys.shift")} /> : "Shift";
    case "Alt":
      return mac ? <SymbolKey symbol="⌥" name={t("shortcutsGuide.srKeys.option")} /> : "Alt";
    case "ArrowUp":
      return <SymbolKey symbol="↑" name={t("shortcutsGuide.srKeys.up")} />;
    case "ArrowDown":
      return <SymbolKey symbol="↓" name={t("shortcutsGuide.srKeys.down")} />;
    case "ArrowLeft":
      return <SymbolKey symbol="←" name={t("shortcutsGuide.srKeys.left")} />;
    case "ArrowRight":
      return <SymbolKey symbol="→" name={t("shortcutsGuide.srKeys.right")} />;
    case "Space":
      return t("shortcutsGuide.keys.space");
    case "Enter":
      return t("shortcutsGuide.keys.enter");
    case "Esc":
      return t("shortcutsGuide.keys.esc");
    case "Tab":
      return t("shortcutsGuide.keys.tab");
    case "Backspace":
      return t("shortcutsGuide.keys.backspace");
    case "Delete":
      return t("shortcutsGuide.keys.delete");
    case "Click":
      return t("shortcutsGuide.keys.click");
    default:
      return token;
  }
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border bg-muted px-1.5 font-mono text-xs">{children}</kbd>;
}

function Plus() {
  return (
    <span aria-hidden="true" className="px-0.5 text-xs text-muted-foreground">
      +
    </span>
  );
}

/** 同時按的一組鍵：每個 token 一個 <kbd>，之間以 aria-hidden 的「+」連接。 */
function Combo({ keys, mac, t }: { keys: readonly KeyToken[]; mac: boolean; t: TFn }) {
  return (
    <>
      {keys.map((token, index) => (
        <Fragment key={index}>
          {index > 0 && <Plus />}
          <Kbd>{keyLabel(token, mac, t)}</Kbd>
        </Fragment>
      ))}
    </>
  );
}

/** 一個按法；`withSpace` 為 true 時（打字觸發字後面要接空白）後面接 Space 鍵。 */
function OneKeys({ keys, mac, t, withSpace }: { keys: ShortcutKeys; mac: boolean; t: TFn; withSpace: boolean }) {
  if (keys.kind === "combo") return <Combo keys={keys.keys} mac={mac} t={t} />;
  if (keys.kind === "typed") {
    return (
      <>
        <Kbd>{keys.text}</Kbd>
        {withSpace && (
          <>
            <Plus />
            <Kbd>{keyLabel("Space", mac, t)}</Kbd>
          </>
        )}
      </>
    );
  }
  return null;
}

/** 一條的所有按法，多種按法之間放分隔。 */
function EntryKeys({ entry, mac, t }: { entry: ShortcutEntry; mac: boolean; t: TFn }) {
  const list = mac && entry.macKeys ? entry.macKeys : entry.keys;
  if (list.every((k) => k.kind === "action")) return null;
  // 每一種打字觸發字後面都要接空白時，只在最後放一個 Space，避免畫面上一排重複的 Space
  const sharedSpace = list.every((k) => k.kind === "typed" && k.thenSpace === true);
  const sepName = entry.sep === "pair" ? t("shortcutsGuide.srKeys.pair") : t("shortcutsGuide.srKeys.or");
  return (
    <>
      {list.map((keys, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <>
              <span aria-hidden="true" className="px-0.5 text-xs text-muted-foreground">
                ／
              </span>
              <span className="sr-only">{sepName}</span>
            </>
          )}
          <OneKeys keys={keys} mac={mac} t={t} withSpace={!sharedSpace && keys.kind === "typed" && keys.thenSpace === true} />
        </Fragment>
      ))}
      {sharedSpace && (
        <>
          <Plus />
          <Kbd>{keyLabel("Space", mac, t)}</Kbd>
        </>
      )}
    </>
  );
}

type Layer = "items" | "content";

/** 左欄的一頁：兩頁固定在最上面，其餘是快捷鍵分類。 */
type HelpPage = "tour" | "whatsNew" | ShortcutCategory;

/** `md` 斷點（768px，同 ManagementShell）。matches === false ＝ 窄視窗，才做焦點搬移。 */
function isNarrowViewport(): boolean {
  return !window.matchMedia("(min-width: 768px)").matches;
}

export function ShortcutsContent({ startPage = "global", onClose }: { startPage?: ShortcutsStartPage; onClose: () => void }) {
  const { t } = useTranslation();
  const mac = isMacPlatform();
  const uid = useId();
  const location = useLocation();
  const tour = useTour();
  const { user } = useSession();
  const ai = useQuery({ queryKey: ["ai-actions"], queryFn: fetchAiActions });
  const actions = ai.data ?? [];
  const groups = visibleShortcuts({ aiAvailable: actions.length > 0, aiInstruct: actions.some((a) => a.kind === "instruct") });
  const tt: TFn = (key) => t(key);

  // 列得出來的頁，依左欄順序：沒有導覽 context 就不列「功能導覽」。所選頁若消失（例如視窗開著時站台關掉 AI）就退回第一頁。
  const pages: HelpPage[] = [...(tour ? (["tour"] as const) : []), "whatsNew", ...groups.map((g) => g.category)];
  const [selected, setSelected] = useState<HelpPage>(startPage);
  const activePage: HelpPage = pages.includes(selected) ? selected : pages[0]!;
  const activeGroup = groups.find((g) => g.category === activePage);
  const highlights = visibleHighlightItems(RELEASE_HIGHLIGHTS.items, user?.isAdmin === true);
  // 初值 "content"：窄螢幕打開就直接看到內容（同設定：深連結在手機上直接看到那一頁）。
  const [layer, setLayer] = useState<Layer>("content");
  const [focusRequest, setFocusRequest] = useState<{ target: Layer; seq: number } | null>(null);
  const seqRef = useRef(0);
  const navRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = `${uid}-content`;
  const headingId = `${uid}-heading`;
  const shortcutsLabelId = `${uid}-shortcuts-label`;

  function startTour(): void {
    if (!tour) return;
    // 先關視窗再開始：視窗關閉時會把焦點還給打開它的元素，導覽接著才會搬走焦點。
    onClose();
    tour.start({ returnTo: `${location.pathname}${location.search}${location.hash}`, returnFocus: findUserMenuReturnTarget });
  }

  const pageLabel = (page: "tour" | "whatsNew"): string => t(`helpGuide.nav.${page}`);
  const navButtonProps = (page: HelpPage) => ({
    "aria-current": page === activePage ? ("true" as const) : undefined,
    "aria-controls": contentId,
    onClick: () => {
      setSelected(page);
      switchTo("content");
    },
    className: cn(managementNavItemClass(page === activePage), "w-full text-left"),
  });

  function switchTo(target: Layer): void {
    setLayer(target);
    if (!isNarrowViewport()) return; // md 以上維持原生焦點行為（焦點留在被點的項次）
    seqRef.current += 1;
    setFocusRequest({ target, seq: seqRef.current });
  }

  // 目標元素要等 setLayer commit 後才脫離 display:none，在 click handler 裡同步 focus() 真瀏覽器會靜默失敗（同 ManagementShell）。
  useLayoutEffect(() => {
    if (focusRequest === null) return;
    if (focusRequest.target === "content") contentRef.current?.focus();
    else navRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
    setFocusRequest(null);
  }, [focusRequest]);

  // 開啟：chunk 比 Dialog 晚到時，外殼的 onOpenAutoFocus 當下找不到內容區、只能先把焦點放在對話框本身——這裡接手。
  useEffect(() => {
    const focused = document.activeElement;
    if (!focused || focused === document.body || focused.getAttribute("role") === "dialog") contentRef.current?.focus();
  }, []);

  return (
    <>
      <div
        data-shortcuts-card="items"
        className={cn(cardSurface, "w-full shrink-0 flex-col overflow-hidden p-4 md:w-64", layer === "items" ? "flex" : "hidden", "md:flex")}
      >
        {/* 對話框的名稱在外殼的 sr-only DialogTitle；這裡的字只是視覺標題。 */}
        <div className="mb-3 flex h-10 items-center gap-2 px-3">
          <p aria-hidden="true" className="truncate text-[15px] font-semibold leading-tight tracking-normal">
            {t("shortcuts.title")}
          </p>
        </div>
        <nav ref={navRef} aria-label={t("shortcuts.title")} className="flex flex-col gap-1">
          {tour && (
            <button type="button" data-help-page="tour" {...navButtonProps("tour")}>
              <span className="min-w-0 truncate">{pageLabel("tour")}</span>
            </button>
          )}
          <button type="button" data-help-page="whatsNew" {...navButtonProps("whatsNew")}>
            <span className="min-w-0 truncate">{pageLabel("whatsNew")}</span>
          </button>
          <div role="separator" className="my-2 h-px bg-border" />
          <div role="group" aria-labelledby={shortcutsLabelId} className="flex flex-col gap-1">
            <p id={shortcutsLabelId} className="px-3 pb-1 text-xs font-medium text-muted-foreground">
              {t("helpGuide.nav.shortcuts")}
            </p>
            {groups.map(({ category }) => (
              <button key={category} type="button" data-shortcuts-category={category} {...navButtonProps(category)}>
                <span className="min-w-0 truncate">{t(`shortcutsGuide.categories.${category}`)}</span>
              </button>
            ))}
          </div>
        </nav>
        {/* 底部只有提示句，不放按鈕。 */}
        <div data-shortcuts-footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-border px-1 pt-3 text-xs text-muted-foreground">
          <p>
            <Trans
              i18nKey="shortcutsGuide.footer"
              components={{
                keys: (
                  <span className="inline-flex items-center gap-1 align-middle">
                    <Combo keys={["Mod", "/"]} mac={mac} t={tt} />
                  </span>
                ),
              }}
            />
          </p>
        </div>
      </div>
      <div
        data-shortcuts-card="content"
        className={cn(cardSurface, "relative min-w-0 flex-1 flex-col overflow-hidden", layer === "content" ? "flex" : "hidden", "md:flex")}
      >
        {/* 子節點順序承重：返回鈕（窄）→ 內容容器（✕ 在外殼、DOM 上更前面）。 */}
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
        <div
          ref={contentRef}
          id={contentId}
          data-shortcuts-content=""
          role="region"
          aria-labelledby={headingId}
          tabIndex={0}
          className="min-h-0 flex-1 overflow-y-auto p-4 pt-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:p-8"
        >
          {activePage === "tour" && (
            <section data-help-page-content="tour">
              <h3 id={headingId} className="mb-1 text-base font-semibold">
                {t("helpGuide.tour.heading")}
              </h3>
              <p className="mb-4 text-sm text-muted-foreground">{t("helpGuide.tour.intro")}</p>
              <Button type="button" onClick={startTour}>
                {t("helpGuide.tour.start")}
              </Button>
            </section>
          )}
          {activePage === "whatsNew" && (
            <section data-help-page-content="whatsNew">
              {highlights.length === 0 ? (
                <>
                  <h3 id={headingId} className="sr-only">
                    {pageLabel("whatsNew")}
                  </h3>
                  <p className="text-sm text-muted-foreground">{t("helpGuide.whatsNew.empty")}</p>
                </>
              ) : (
                <>
                  <h3 id={headingId} className="mb-1 text-base font-semibold">
                    {t("helpGuide.whatsNew.heading", { version: RELEASE_HIGHLIGHTS.version })}
                  </h3>
                  <ul className="divide-y divide-border">
                    {highlights.map((item) => (
                      <li key={item.id} data-highlight-id={item.id} className="py-2.5">
                        <p className="text-sm font-medium">{t(`helpGuide.whatsNew.items.${item.id}.title`)}</p>
                        <p className="text-sm text-muted-foreground">{t(`helpGuide.whatsNew.items.${item.id}.desc`, { mod: mac ? "⌘" : "Ctrl+" })}</p>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
          {activeGroup && (
            <section data-shortcut-category={activeGroup.category}>
              <h3 id={headingId} className="mb-1 text-base font-semibold">
                {t(`shortcutsGuide.categories.${activeGroup.category}`)}
              </h3>
              <ul className="divide-y divide-border">
                {activeGroup.entries.map((entry) => (
                  <li key={entry.id} data-shortcut-id={entry.id} className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:gap-4">
                    <div className="flex shrink-0 flex-wrap items-center gap-1 sm:w-56">
                      <EntryKeys entry={entry} mac={mac} t={tt} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{t(`shortcutsGuide.items.${entry.id}.name`)}</p>
                      <p className="text-sm text-muted-foreground">{t(`shortcutsGuide.items.${entry.id}.desc`)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
