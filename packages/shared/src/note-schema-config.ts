// Importing this file doesn't touch the DOM; shared's tsconfig sets no `lib`, so DOM types come by default and no
// reference directive is added.
// isSafeMediaUrl allows relative URLs (own uploads) and "" (BlockNote's "no file yet" placeholder); embeds don't
// (isAllowedEmbedUrl("") is false, pinned by the web's media-url.test.ts). data:, javascript:, file: and blob: are always blocked.
// Must stay in sync with the web's noteSchema: run the parity cases in apps/web/src/collab/schema.test.ts.
import {
  BlockNoteSchema, createBlockSpec, createCodeBlockSpec, createInlineContentSpec, defaultBlockSpecs, defaultInlineContentSpecs,
  type CodeBlockOptions,
} from "@blocknote/core";
import { columnBlockSpec, columnListBlockSpec } from "./columns.js";
import { withKnowledgeProps, withoutKnowledgeInExternalHTML } from "./knowledge-schema.js";
import { normalizeAnchor, wikilinkHref, wikilinkVisibleText } from "./site-link.js";

export const MERMAID_LANGUAGE = "mermaid";
export const mermaidBlockConfig = { type: MERMAID_LANGUAGE, content: "none", propSchema: { code: { default: "" } } } as const;
// Empty `label`: show the target's current title. Empty `anchorBlockId`: whole note (invalid values read as empty).
// Changing this changes the note schema: bump NOTE_SCHEMA_VERSION (the digest test fails otherwise).
export const wikilinkConfig = {
  type: "wikilink",
  content: "none",
  propSchema: { targetNoteId: { default: "" }, snapshotTitle: { default: "" }, label: { default: "" }, anchorBlockId: { default: "" } },
} as const;

export const SUPPORTED_LANGUAGES: NonNullable<CodeBlockOptions["supportedLanguages"]> = {
  text: { name: "Plain text", aliases: ["txt", "plaintext"] },
  typescript: { name: "TypeScript", aliases: ["ts"] },
  javascript: { name: "JavaScript", aliases: ["js", "mjs", "cjs"] },
  tsx: { name: "TSX" },
  jsx: { name: "JSX" },
  python: { name: "Python", aliases: ["py"] },
  java: { name: "Java" },
  c: { name: "C" },
  cpp: { name: "C++", aliases: ["c++"] },
  csharp: { name: "C#", aliases: ["cs", "c#"] },
  go: { name: "Go", aliases: ["golang"] },
  rust: { name: "Rust", aliases: ["rs"] },
  bash: { name: "Shell", aliases: ["sh", "shell", "zsh"] },
  sql: { name: "SQL" },
  json: { name: "JSON" },
  yaml: { name: "YAML", aliases: ["yml"] },
  toml: { name: "TOML" },
  html: { name: "HTML" },
  css: { name: "CSS" },
  xml: { name: "XML" },
  latex: { name: "LaTeX" },
  markdown: { name: "Markdown", aliases: ["md"] },
  docker: { name: "Dockerfile", aliases: ["dockerfile"] },
  diff: { name: "Diff" },
};
export const CODE_BLOCK_BASE_OPTIONS: CodeBlockOptions = { defaultLanguage: "text", supportedLanguages: SUPPORTED_LANGUAGES };

export const BLOCKED_MEDIA_URL = "about:blank";
function resolvesToHttp(raw: string, base?: string): boolean {
  let parsed: URL;
  try { parsed = new URL(raw, base); } catch { return false; }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}
export function isAllowedEmbedUrl(raw: string): boolean { return resolvesToHttp(raw, undefined); }
// `base` is required (shared has no window); a wrong one turns relative /api/uploads/<id> into about:blank.
// Web wraps these with window.location.href (apps/web/src/lib/media-url.ts); the server passes the jsdom URL (PUBLIC_URL origin).
export function isSafeMediaUrl(raw: string, base: string): boolean { return raw === "" ? true : resolvesToHttp(raw, base); }
export function safeMediaUrl(raw: string, base: string): string { return isSafeMediaUrl(raw, base) ? raw : BLOCKED_MEDIA_URL; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple (repo convention, as in apps/web/src/collab/schema.ts)
type FileBlockSpecLike = { implementation: { toExternalHTML?: (this: any, block: any, ...rest: any[]) => unknown } };
// #43: rewrite props.url, not the returned DOM: the delegated implementation also emits data-url.
// `this` and `...rest` are forwarded unchanged so upstream signature changes still work.
export function withGuardedExternalHTML<Spec extends FileBlockSpecLike>(spec: Spec, base: string): Spec {
  const original = spec.implementation.toExternalHTML;
  if (!original) return spec;
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
      toExternalHTML(this: unknown, block: any, ...rest: any[]) {
        return original.call(this, { ...block, props: { ...block.props, url: safeMediaUrl(block.props.url, base) } }, ...rest);
      },
    },
  } as Spec;
}

export function createHeadlessNoteSchema(base: string) {
  const mermaidSpec = createBlockSpec(mermaidBlockConfig, {
    render: () => ({ dom: document.createElement("div") }),
    toExternalHTML: block => {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.className = `language-${MERMAID_LANGUAGE}`;
      code.textContent = block.props.code;
      pre.append(code);
      return { dom: pre };
    },
  })(); // createBlockSpec returns a factory; createInlineContentSpec returns the spec
  const wikilinkSpec = createInlineContentSpec(wikilinkConfig, {
    render: () => ({ dom: document.createElement("span") }),
    // Same HTML as the web's wikilink toExternalHTML (components/wikilink/spec.tsx).
    toExternalHTML: ic => {
      const span = document.createElement("span");
      const a = document.createElement("a");
      a.setAttribute("href", wikilinkHref(ic.props.targetNoteId, normalizeAnchor(ic.props.anchorBlockId)));
      a.textContent = wikilinkVisibleText(ic.props);
      span.append(a);
      return { dom: span };
    },
  });
  return BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      heading: withoutKnowledgeInExternalHTML(withKnowledgeProps(defaultBlockSpecs.heading)),
      audio: withGuardedExternalHTML(defaultBlockSpecs.audio, base),
      file: withGuardedExternalHTML(defaultBlockSpecs.file, base),
      image: withGuardedExternalHTML(defaultBlockSpecs.image, base),
      video: withGuardedExternalHTML(defaultBlockSpecs.video, base),
      mermaid: mermaidSpec,
      codeBlock: createCodeBlockSpec(CODE_BLOCK_BASE_OPTIONS),
      columnList: columnListBlockSpec,
      column: columnBlockSpec,
    },
    inlineContentSpecs: { ...defaultInlineContentSpecs, wikilink: wikilinkSpec },
  });
}
