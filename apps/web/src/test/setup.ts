import { afterEach } from "vitest";
import { act, cleanup, configure } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { resetNoteWidthsForTest } from "@/components/note-width";
import { dismissAllToasts } from "@/components/ui/toast";
// 站台管理／設定的字串包是 lazy 註冊（各消費檔自己 import）；元件測試一律先註冊，才不會因為只 render 一個子元件就看到 raw key。
import "@/i18n/management-strings";

// lazy chunk（設定各區塊／站台管理／登入流程頁）在測試裡第一次 render 會做真實的動態
// import；CI 高負載時可能超過 1 秒，而 Testing Library 的 waitFor／findBy 預設上限就是
// 1000ms，本機尚可、CI 間歇紅。守門力在斷言內容，不在等待長度。
// 2026-10-30 再從 3 秒放寬到 10 秒：每檔第一案付冷載入 lazy import／首次重 render，單跑約
// 0.6–1 秒（flake 稽核的 vitest JSON 實測：App.test 第一案 945 ms、第二案 94 ms）；多個 agent
// 同時跑全套（3 套 × 23 workers 擠 24 核）時會被拖過 3 秒——同一 commit 3 套並行實測 2 案
// 「Unable to find」紅（ApiTokensSection、SettingsUsersSection 的第一個等待），單跑全綠。
// 放寬前查過兩類依賴：(1) 拿 waitFor／findBy 逾時（reject）當斷言的——grep `.rejects`／try-catch／
// `.catch` 包 waitFor／findBy，沒有；(2) 靠「錯誤要在短上限內出現」守 hook 的 `retry: false` 的——
// react-query 預設重試退避 1+2+4≈7 秒，舊的 3 秒上限會讓它紅、10 秒不會。後者找到 AuthorizePage
// 410／404 與 PublicNotePage 429 三案（PublicNotePage 404 原本就計次），已補計次斷言（錯誤出現時
// 端點恰被打一次）：拿掉 hook 的 `retry: false` 會因次數為 4 而紅，與等待長度無關（突變實測）。
// 另有三支 hook 的 `retry: false` 原本完全沒人守（harness 自己關了 retry）：useUserSuggestions、
// 版本快照 useVersionSnapshot、LinkAccountPage 的 ["oidc-pending"]——各補一案「不關 retry 的 QueryClient
// ＋計次」（UserEmailCombobox／api/versions／LinkAccountPage 測試）。
// 新寫這類守衛也請計次，別靠等待上限；要守 hook 的 retry 時，那一案的 QueryClient 別關 retry。
// 10 秒不是無上限的保證：超賣 CPU 時冷載入沒有上界（同日 3 套並行有一輪仍量到 >10 秒）。
// 多套同時跑請加 `--maxWorkers=8`（3 套 × 8 實測冷載入第一案 ≤1.9 秒、總時間不變）。
configure({ asyncUtilTimeout: 10_000 });

// jsdom 沒有 `ResizeObserver`——`@blocknote/mantine` 的 `<BlockNoteView>` 掛載時，
// mantine 內部元件（`MantineProvider`／popover／tabs 一路)摸得到它就直接
// `ResizeObserver is not defined`。這裡補一個什麼都不做的假建構子，夠用（我們的測試
// 不斷言真實尺寸量測，只要它不炸）。
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom 沒有實作 `window.matchMedia`——`@blocknote/react` 的 `usePrefersColorScheme`
// 用 `window.matchMedia?.(...)` optional chaining 保護過，不掛；但 mantine 的
// `MantineProvider`／`ColorSchemeManager` 沒有這層保護，直接呼叫會炸
// `window.matchMedia is not a function`。補一個永遠回報「不符合」的假 MediaQueryList，
// `theme.test.tsx` 既有的「jsdom 沒有 matchMedia」假設不受影響（`matches: false`
// 的效果跟原本 `typeof window.matchMedia !== 'function'` 落到的分支一樣）。
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom 的 getBoundingClientRect() 回傳的物件沒有 toJSON，BlockNote 的
// SuggestionMenuView.update（wikilink autocomplete，Plan 3）呼叫時會直接炸掉。
// 這裡墊一個真正的 DOMRect（含 toJSON）當預設值；需要真實尺寸的測試請自行 spy 覆寫。
Element.prototype.getBoundingClientRect = function () {
  return new DOMRect(0, 0, 0, 0);
};

// jsdom 完全沒實作 Range.getClientRects()/getBoundingClientRect()（不是回傳空值，
// 是整個方法不存在）。真正掛載的 BlockNote 編輯器呼叫 `.focus()`/`scrollIntoView`
// 時，ProseMirror 的 coordsAtPos 會對游標位置的文字節點建一個 Range 來量測座標
// （wikilink autocomplete「建立並連結」流程的 `setTextSelection(...).run()`
// 會走到這裡），沒這兩支方法會直接丟 `range.getClientRects is not a function`。
Range.prototype.getBoundingClientRect = function () {
  return new DOMRect(0, 0, 0, 0);
};
Range.prototype.getClientRects = function () {
  return [] as unknown as DOMRectList;
};

// jsdom 沒有實作 `ClipboardEvent`——`prosemirror-view` 的 `pasteHTML`（BlockNote 的
// `pasteMarkdown` 會走到）內部 `new ClipboardEvent("paste")` 會直接 throw。補一個最小的
// 子類讓那條既有程式碼路徑跑得起來（不是造假結果，性質同上面兩個 stub）。
// markdown-link.oracle.test.ts 的比對測試非用 `pasteMarkdown` 不可，所以這個缺口必須補。
if (typeof globalThis.ClipboardEvent === "undefined") {
  globalThis.ClipboardEvent = class extends Event {} as unknown as typeof ClipboardEvent;
}

afterEach(() => {
  cleanup();
  // #297：站內寬度的模組 Map 跨案存活，不重置會依測試順序互相汙染。
  resetNoteWidthsForTest();
  // toast 也存在模組層 store、跨案存活：上一案留下的 toast 會被下一案的 findByText 撈到而假綠
  //（AuthorizePage「410 → 錯誤頁」實際發生過：頁內文案與上一案的 toast 同字，零請求也綠）。
  act(() => dismissAllToasts());
});
