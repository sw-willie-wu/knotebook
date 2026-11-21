/**
 * #27, #28: BlockNote 0.52 parses plain-text markdown, but two cases break on Windows.
 * - CRLF isn't normalized by `pasteMarkdown` → `markdownToHTML` (the Windows clipboard `text/plain` is always CRLF): a list becomes `<p>- …</p>` and a fence a literal ```` ```bash ````.
 *   BlockNote's own `handleVSCodePaste` normalizes, the generic path doesn't.
 * - VS Code attaches a private `vscode-editor-data` format that ranks first, so the whole paste is wrapped in `<pre><code class="language-markdown">`.
 * Handing back to `defaultPasteHandler()` doesn't mean the HTML path: `prioritizeMarkdownOverHTML` defaults to true and `text/markdown` also outranks `text/html`, so the decision must look at the content.
 * Hand back forcing HTML (`{ prioritizeMarkdownOverHTML: false }`) when the HTML is itself a code block (a docs-site Dockerfile whose `# syntax=…` + blank line reads as a heading to markdown);
 * hand back unchanged for in-app copies, files, non-markdown VS Code pastes, the cursor inside a code block, and HTML whose text has no markdown structure.
 */

import { collectBlockIds, convertPastedMermaidBlocks, type MermaidPasteEditor } from "./mermaid-paste";

// `mode` is a VS Code languageId (`.md` gives `markdown`); `md` doesn't occur in practice and `mdx` only with the MDX extension, but both are harmless.
// Not covered, so still code blocks: `quarto`, `rmd`, `mdc`, and `plaintext` when there is no language association.
const MARKDOWN_LANGUAGE_MODES = new Set(["markdown", "md", "mdx"]);

const ALWAYS_DELEGATE_TYPES = ["blocknote/html", "Files"];

/**
 * Structural evidence of a markdown document, deliberately much higher than one line-start marker: taking over on a single marker corrupts snippets copied from docs sites
 * (a `# comment` shell/YAML snippet becomes `<h1>` without indentation, a `- old` / `+ new` diff becomes a list) where the `<pre><code>` HTML is the better source.
 * Only applies when the clipboard also has HTML.
 * Invariant: must be a strict subset of BlockNote's `isMarkdown`, so "we take over" only means "BlockNote's own decision plus line-ending normalization" and can't pull anything away from the HTML path;
 * a false negative merely leaves #28 unfixed for that shape. `paste.subset.test.ts` checks it against the installed BlockNote (not copied here: MPL-2.0); keep it green when changing a pattern.
 */
const MARKDOWN_STRUCTURE_PATTERNS = [
  // Heading, blank line, content. The heading text is length-capped: a long `#` comment in a Dockerfile/nginx conf is not a heading.
  /^ {0,3}#{1,6} {1,8}\S[^\n]{0,62}\n\n[ \t]{0,32}\S/m,
  // Only `-`: `*` would turn C-style block comment continuation lines into a list and `+` the added side of a diff.
  /^ {0,3}- \S[^\n]*\n {0,3}- \S/m,
  // Only `.`: `)` would match shell `case` branches (`1) …`).
  /^ {0,3}\d+\. \S[^\n]*\n {0,3}\d+\. \S/m,
  /^(```|~~~)(?!`|~)[^\n]{0,64}\n[\s\S]{0,9999}?\n\1 {0,64}(?:\n|$)/m,
  // The leading `|` is required: psql/CLI output like `-----|-------` doesn't count.
  /^ {0,3}\|(\s*[-:]+[-:]\s*\|)+[ \t]*$/m,
];

export function hasMarkdownStructure(text: string): boolean {
  return MARKDOWN_STRUCTURE_PATTERNS.some((pattern) => pattern.test(text));
}

// `<pre><code>` is a docs-site snippet (the user wants a code block); a bare `<pre>` is a browser showing a plain-text file (no formatting info: parse as markdown). The whole HTML's text must be that `<code>`'s text.
export function isSingleCodeBlockHtml(html: string): boolean {
  if (!html.includes("<pre")) return false;

  const body = new DOMParser().parseFromString(html, "text/html").body;
  const codeBlocks = body.querySelectorAll("pre > code");
  if (codeBlocks.length !== 1) return false;

  return body.textContent?.trim() === codeBlocks[0]?.textContent?.trim();
}

function shouldForceHtmlPaste(data: DataTransfer | null): boolean {
  if (!data) return false;
  const types = Array.from(data.types ?? []);
  if (!types.includes("text/html")) return false;

  try {
    return isSingleCodeBlockHtml(data.getData("text/html"));
  } catch {
    return false;
  }
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function vscodeMode(data: DataTransfer): string | null {
  const raw = data.getData("vscode-editor-data");
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const mode = (parsed as { mode?: unknown } | null)?.mode;
    return typeof mode === "string" ? mode : null;
  } catch {
    return null;
  }
}

