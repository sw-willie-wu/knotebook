import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { useComponentsContext } from "@blocknote/react";

interface KeepOpenMenuItemProps {
  className?: string;
  children?: ReactNode;
  icon?: ReactNode;
  checked?: boolean;
  onClick: (event: MouseEvent) => void;
  "data-test"?: string;
  "data-kb-color-return"?: string;
}

/**
 * 點了不關選單的選單項目。BlockNote 的 `Menu.Item` 型別沒有 `closeMenuOnClick`，onClick 也不帶事件，
 * 但 mantine 實作（`@blocknote/mantine` 的 `menu/Menu.tsx`）把多餘的 props 經 `...rest` 原樣交給 Mantine 的 Menu.Item，
 * onClick 也是原樣轉交，所以執行時兩者都有效；型別轉換集中在這一處。
 */
export function KeepOpenMenuItem(props: KeepOpenMenuItemProps) {
  const Components = useComponentsContext()!;
  const { onClick, ...rest } = props;
  const extra = { ...rest, closeMenuOnClick: false, onClick } as unknown as ComponentProps<typeof Components.Generic.Menu.Item>;
  return <Components.Generic.Menu.Item {...extra} />;
}
