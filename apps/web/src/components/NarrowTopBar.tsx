import { SidebarDrawerButton } from "@/components/AppShell";

/**
 * `md:hidden` 的窄視窗頂列（#115）：漢堡鈕＋K logo。給**沒有自己頁首**的內文卡
 * 用——HomePage、NotePageFallback、NoteRouteErrorFallback、NotePage 的佔位卡
 * （載入中/錯誤三分支）四處（NotePage 載入成功態的頁首自己放
 * `SidebarDrawerButton`，不用這個）。少了它，窄視窗上這些頁面就是「側欄藏了、
 * 又沒有入口能開抽屜」的死路——其中 NotePage 的 isError 是會**停住**的狀態。
 *
 * ⚠ `AppErrorFallback` 刻意**不**掛：它的不變量是零 context 相依（不用 AppShell），
 * 而 `SidebarDrawerButton` 的 context hook 在 AppShell 外會直接 throw——
 * `ErrorBoundary.test.tsx` 有反向斷言釘住這件事。
 */
export function NarrowTopBar() {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
      <SidebarDrawerButton />
      <span
        aria-hidden="true"
        className="text-xl font-bold italic text-brand"
        style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
      >
        K
      </span>
      <span className="text-sm font-semibold">Knotebook</span>
    </div>
  );
}
