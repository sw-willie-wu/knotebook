import type { MouseEvent } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { useBlockNoteEditor, useComponentsContext, useDictionary, useEditorState } from "@blocknote/react";
import { applyColor } from "./apply-color";
import { ColorMenuBody, useColorMenu } from "./ColorMenuBody";
import { KnotebookColorPicker, type ColorSectionProps } from "./KnotebookColorPicker";
import { sectionProp, type ColorSection } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組走 repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;

/** schema 裡有沒有這種顏色樣式（值是字串的 `textColor`／`backgroundColor`）。 */
function hasColorStyle(editor: AnyEditor, section: ColorSection): boolean {
  const prop = sectionProp(section);
  const spec = editor.schema.styleSchema[prop];
  return spec !== undefined && spec.type === prop && spec.propSchema === "string";
}

interface ToolbarColors {
  textColor: string | undefined;
  backgroundColor: string | undefined;
}

/** 放在 `ColorMenuBody` 裡面，才拿得到切換到自訂面板的 `openPanel`。 */
function ToolbarColorItems({ colors }: { colors: ToolbarColors }) {
  const editor = useBlockNoteEditor();
  const menu = useColorMenu()!;

  const sectionProps = (section: ColorSection, current: string | undefined): ColorSectionProps | undefined => {
    if (current === undefined) return undefined;
    return {
      color: current,
      setColor: (c) => {
        applyColor(editor, section, { kind: "inline" }, c);
        // 等選單關掉、工具列的 focus trap 放手後再把焦點還給編輯器
        setTimeout(() => editor.focus());
      },
      onCustom: (e: MouseEvent) =>
        menu.openPanel({
          section,
          target: { kind: "inline" },
          current,
          byKeyboard: e.detail === 0,
          returnTo: `tb-${section}`,
        }),
    };
  };

  return (
    <KnotebookColorPicker
      returnPrefix="tb"
      text={sectionProps("text", colors.textColor)}
      background={sectionProps("background", colors.backgroundColor)}
    />
  );
}

/**
 * 取代 BlockNote 格式工具列的顏色鈕：同樣的觸發鈕與 10 種內建色，每段多一個「自訂…」，點了在同一個 dropdown
 * 裡換成自訂色面板。顯示條件與原生相同：唯讀、選取（或游標所在）的 block 都沒有行內內容、schema 沒有任何一種
 * 顏色樣式時不顯示。
 */
export function KnotebookColorStyleButton() {
  const Components = useComponentsContext()!;
  const dict = useDictionary();
  const editor = useBlockNoteEditor();

  const colors = useEditorState({
    editor,
    selector: ({ editor: current }): ToolbarColors | undefined => {
      if (!current.isEditable) return undefined;
      const blocks = current.getSelection()?.blocks ?? [current.getTextCursorPosition().block];
      if (!blocks.some((b) => b.content !== undefined)) return undefined;
      const text = hasColorStyle(current, "text");
      const background = hasColorStyle(current, "background");
      if (!text && !background) return undefined;
      const styles = current.getActiveStyles() as { textColor?: string; backgroundColor?: string };
      return {
        textColor: text ? styles.textColor || "default" : undefined,
        backgroundColor: background ? styles.backgroundColor || "default" : undefined,
      };
    },
  });

  if (colors === undefined) return null;

  return (
    <Components.Generic.Menu.Root>
      <Components.Generic.Menu.Trigger>
        <Components.FormattingToolbar.Button
          className="bn-button"
          data-test="colors"
          label={dict.formatting_toolbar.colors.tooltip}
          mainTooltip={dict.formatting_toolbar.colors.tooltip}
          icon={
            <span
              className="bn-color-icon pointer-events-none h-5 w-5 text-[15px] leading-5"
              data-text-color={colors.textColor}
              data-background-color={colors.backgroundColor}
            >
              A
            </span>
          }
        />
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown className="bn-menu-dropdown bn-color-picker-dropdown">
        {/* 工具列根節點是 Mantine focus trap，重繪時會搶焦點；拖曳把手與表格把手的選單沒有這層，不傳 */}
        <ColorMenuBody pinFocus>
          <ToolbarColorItems colors={colors} />
        </ColorMenuBody>
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}
