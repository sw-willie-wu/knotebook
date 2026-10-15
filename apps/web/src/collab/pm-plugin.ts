import { inputRulesPlugin, type Editor } from "@tiptap/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror Transaction／EditorState 型別在 apps/web 值層級拿不到（memory knotebook-markdown-link-rule）
type Any = any;

export interface PmPluginSpec {
  appendTransaction?(trs: readonly Any[], oldState: Any, newState: Any): Any;
  /** PM 的 `props`（例：`decorations(state)`，`collab/code-block-caret.ts` 用）。 */
  props?: { decorations?(state: Any): Any };
}

/**
 * `@tiptap/pm/state`（`Plugin`）從 apps/web 在值層級 import 不到（`MODULE_NOT_FOUND`，Vite transform 階段就炸——memory
 * knotebook-markdown-link-rule）。`@tiptap/core` 匯出的 `inputRulesPlugin` 會以 tiptap 自己那份 prosemirror-state 的 `Plugin`
 * 建一個實例（建構時不碰 editor）；取它的 `constructor` ＝ 與編輯器同一份 `Plugin` 類別。接線是否真的生效由
 * `site-link-convert.test.tsx` 的「拔接線要紅」案在真編輯器上守。
 */
const PluginClass = (inputRulesPlugin({ editor: undefined as unknown as Editor, rules: [] }) as unknown as { constructor: new (spec: PmPluginSpec) => unknown })
  .constructor;

export function createPmPlugin(spec: PmPluginSpec): unknown {
  return new PluginClass(spec);
}
