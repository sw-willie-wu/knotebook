import { BlockNoteSchema, createCodeBlockSpec, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { columnBlockSpec, columnListBlockSpec, withGuardedExternalHTML, withKnowledgeProps, withoutKnowledgeInExternalHTML } from "@knotebook/shared";
import { CODE_BLOCK_OPTIONS } from "@/lib/code-highlight";
import { mermaidSpec } from "@/components/mermaid/spec";
import { wikilinkSpec } from "@/components/wikilink/spec";
import { withColumnsLayout } from "./columns/layout-extension";

// Media data URLs must never reach block props: BlockNote turns pasted images into data URLs
// when there is no `uploadFile`, and that base64 would bloat the Y.Doc, `note_states` and backups.
// Plain image files go through `uploadFile` (never base64); `classifyMediaTransfer` blocks the
// rest (data URLs with no real `File`, e.g. an image copied from a web page). audio/video/file
// blocks have no Upload tab and only embed URLs, so the guard doesn't distinguish types.

/**
 * #43: file-type blocks' `toExternalHTML` (clipboard copy, drag `text/html`, markdown export)
 * reads the raw `props.url` (`@blocknote/core` 0.52.1: `el.src = props.url` / `a.href = props.url`),
 * which the render-side `safeMediaUrl` hook on `resolveFileUrl` doesn't cover; a tainted block
 * copied into another app would carry `javascript:` hrefs out.
 * `withGuardedExternalHTML` (in shared, also used by the headless schema) swaps only `props.url`
 * for `safeMediaUrl`.
 *
 * Relies on three things, each pinned by a test: the exporter reads the spec from the editor's
 * schema (`schema.test.ts` #43 end-to-end group); the editor receives `noteSchema` itself (`NoteEditor.test.ts`); the file-type blocks
 * are exactly audio/file/image/video (`meta.fileBlockAccept` parity test). A red one after a BlockNote
 * upgrade means one of these changed.
 *
 * The private `blocknote/html` clipboard format still carries the raw `data-url`; only BlockNote
 * can read it and pasting back hits the render guard, so it is left alone.
 */

/**
 * `BlockNoteSchema.create` treats `inlineContentSpecs` as a full override: dropping the
 * `...defaultInlineContentSpecs` spread silently breaks `text`/`link` (even basic typing) with no type error.
 */
export const noteSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    heading: withoutKnowledgeInExternalHTML(withKnowledgeProps(defaultBlockSpecs.heading)),
    audio: withGuardedExternalHTML(defaultBlockSpecs.audio, window.location.href),
    file: withGuardedExternalHTML(defaultBlockSpecs.file, window.location.href),
    image: withGuardedExternalHTML(defaultBlockSpecs.image, window.location.href),
    video: withGuardedExternalHTML(defaultBlockSpecs.video, window.location.href),
    // `createReactBlockSpec` returns a factory (unlike `createReactInlineContentSpec`), so the call parentheses are required.
    mermaid: mermaidSpec(),
    // #96: `defaultBlockSpecs.codeBlock` is created with no options (no languages, no highlighter);
    // they are sealed in the spec closure with no editor-level option (checked on 0.52.1), so this is the only wiring point.
    codeBlock: createCodeBlockSpec(CODE_BLOCK_OPTIONS),
    // Applied only to web's schema; returns a new object so shared's spec (used by the headless schema) is unchanged.
    columnList: withColumnsLayout(columnListBlockSpec),
    column: columnBlockSpec,
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, wikilink: wikilinkSpec },
});

export type NoteSchema = typeof noteSchema;

/**
 * Only image/video/audio families: the text "data:" in ordinary prose must not be blocked. The
 * prefix matches plain-text pastes and `src="data:…"` inside HTML fragments.
 */
const MEDIA_DATA_URL_RE = /(?:^|[\s"'(=])data:(?:image|video|audio)\/[a-z0-9.+-]+[;,]/i;

export function containsMediaDataUrl(text: string | null | undefined): boolean {
  return typeof text === "string" && MEDIA_DATA_URL_RE.test(text);
}

export type BlockedTransferReason = "dataUrl" | "textRepresentation" | "nonImageFile";

// `vscode-editor-data` is left out: it only uses `text/plain` to build a code block and never carries a media data URL.
const MEDIA_DATA_URL_TEXT_FORMATS = ["text/html", "text/plain", "text/markdown", "blocknote/html"] as const;

/**
 * Hand copy of the first five entries of BlockNote's unexported `acceptedMIMETypes`
 * (`@blocknote/core/src/api/clipboard/fromClipboard/acceptedMIMETypes.ts`), without the trailing
 * `"Files"`. No test catches upstream drift (not in the package exports map): compare against
 * that file when upgrading `@blocknote/core`.
 */
export const TEXT_REPRESENTATION_MIME_TYPES = [
  "vscode-editor-data",
  "blocknote/html",
  "text/markdown",
  "text/html",
  "text/plain",
] as const;

/**
 * Rules in order, first match wins; `null` = allow:
 * - A media data URL in any scanned text format → `"dataUrl"`, checked before the file rules:
 *   even with a file entry, an embedded data URL makes BlockNote put it in block props.
 * - A `File` plus any `TEXT_REPRESENTATION_MIME_TYPES` type → `"textRepresentation"`:
 *   BlockNote's `handleFileInsertion` abandons the file path when these rank before `"Files"`;
 *   same criterion, blocked uniformly.
 * - Files, all `image/*` (empty `File.type` isn't) → allow: they create no data URL and go through `uploadFile`.
 * - Any other file → `"nonImageFile"`.
 */
export function classifyMediaTransfer(data: DataTransfer | null | undefined): BlockedTransferReason | null {
  if (!data) return null;

  for (const format of MEDIA_DATA_URL_TEXT_FORMATS) {
    if (containsMediaDataUrl(data.getData(format))) return "dataUrl";
  }

  const files = data.files;
  const hasFiles = !!files && files.length > 0;
  if (!hasFiles) return null;

  const types = Array.from(data.types ?? []);
  if (TEXT_REPRESENTATION_MIME_TYPES.some((mimeType) => types.includes(mimeType))) return "textRepresentation";

  const fileList = Array.from(files as unknown as ArrayLike<File>);
  const allImages = fileList.every((file) => file.type.startsWith("image/"));
  return allImages ? null : "nonImageFile";
}
