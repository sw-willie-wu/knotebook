// Math blocks share the one-shot "open the source editor" request with diagrams: it is keyed by block id (unique across
// both kinds), held only in this tab, and expires on its own, so a second map would only duplicate the same 20 lines.
export {
  requestMermaidEdit as requestMathEdit,
  peekMermaidEdit as peekMathEdit,
  consumeMermaidEdit as consumeMathEdit,
} from "@/components/mermaid/auto-edit";
