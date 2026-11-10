import type { ReactNode } from "react";
import { expect } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BlockNoteView } from "@blocknote/mantine";
import { useComponentsContext } from "@blocknote/react";
import type { BlockNoteEditor } from "@blocknote/core";
import { installCustomColors } from "@/lib/custom-colors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組走 repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;

function HostMenu({ children }: { children?: ReactNode }) {
  const Components = useComponentsContext()!;
  return (
    <Components.Generic.Menu.Root>
      <Components.Generic.Menu.Trigger>
        <button type="button" data-testid="host-trigger">
          open
        </button>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown className="bn-menu-dropdown">{children}</Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}

/**
 * 色碼選單相關測試共用的 host：BlockNoteView 內放一個根選單，dropdown 內容由 children 決定。
 * `installColors` 為真時在掛載前先裝自訂色碼的 observer（與 production 同序）。
 */
export function renderColorMenuHost(editor: AnyEditor, children?: ReactNode, opts: { installColors?: boolean } = {}) {
  if (opts.installColors) installCustomColors(document.body);
  return render(
    <BlockNoteView editor={editor} theme="light" formattingToolbar={false} slashMenu={false} sideMenu={false}>
      <HostMenu>{children}</HostMenu>
    </BlockNoteView>,
  );
}

// jsdom 沒有版面，floating-ui 的 hide 中介層會把 dropdown 標成 display:none，所以一律用 hidden: true 查節點是否還掛著。
export const menuNode = () => screen.queryByRole("menu", { hidden: true });

/** 讓 transition 與 Mantine 的初始聚焦計時器跑完。 */
export const settle = (ms = 400) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/**
 * 給 trigger 與視窗一個非零的版面，讓 floating-ui 的 hide 中介層判定 trigger 可見、dropdown 不再被標成 display:none。
 * Mantine focus trap 的 Tab 繞回（`scopeTab`）只認沒有 display:none 祖先的元素，要測 Tab 繞回就得先呼叫這支；
 * 須在開選單之前呼叫。`trigger` 是選單錨定的元素（例如工具列的顏色鈕、拖曳把手），省略時用 host 的 trigger。
 * 回傳還原函式。
 */
export function layoutHostTrigger(trigger: HTMLElement = screen.getByTestId("host-trigger")): () => void {
  const html = document.documentElement;
  Object.defineProperty(html, "clientWidth", { value: 1024, configurable: true });
  Object.defineProperty(html, "clientHeight", { value: 768, configurable: true });
  const triggerEl = trigger;
  triggerEl.getBoundingClientRect = () => new DOMRect(100, 100, 40, 20);
  return () => {
    delete (html as { clientWidth?: number }).clientWidth;
    delete (html as { clientHeight?: number }).clientHeight;
    delete (triggerEl as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  };
}

/**
 * 等 dropdown 不再被 floating-ui 標成 display:none（搭配 `layoutHostTrigger`）。`menu` 回傳要等的那個 dropdown，
 * 畫面上有不只一個選單時要傳；省略時取唯一的 `role="menu"`。
 */
export async function waitForMenuShown(menu: () => HTMLElement = () => screen.getByRole("menu", { hidden: true })) {
  await waitFor(() => expect(menu().style.display).not.toBe("none"));
}

/** 點 host 的 trigger 開選單，等 dropdown 掛上並讓初始聚焦跑完。 */
export async function openHostMenu() {
  fireEvent.click(screen.getByTestId("host-trigger"));
  await screen.findByRole("menu", { hidden: true });
  await act(() => new Promise<void>((r) => setTimeout(r, 0)));
}

// Tailwind 4 預設 `--spacing: 0.25rem`，`p-1` 是 4px
const SPACING_PX = 4;

/**
 * jsdom 沒有版面：從 class 上宣告的 `w-[Npx]` 與左右內距（`p-N`／`px-N`／`pl-N`／`pr-N`）算出內容寬度
 * （Tailwind preflight 是 border-box，寬度含內距）。遇到這幾種以外、會影響寬度的 class 直接丟錯，免得算錯還綠。
 */
export function declaredContentWidth(el: Element): number {
  let width: number | null = null;
  let left = 0;
  let right = 0;
  for (const c of Array.from(el.classList)) {
    const w = /^w-\[(\d+(?:\.\d+)?)px\]$/.exec(c);
    const p = /^p([xlr]?)-(\d+(?:\.\d+)?)$/.exec(c);
    if (w) width = Number(w[1]);
    else if (p) {
      const v = Number(p[2]) * SPACING_PX;
      if (p[1] !== "r") left = v;
      if (p[1] !== "l") right = v;
    } else if (/^(w|min-w|max-w|p|px|pl|pr|ps|pe|border|border-x|border-l|border-r)(-|$)/.test(c)) {
      throw new Error(`declaredContentWidth 不認得 class ${c}`);
    }
  }
  if (width === null) throw new Error("元素沒有宣告 w-[Npx]");
  return width - left - right;
}
