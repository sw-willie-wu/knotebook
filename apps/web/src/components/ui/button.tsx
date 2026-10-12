import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * 按鈕的使用規範（2026-09-16 訂；在此之前只有變體清單、沒有「何時用哪個」，
 * 全 app 83 顆按鈕長出 12 種 variant×size 組合、8 個檔案在同一畫面混用尺寸）。
 *
 * **高度只有一種：32px（h-8）。**
 * `Button`（三個 size）、`Input`、各檔自訂的 `SELECT_CLASS` 全部 h-8——同一列的
 * 控制項才會等高。改版過程試過「輸入框 36、按鈕 32」與「全部 36」，前者使用者一眼
 * 看出不等高，後者被嫌笨重；最後定在全部 32。
 * ⚠ 動這三個地方任何一個，另外兩個要一起動。`ui/rows.ts` 的 `SIDEBAR_ROW_HEIGHT`
 * 是**側欄列高**、有等高守衛釘著（帳號列↔backlinks 那排），不屬於這一組，別跟著改。
 *
 * **唯一的例外：側欄上的 24px 圖示鈕（`h-6 w-6` 蓋掉 `icon` 的 `h-8 w-8`）。**
 * 只限三處（前兩處出自 spec #103 §8.1）：`NoteList.tsx` 的 `HeaderAddButton`（「我的筆記」
 * 「工作坊」段標與每個群組列右邊的「＋」）、`GroupMenu` 的 `size="sidebar"`（群組列的 ⋮；
 * 設定頁的同一顆 ⋮ 仍是預設 32px、常駐），以及 `NoteMenu.tsx` 的 `SidebarNoteMenu`（每列
 * 筆記的 ⋮；頁首那顆仍是 32px、常駐）。三顆共用 `ui/reveal.ts` 的 `hoverReveal`：
 * 桌面上平常隱藏，滑過該列或鍵盤聚焦才浮出；⋮ 在選單開著時不消失（「＋」不是選單，
 * 沒有這一條）；觸控裝置常駐。
 * 都不與輸入框或其他 32px 控制項同列，所以不違背「同列等高」的本意。
 * ⚠ **例外不外擴**：側欄以外、或與其他控制項同列的圖示鈕，一律用 `icon`（32px）。
 *
 * **size 現在只差在內距與字級，不差高度：**
 * - `icon`（h-8 w-8）——純圖示鈕（可及名稱由 `aria-label` 提供）。
 * - `sm`（px-3、12px 字）——清單列與表格列裡的動作，密度高的地方。
 * - `default`（px-4、14px 字）——其餘一切：對話框底部、與輸入框同列、獨立區塊。
 *   ⚠ **尺寸不得用來編碼嚴重度**。改版前錯誤畫面就是這樣：全頁崩潰的「重新整理」
 *   用一種、區域性錯誤的「重試」用另一種——那是一條沒寫下來的規則，讀碼的人只能猜。
 *
 * **變體看它在版面上多重要，不看它多危險：**
 * - `default`（實心）——**整個畫面最重要的那一個動作，而且同時只會有一顆**：
 *   對話框底部的送出鈕、登入頁的登入、頁首唯一的主動作。
 *   ⚠ 判準是「一個**畫面**一顆」，不是「一個表單一顆」。分享面板裡有三個小表單
 *   （加人、自訂網址、公開別名），照表單算就會冒出三顆黑底鈕擠在 512px 裡
 *   （使用者回報「為什麼這麼多種顏色」）。那個面板是即時生效、沒有送出鈕，
 *   所以它一顆實心都不該有——**畫面裡沒有唯一主角時，就不要有實心鈕**。
 * - `outline`——面板內部真正要按的動作（儲存、新增、複製、取消、重試），
 *   以及群組標題列的「新增…」。面板內部的日常動作絕大多數都落在這一級。
 *   hover／按下填 `brand-deep`（#247 §4.8，全站；hover 對比即下方 `brandDeep` 的量測）。
 * - `ghost`——**列內的動作一律用它，而且一律是 icon 形**（`size="icon"`：鉛筆＝編輯、插頭＝測試連線、紅垃圾桶＝危險動作，類名在 `components/management/row-actions.ts`；#247 §4.9），
 *   同一列裡跟在 `outline` 動作後面的「還原型」動作（清除、回自動網址、重新產生），
 *   以及該退到背景的文字動作（忽略、強制改密頁的「登出」）。
 *   同一列出現兩顆動作時：主動作 `outline`、還原／次動作 `ghost`，才分得出誰是誰。
 *   ⚠ **`ghost` 只用在「有列可依附」的地方**（表格列、清單列，或緊跟在同列主動作
 *   後面的還原型動作）。平級並排的動作一律 `outline`——ghost 沒有邊框也沒有底色，
 *   單獨站著看不出來是按鈕（「重新產生連結」被這樣回報過一次）。
 * - `destructive`——**只用在確認對話框的那一顆提交鈕**。
 * - `brand`——主色 tint（無邊框），招牌入口：側欄「新增筆記」、AI 主控。
 * - `brandSolid`／`brandDeep`——主色實心，兩階，**依所在表面二選一、不得混用**：
 *   `brandSolid`（`--brand`，原明度）給**頁面層級**的唯一主動作（登入、授權同意、
 *   全頁錯誤的主要出路）；`brandDeep`（`--brand-deep`，深一階）給 **modal 與 panel
 *   內部**的唯一主動作（對話框底部的送出鈕、設定頁首的建立鈕、框選 AI 框的套用）。
 *   兩階不會同時出現在同一個畫面，所以畫面上永遠只有一種主色實心塊。
 *   ⚠ **例外：設定管理類面板（個人設定、群組、站台管理三個 modal，#247 §4.8）的右卡不放實心鈕**——面板層級動作一律 `outline`。由面板開出的對話框（建立 token、建立使用者、刪除群組…）內的送出鈕不受影響，照本規則用 `brandDeep`。守衛：`components/management/panel-no-solid-buttons.test.tsx`（渲染期掃描）。
 *   對比（六個色票、明暗兩模式全部量過）：`brandSolid` 淺色
 *   白字 4.53–4.77、深色近黑字 5.75–7.78；`brandDeep` 淺色 6.36–6.71、深色
 *   6.69–8.96。⚠ 調整任何色票明度後要重量——`brandSolid` 淺色最低只有 4.53，
 *   離 AA 門檻 4.5 剩 0.03，往亮調一點就會掉下去。
 *
 * ⚠ **列內的危險動作一律是紅色的垃圾桶圖示鈕**（`text-destructive`、hover `bg-destructive/10`；會跳確認框的也一樣紅——Willie 2026-10-11 W20，取代 2026-09-16 的『列內刪除不塗紅』）。當年的反例是『每列一顆紅字文字鈕』，清單有幾列就紅幾次、整頁在喊；現在是 32px 內的小圖示，看得出危險又不吵。`destructive` 變體仍只給確認對話框那一顆。
 *
 * **`outline` 按下態的對比**（深色模式 `--brand-fg` 近黑字壓在混了 15% 黑的 `--brand-deep` 上）：六色票 4.43–5.83（最低是 rose 4.43，低於 AA 4.5）；淺色模式白字只會更高（實測 8.64–9.04）。量法：oklch→sRGB→WCAG 相對亮度（#247 Part 2 計畫 Task 2 的腳本）。
 *
 * ⚠ **不要加回 `secondary`**：`--secondary` 在淺色是 oklch(0.97)、與面板底
 * （`--popover`＝白）幾乎同色，在深色則與 `--accent`（＝ghost 的 hover 底色）
 * **同值**——使用者實際回報「看不出來是 hover 還是按鈕」。刪掉它就是守衛：再用會
 * 直接型別錯誤，不必靠 grep 測試。
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium " +
    "transition-colors disabled:pointer-events-none disabled:opacity-50 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        // ⚠ 底色一定要 `bg-transparent`，不要 `bg-background`：`--background` 是**頁底**色，
        // 深色模式下是 #0e1013，而對話框是 `--popover`（#22252c）、卡片是 `--card`（#1a1d23）——
        // 用頁底色等於在比它亮的表面上畫一塊更暗的方塊，看起來就是一顆黑底鈕（使用者回報
        // 「複製連結按鈕是黑底也很怪」）。透明底讓它永遠貼合所在表面，hover 改由 `brand-deep` 填色（見下）。
        // #247 §4.8（Willie W17）：hover 填 brand-deep 白字、按下再深一階。按下態用 color-mix 混 15% 黑
        // ——`active:bg-brand-deep/85` 是混**透明**，疊在卡面上反而變淺，不用。Tailwind 4.3.3 的編譯產物
        // 自帶 `@supports (color: color-mix(...))` 分支，不支援的環境退回 `--brand-deep` 平塗。
        outline:
          "border border-input bg-transparent hover:bg-brand-deep hover:text-brand-fg hover:border-transparent " +
          "active:[background:color-mix(in_oklch,var(--brand-deep)_85%,black)]",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        // PR3：主題色 tint 樣式（無邊框），首個用途：側欄「新增筆記」鈕。
        brand: "bg-brand-soft text-brand-on-soft hover:bg-brand-soft-strong",
        // 主色實心，兩階。兩階**不會同時出現在同一個畫面**：頁面層級只用 `brandSolid`、
        // modal／panel 內只用 `brandDeep`，所以任何時候使用者只看得到一種主色實心塊。
        brandSolid: "bg-brand text-brand-fg hover:bg-brand/90",
        brandDeep: "bg-brand-deep text-brand-fg hover:bg-brand-deep/90",
      },
      size: {
        default: "h-8 px-4",
        sm: "h-8 rounded-md px-3 text-xs",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** 為 true 時把樣式套到唯一子元素上（Radix Slot），而不是渲染 <button>。 */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot.Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { buttonVariants };
