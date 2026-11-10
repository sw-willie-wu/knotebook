import type { MouseEvent, ReactNode } from "react";
import { blockHasType, editorHasBlockWithType } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useComponentsContext, useExtensionState } from "@blocknote/react";
import { applyColor } from "./apply-color";
import { useColorMenu } from "./ColorMenuBody";
import { KnotebookColorPicker, type ColorSectionProps } from "./KnotebookColorPicker";
import { sectionProp, type ColorSection } from "./types";

/** 從面板按「返回」時要聚焦的項目（本元件的子選單觸發項）。 */
const RETURN_KEY = "dh-colors";

/**
 * 取代拖曳把手選單的「顏色」項：子選單裡是 10 種內建色，每段多一個「自訂…」，點了把整個把手選單的 dropdown
 * 換成自訂色面板。須放在 `ColorMenuBody` 裡面。文字色、底色各一段：編輯器的 schema 給這種 block 這個字串 prop
 * 時才顯示那一段（檢查寫法照上游）；兩段都不符時不顯示本項（例如 codeBlock）。
 */
export function KnotebookBlockColorsItem({ children }: { children: ReactNode }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const menu = useColorMenu()!;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });

  if (block === undefined) return null;

  const has = (section: ColorSection) => {
    const want = { [sectionProp(section)]: "string" } as const;
    return blockHasType(block, editor, block.type, want) && editorHasBlockWithType(editor, block.type, want);
  };
  const textOk = has("text");
  const bgOk = has("background");
  if (!textOk && !bgOk) return null;

  const target = { kind: "block", blockId: block.id } as const;
  const sectionProps = (section: ColorSection): ColorSectionProps => {
    const current = String((block.props as Record<string, unknown>)[sectionProp(section)] ?? "default");
    return {
      color: current,
      setColor: (c) => applyColor(editor, section, target, c),
      onCustom: (e: MouseEvent) =>
        menu.openPanel({ section, target, current, byKeyboard: e.detail === 0, returnTo: RETURN_KEY }),
    };
  };

  return (
    <Components.Generic.Menu.Root position="right" sub>
      <Components.Generic.Menu.Trigger sub>
        <Components.Generic.Menu.Item className="bn-menu-item" subTrigger data-kb-color-return={RETURN_KEY}>
          {children}
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown sub className="bn-menu-dropdown bn-color-picker-dropdown">
        <KnotebookColorPicker
          returnPrefix="dh"
          text={textOk ? sectionProps("text") : undefined}
          background={bgOk ? sectionProps("background") : undefined}
        />
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}
