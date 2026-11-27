import "@/i18n/math-strings";
import { insertOrUpdateBlockForSlashMenu } from "@blocknote/core";
import { autoPlacement, offset, shift, size } from "@floating-ui/react";
import { getDefaultReactSlashMenuItems, type DefaultReactSuggestionItem, type FloatingUIOptions } from "@blocknote/react";
import { PHONE_EDIT_TOOLBAR_CLEARANCE_PX } from "@/components/ai/SelectionAiController";
import { canInsertColumns, insertColumns } from "@/collab/columns/commands";
import { Link, Tag } from "@/components/ui/icons";
import { CircleInfo, Columns2, Diagram, Sigma } from "@/components/ui/icons-extra";
import { currentKnowledgeTarget } from "@/components/knowledge/commands";

/** Kept in the mermaid namespace on purpose: the `lastIndexOf(group)` insertion needs identical strings (pinned in slash-menu.test.tsx); renaming touches both translation files for no gain. Extracted so "link and diagram items share one group" is visible in the source; a mismatched group falls to the end. */
export const SLASH_EXTRA_GROUP_KEY = "note.mermaid.slashGroup";

export const SLASH_MENU_PHONE_BOTTOM_CLEARANCE_PX = PHONE_EDIT_TOOLBAR_CLEARANCE_PX + 8;

export function withoutSlashBadges<T extends DefaultReactSuggestionItem>(items: T[]): T[] {
  return items.map((item) => {
    const copy = { ...item };
    delete copy.badge;
    return copy;
  });
}

/** Same as BlockNote default except 8 padding and extra bottom room for the editing toolbar; height cap `min(50vh, available)`. floating-ui already bounds by the visual viewport, so the keyboard is not subtracted. */
export function slashMenuPhoneMiddleware() {
  const padding = { top: 8, left: 8, right: 8, bottom: SLASH_MENU_PHONE_BOTTOM_CLEARANCE_PX };
  return [
    offset(10),
    autoPlacement({ allowedPlacements: ["bottom-start", "top-start"], padding }),
    shift({ padding: 8 }),
    size({
      apply({ elements, availableHeight }) {
        elements.floating.style.maxHeight = `min(50vh, ${Math.max(0, availableHeight)}px)`;
      },
      padding,
    }),
  ];
}

/** Fixed object so `SuggestionMenuController` memo does not recompute. */
export const PHONE_SLASH_MENU_FLOATING_OPTIONS: FloatingUIOptions = {
  useFloatingOptions: { placement: "bottom-start", middleware: slashMenuPhoneMiddleware() },
};

/** Not listed with the caret in a column, table or child block (recomputed per query). Must spread the default items: returning only custom items silently replaces the built-in menu with no type error. `NoteEditorView` must also set `slashMenu={false}` or two controllers stack. */
export function buildSlashMenuItems(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor has three generic parameters; repo convention is any (as in wikilink/menu.ts)
  editor: any,
  translate: (key: string, options?: Record<string, unknown>) => string,
  onInsertLink: () => void,
  /** Undefined when the viewer cannot change this note's tags: the item is left out. Unlike the side-by-side items it has no position limit. */
  onOpenTagEntry?: () => void,
  /** Undefined when the viewer cannot edit: the item is left out. Listed only with the caret in a top-level heading. */
  onOpenKnowledge?: (blockId: string) => void,
): DefaultReactSuggestionItem[] {
  const defaults = getDefaultReactSlashMenuItems(editor);
  const group = translate(SLASH_EXTRA_GROUP_KEY);
  const mermaidItem: DefaultReactSuggestionItem = {
    title: translate("note.mermaid.slashTitle"),
    subtext: translate("note.mermaid.slashSubtext"),
    // Aliases in both languages so `/圖表` and `/diagram` both match.
    aliases: ["mermaid", "diagram", "chart", "flowchart", "圖表", "流程圖"],
    group,
    icon: <Diagram className="h-4 w-4" />,
    // No `props`: the default code lives in `mermaidBlockConfig`.
    onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "mermaid" }),
  };
  const mathItem: DefaultReactSuggestionItem = {
    title: translate("note.math.slashTitle"),
    subtext: translate("note.math.slashSubtext"),
    aliases: ["math", "latex", "formula", "equation", "數學", "公式"],
    group,
    icon: <Sigma className="h-4 w-4" />,
    // No `props`: the default tex lives in `mathBlockConfig`.
    onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "math" }),
  };
  const linkItem: DefaultReactSuggestionItem = {
    title: translate("note.link.slashTitle"),
    subtext: translate("note.link.slashSubtext"),
    aliases: ["link", "url", "hyperlink", "連結", "網址", "超連結"],
    group,
    icon: <Link className="h-4 w-4" />,
    onItemClick: onInsertLink,
  };
  // Interpolation is `n`, not `count`: `count` makes i18next look up plural keys.
  const columnItems: DefaultReactSuggestionItem[] = canInsertColumns(editor)
    ? ([2, 3, 4] as const).map((n) => ({
        title: translate("note.columns.slashTitle", { n }),
        subtext: translate("note.columns.slashSubtext"),
        aliases: ["grid", `grid${n}`, `grid ${n}`, "columns", "並排", "欄"],
        group,
        icon: <Columns2 className="h-4 w-4" />,
        onItemClick: () => void insertColumns(editor, n),
      }))
    : [];

  const tagItems: DefaultReactSuggestionItem[] = onOpenTagEntry
    ? [
        {
          title: translate("tags.entry.slashTitle"),
          subtext: translate("tags.entry.slashSubtext"),
          aliases: ["tag", "tags", "label", "標籤"],
          group,
          icon: <Tag className="h-4 w-4" />,
          onItemClick: onOpenTagEntry,
        },
      ]
    : [];

  const knowledgeTarget = onOpenKnowledge ? currentKnowledgeTarget(editor) : null;
  const knowledgeItems: DefaultReactSuggestionItem[] =
    onOpenKnowledge && knowledgeTarget !== null
      ? [
          {
            title: translate("note.knowledge.slashTitle"),
            subtext: translate("note.knowledge.slashSubtext"),
            aliases: ["info", "knowledge", "知識", "知識資訊", "資訊"],
            group,
            icon: <CircleInfo className="h-4 w-4" />,
            onItemClick: () => onOpenKnowledge(knowledgeTarget),
          },
        ]
      : [];

  // Cannot just push: the menu draws a group heading only when the group differs from the previous item, so appending would add a second heading; insert after the last item of the same group.
  const lastInGroup = defaults.map((entry) => entry.group).lastIndexOf(group);
  if (lastInGroup === -1) return [...defaults, mermaidItem, mathItem, linkItem, ...columnItems, ...tagItems, ...knowledgeItems];
  return [...defaults.slice(0, lastInGroup + 1), mermaidItem, mathItem, linkItem, ...columnItems, ...tagItems, ...knowledgeItems, ...defaults.slice(lastInGroup + 1)];
}