export function decideMarkdownPaste(data: DataTransfer | null, isInCodeBlock: boolean): string | null {
  if (!data || isInCodeBlock) return null;

  const mode = vscodeMode(data);
  if (mode !== null && !MARKDOWN_LANGUAGE_MODES.has(mode)) return null; // e.g. python: stays a code block

  const types = Array.from(data.types ?? []);
  if (ALWAYS_DELEGATE_TYPES.some((type) => types.includes(type))) return null;

  const explicitMarkdown = data.getData("text/markdown");
  const source = normalizeLineEndings(explicitMarkdown || data.getData("text/plain"));

  // Whitespace-only makes `markdownToHTML` return "" and `pasteHTML` bail out, so the paste would silently do nothing; handing back keeps the existing behavior.
  if (source.trim() === "") return null;

  // VS Code markdown and explicit `text/markdown` need no content check (VS Code always attaches `text/html` along with `mode`, hence the exception).
  // Handing explicit `text/markdown` back would let BlockNote parse it un-normalized, and it outranks HTML.
  if (mode !== null || explicitMarkdown) return source;

  if (types.includes("text/html")) {
    if (shouldForceHtmlPaste(data)) return null;
    if (!hasMarkdownStructure(source)) return null;
  }

  return source;
}

// The callback parameter must be a shape the ProseMirror `Transaction` satisfies, not `never`: parameters are contravariant, and `never` would degrade the inference of
// `withCollaboration<Options extends Partial<BlockNoteEditorOptions>>` to the constraint itself, dropping `collaboration` from the return type (the error then surfaces in other files).
interface PasteResolvedPos {
  parent: { type: { spec: { code?: boolean } } };
}

interface PasteTransaction {
  selection: { $from: PasteResolvedPos; $to: PasteResolvedPos };
}

interface PasteTargetEditor extends MermaidPasteEditor {
  pasteMarkdown: (markdown: string) => void;
  transact: <T>(callback: (tr: PasteTransaction) => T) => T;
}

type DefaultPasteHandler = (options?: {
  prioritizeMarkdownOverHTML?: boolean;
  plainTextAsMarkdown?: boolean;
}) => boolean | undefined;

// Same check as BlockNote's default flow (`$from` and `$to` parents both `spec.code`).
// Not `getTextCursorPosition()`: it converts the surrounding blocks via `nodeToBlock` (a dozen throw points), and a throw here silently disables the whole paste.
function isCursorInCodeBlock(editor: PasteTargetEditor): boolean {
  return editor.transact(
    ({ selection }) => selection.$from.parent.type.spec.code === true && selection.$to.parent.type.spec.code === true,
  );
}

/** `before` runs before the paste inserts anything; `after` after the insertion and the mermaid conversion. Errors thrown by either are swallowed; they only skip the conversion. */
export interface PasteConversionHook {
  before(editor: unknown): unknown;
  after(editor: unknown, snapshot: unknown): void;
}

/** Runs the hooks in the order given; a hook whose `before` threw or returned `undefined` is skipped in `after`, as for a single hook. */
export function combinePasteHooks(...hooks: PasteConversionHook[]): PasteConversionHook {
  return {
    before(editor) {
      return hooks.map((hook) => {
        try {
          return hook.before(editor);
        } catch {
          return undefined;
        }
      });
    },
    after(editor, snapshot) {
      const snapshots = snapshot as unknown[];
      hooks.forEach((hook, index) => {
        if (snapshots[index] === undefined) return;
        try {
          hook.after(editor, snapshots[index]);
        } catch {
          // A failing conversion must not stop the next one.
        }
      });
    },
  };
}

// BlockNote calls `event.preventDefault()` before this handler, so an uncaught exception makes the paste do nothing: the body is wrapped in try/catch and falls back to the default flow.
export function createMarkdownPasteHandler(hook?: PasteConversionHook) {
  return ({
    event,
    editor,
    defaultPasteHandler,
  }: {
    event: ClipboardEvent;
    editor: PasteTargetEditor;
    defaultPasteHandler: DefaultPasteHandler;
  }): boolean | undefined => {
    let markdown: string | null = null;
    try {
      markdown = decideMarkdownPaste(event.clipboardData, isCursorInCodeBlock(editor));
    } catch {
      markdown = null;
    }

    // #94: snapshot ids so only blocks newly inserted by this paste are converted (see `mermaid-paste.ts`); on failure skip the conversion, never affect the paste.
    let idsBeforePaste: Set<string> | null = null;
    try {
      idsBeforePaste = collectBlockIds(editor.document);
    } catch {
      idsBeforePaste = null;
    }
    const convertMermaid = (): void => {
      if (idsBeforePaste !== null) convertPastedMermaidBlocks(editor, idsBeforePaste);
    };

    let siteLinkSnapshot: unknown;
    try {
      siteLinkSnapshot = hook?.before(editor);
    } catch {
      siteLinkSnapshot = undefined;
    }
    const convertSiteLinks = (): void => {
      if (hook === undefined || siteLinkSnapshot === undefined) return;
      try {
        hook.after(editor, siteLinkSnapshot);
      } catch {
      }
    };

    // `defaultPasteHandler()` must stay outside the try and be called exactly once: it can throw itself (BlockNote runs an unguarded `JSON.parse` on `vscode-editor-data`);
    // inside the try the catch would call it a second time, throw again, and the paste would do nothing.
    if (markdown === null) {
      // If the HTML is itself a code block, prefer HTML, otherwise markdown-looking plain text wins and a `# comment` becomes a big heading.
      const options = shouldForceHtmlPaste(event.clipboardData) ? { prioritizeMarkdownOverHTML: false } : undefined;
      const handled = defaultPasteHandler(options);
      convertMermaid(); // the default flow can also insert ```mermaid (it parses plain text as markdown itself)
      convertSiteLinks();
      return handled;
    }

    try {
      editor.pasteMarkdown(markdown);
    } catch {
      // Some content may already be inserted, so don't fall back to the default flow (it would paste again on top); report handled.
    }
    convertMermaid();
    convertSiteLinks();
    return true;
  };
}
