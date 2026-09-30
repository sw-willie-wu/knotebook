/**
 * 側欄 24px 圖示鈕的「滑過才浮出」（button.tsx 規範的 24px 例外那幾顆共用）。
 * - 桌面：平常 `opacity-0`；滑過該列（`group-hover/<scope>`）、列內有鍵盤焦點
 *   （`group-has-[:focus-visible]/<scope>`——不用 focus-within，滑鼠點完留下的焦點會讓它殘留，
 *   全域 memory hover-reveal-focus-visible）、自己被鍵盤聚焦時浮出。
 * - 選單開著時不消失：Radix trigger 開啟時帶 `data-state="open"`；modal 選單開著時指標已離開列，
 *   沒有這條 ⋮ 會在選單還開著時淡掉。對非選單的「＋」沒有作用（它不帶 data-state）。
 * - 觸控（`hover: none`）常駐：Tailwind v4 的 group-hover 只在 `@media (hover: hover)` 生效。
 * ⚠ 每個 scope 的 class 必須是**完整字面**——Tailwind 靜態掃描原始碼產生 CSS，
 *   樣板字串拼出來的 class 不會被產生（靜默失效，jsdom 測試照綠）。
 * ⚠ 測試只能斷言 class 字串（jsdom 沒有 CSS、沒有 hover）；真的滑過會浮出要在瀏覽器看。
 */
export type RevealScope = "section" | "grouprow" | "noterow";

const BASE =
  "opacity-0 transition-opacity focus-visible:opacity-100 [@media(hover:none)]:opacity-100 data-[state=open]:opacity-100";

const SCOPE: Record<RevealScope, string> = {
  section: "group-hover/section:opacity-100 group-has-[:focus-visible]/section:opacity-100",
  grouprow: "group-hover/grouprow:opacity-100 group-has-[:focus-visible]/grouprow:opacity-100",
  noterow: "group-hover/noterow:opacity-100 group-has-[:focus-visible]/noterow:opacity-100",
};

export function hoverReveal(scope: RevealScope): string {
  return `${BASE} ${SCOPE[scope]}`;
}
