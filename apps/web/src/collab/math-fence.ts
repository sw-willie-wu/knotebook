import { Extension } from "@tiptap/core";
import { MATH_LANGUAGE } from "@knotebook/shared";
import { requestMathEdit } from "@/components/math/auto-edit";
import { convertTypedFence, type TypedFence } from "./mermaid-fence";
import { createPmPlugin } from "./pm-plugin";

const MATH_FENCE: TypedFence = { language: MATH_LANGUAGE, nodeName: MATH_LANGUAGE, requestEdit: requestMathEdit };

export function createMathFenceExtension(): Extension {
  return Extension.create({
    name: "knotebookMathFence",
    addProseMirrorPlugins() {
      return [
        createPmPlugin({
          appendTransaction: (trs, oldState, newState) => convertTypedFence(MATH_FENCE, trs, oldState, newState),
        }) as never,
      ];
    },
  });
}
