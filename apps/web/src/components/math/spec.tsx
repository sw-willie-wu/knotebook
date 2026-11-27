import type { JSX } from "react";
import { createReactBlockSpec, type ReactCustomBlockRenderProps } from "@blocknote/react";
import { MATH_LANGUAGE, mathBlockConfig } from "@knotebook/shared";
import { MathView } from "./MathView";

// Defined in `@knotebook/shared` (`note-schema-config.ts`) so the server's headless schema shares them; imported
// because a bare `export { … } from …` creates no local binding, and re-exported for `spec.test.tsx`.
export { MATH_LANGUAGE, mathBlockConfig };

/**
 * Exports a ```math code block, not rendered KaTeX HTML: the source stays readable and editable wherever it lands,
 * and KaTeX markup would need its stylesheet and fonts to survive a paste. `{tex}` as a JSX child is escaped by
 * React, so markup in the source stays text. A value that isn't a string (a collaborator's client can write any value
 * into the prop) exports as an empty fence, as `MathView` and `renderMath` treat it.
 */
export function MathExternalHTML({ tex }: { tex: string }): JSX.Element {
  return (
    <pre>
      <code className={`language-${MATH_LANGUAGE}`}>{typeof tex === "string" ? tex : ""}</code>
    </pre>
  );
}

/**
 * Deliberately no `parse` rule: BlockNote's built-in codeBlock `pre` rule has higher priority, so such a rule is
 * never called and HTML paste always becomes `codeBlock(language="math")` first (`spec.test.tsx` pins this). Prove
 * with an `editor.tryParseHTMLToBlocks(...)` test that a rule is called before adding one.
 */

type MathRenderProps = ReactCustomBlockRenderProps<typeof mathBlockConfig>;

/**
 * `updateBlock` throws (`Block with ID … not found`) if a remote peer deleted the block while its source is open and
 * Esc/blur commits; swallowed because there is nowhere left to write.
 */
export function commitTex(editor: MathRenderProps["editor"], block: MathRenderProps["block"], tex: string): void {
  try {
    editor.updateBlock(block, { props: { tex } });
  } catch {
    /* block deleted remotely */
  }
}

function MathBlock({ block, editor }: MathRenderProps): JSX.Element {
  return <MathView tex={block.props.tex} editable={editor.isEditable} onChange={(tex) => commitTex(editor, block, tex)} />;
}

/** Factory, like `mermaidSpec`: call it when registering in `collab/schema.ts` (`math: mathSpec()`). */
export const mathSpec = createReactBlockSpec(mathBlockConfig, {
  render: MathBlock,
  toExternalHTML: ({ block }: MathRenderProps) => <MathExternalHTML tex={block.props.tex} />,
});
