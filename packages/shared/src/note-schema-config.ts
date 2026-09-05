// 只有 render／toExternalHTML 閉包碰 document，且都在 mount／匯出時才被呼叫；import 本檔不碰 DOM。
// shared 的 tsconfig 未設 lib（TS 預設含 DOM 型別），這裡刻意不加 reference directive。
//
// 媒體／嵌入 URL 判斷規則（`isAllowedEmbedUrl`／`isSafeMediaUrl`／`safeMediaUrl` 共用）：只認
// http(s)；相對網址在 `isSafeMediaUrl` 放行（自家上傳是 `/api/uploads/<id>`）；空字串在
// `isSafeMediaUrl` 一律放行（交給 BlockNote「還沒有檔案」的 placeholder）；`data:`／
// `javascript:`／`file:`／`blob:` 等危險 scheme 一律擋；`isAllowedEmbedUrl`（Embed tab
// 輸入端）嚴格：不自動補 scheme、只收絕對 http(s)，沒有 `base`——空字串在這條同樣被擋
// （`isAllowedEmbedUrl("")` 為 `false`，web `media-url.test.ts` 釘住）。
//
// `base` 必填、shared 不碰 `window`：web 端包裝補 `window.location.href`（見
// `apps/web/src/lib/media-url.ts`），server 端傳 jsdom 的 url（`PUBLIC_URL` origin）。
//
// 本檔的 config 與 web 的 `noteSchema`（`apps/web/src/collab/schema.ts`）靠
// `apps/web/src/collab/schema.test.ts` 的 parity 三案同步：改任一邊都要跑那三案。
import {
  BlockNoteSchema, createBlockSpec, createCodeBlockSpec, createInlineContentSpec, defaultBlockSpecs, defaultInlineContentSpecs,
  type CodeBlockOptions,
} from "@blocknote/core";

export const MERMAID_LANGUAGE = "mermaid";
export const mermaidBlockConfig = { type: MERMAID_LANGUAGE, content: "none", propSchema: { code: { default: "" } } } as const;
export const wikilinkConfig = { type: "wikilink", content: "none", propSchema: { targetNoteId: { default: "" }, snapshotTitle: { default: "" } } } as const;

// 原 code-highlight.ts 的 SUPPORTED_LANGUAGES 整份搬來（值逐字不變、型別同）；web 再疊 createHighlighter。
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
/** 嵌入（iframe／外部圖）只收絕對 http(s)：刻意不補 scheme、不吃 base（web media-url.test.ts:21-23 釘住）。 */
export function isAllowedEmbedUrl(raw: string): boolean { return resolvesToHttp(raw, undefined); }
// base 必填：shared 沒有 window；web 的包裝補 window.location.href、server 傳 jsdom 的 url（PUBLIC_URL origin）。
// base 錯了會把相對的 /api/uploads/<id> 消毒成 about:blank（spec round 7 C-2）。
export function isSafeMediaUrl(raw: string, base: string): boolean { return raw === "" ? true : resolvesToHttp(raw, base); }
export function safeMediaUrl(raw: string, base: string): string { return isSafeMediaUrl(raw, base) ? raw : BLOCKED_MEDIA_URL; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例，同 apps/web/src/collab/schema.ts）
type FileBlockSpecLike = { implementation: { toExternalHTML?: (this: any, block: any, ...rest: any[]) => unknown } };
/**
 * 檔案類 block 匯出前先把 props.url 過 safeMediaUrl（@see #43）：換 props 而非改回傳的 DOM，因為 data-url 也在委派的
 * 原實作裡吐出；`this` 與 `...rest` 原樣轉發，防上游改版。
 */
export function withGuardedExternalHTML<Spec extends FileBlockSpecLike>(spec: Spec, base: string): Spec {
  const original = spec.implementation.toExternalHTML;
  if (!original) return spec;
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
      toExternalHTML(this: unknown, block: any, ...rest: any[]) {
        return original.call(this, { ...block, props: { ...block.props, url: safeMediaUrl(block.props.url, base) } }, ...rest);
      },
    },
  } as Spec;
}

/** server 的 headless schema：與 web `noteSchema` 同 config；render／toExternalHTML 用 DOM API 造與 web 同形的節點。 */
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
  })(); // createBlockSpec 回 factory；createInlineContentSpec 直接回 spec（0.52.1 d.ts 核實）
  const wikilinkSpec = createInlineContentSpec(wikilinkConfig, {
    render: () => ({ dom: document.createElement("span") }),
    toExternalHTML: ic => {
      const span = document.createElement("span");
      span.textContent = `[[${ic.props.snapshotTitle}]]`;
      return { dom: span };
    },
  });
  return BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      audio: withGuardedExternalHTML(defaultBlockSpecs.audio, base),
      file: withGuardedExternalHTML(defaultBlockSpecs.file, base),
      image: withGuardedExternalHTML(defaultBlockSpecs.image, base),
      video: withGuardedExternalHTML(defaultBlockSpecs.video, base),
      mermaid: mermaidSpec,
      codeBlock: createCodeBlockSpec(CODE_BLOCK_BASE_OPTIONS),
    },
    inlineContentSpecs: { ...defaultInlineContentSpecs, wikilink: wikilinkSpec },
  });
}
