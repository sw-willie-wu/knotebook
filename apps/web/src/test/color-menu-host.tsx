import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

/** 點 host 的 trigger 開選單，等 dropdown 掛上並讓初始聚焦跑完。 */
export async function openHostMenu() {
  fireEvent.click(screen.getByTestId("host-trigger"));
  await screen.findByRole("menu", { hidden: true });
  await act(() => new Promise<void>((r) => setTimeout(r, 0)));
}
