import { SidebarDrawerButton } from "@/components/AppShell";
import { BackToListButton } from "@/components/BackToListButton";

/**
 * `xl:hidden` 的窄視窗頂列（#115）：入口鈕＋K logo。640–1279px 的入口是側欄鈕（側欄收成浮動抽屜）；手機（< 640）是「‹」回清單
 * （`BackToListButton`，手機沒有抽屜）。給**沒有自己頁首**的內文卡用——HomePage（手機上不渲染，清單就是整個畫面）、
 * NotePageFallback、NoteRouteErrorFallback、NotePage 的佔位卡（載入中/錯誤三分支）
 * （NotePage 載入成功態的頁首自己放 `BackToListButton`＋`SidebarDrawerButton`，不用這個）。少了它，窄視窗上這些頁面就是「側欄藏了、
 * 又沒有入口能開抽屜」的死路——其中 NotePage 的 isError 是會**停住**的狀態。
 *
 * ⚠ `AppErrorFallback` 刻意**不**掛：它的不變量是零 context 相依（不用 AppShell），
 * 而 `SidebarDrawerButton` 的 context hook 在 AppShell 外會直接 throw——
 * `ErrorBoundary.test.tsx` 有反向斷言釘住這件事。
 */
export function NarrowTopBar() {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2 xl:hidden">
      {/* 手機是「‹」（回清單），浮動段是側欄鈕，固定段整列 `xl:hidden`；兩顆各自只在自己的寬度渲染。 */}
      <BackToListButton />
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
