import { normalizeTagName } from "@knotebook/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror view/node types can't be imported: prosemirror-state/-model aren't apps/web dependencies
type Any = any;

/** One name: `#` or full-width `＃`, then anything but whitespace; a name may contain `#` but not start with one. `\s` includes U+3000. */
export const HASH_TAG_RE = /^[#＃]([^\s#＃]\S*)$/u;
/** A whole line of names separated by whitespace, for pasting. */
export const HASH_TAG_LINE_RE = /^[#＃][^\s#＃]\S*(?:\s+[#＃][^\s#＃]\S*)*$/u;

export interface HashTagBatchInput {
  names: string[];
  /** False = the text could not be put back. */
  restore: () => boolean;
}

export interface HashTagHooks {
  applyHash: (input: HashTagBatchInput) => void;
  currentTagNames: () => readonly string[];
  /** Cuts the collaborative undo stack so what comes next is a step of its own. */
  undoBoundary: () => void;
  notify: (kind: "over_limit", info: { max: number }) => void;
  /** The live editor and view; `null` once the editor is gone. A restore only goes ahead for the same editor it was created for. */
  active: () => { editor: unknown; view: Any } | null;
}

export type HashTagHooksRef = { current: HashTagHooks | null };

/** Every name must pass the tag rules, or the whole line is not a tag line. */
export function parseHashTagLine(text: string): string[] | null {
  const line = text.trim();
  if (!HASH_TAG_LINE_RE.test(line)) return null;
  const names: string[] = [];
  for (const token of line.split(/\s+/u)) {
    const name = normalizeTagName(token.slice(1));
    if (name === null) return null;
    names.push(name);
  }
  return names;
}

// doc > blockGroup > blockContainer > paragraph
const TOP_LEVEL_BLOCK_DEPTH = 3;

/** Plain text only: marks or other inline nodes mean it is not the line that was taken out. */
function plainTextOf(paragraph: Any): string | null {
  let out = "";
  let plain = true;
  paragraph.forEach((child: Any) => {
    if (!child.isText || child.marks.length > 0) plain = false;
    else out += child.text;
  });
  return plain ? out : null;
}

/**
 * Puts text back at the very start of the document: into the first paragraph when it is empty, otherwise as a new paragraph in front.
 * Does nothing (still true) when the first paragraph already holds exactly that text, e.g. after Ctrl+Z brought it back.
 * Returns false instead of touching a document that belongs to another editor or a destroyed view.
 */
export function restoreFirstLine(hooks: HashTagHooksRef, editor: unknown, text: string): boolean {
  try {
    const h = hooks.current;
    const live = h?.active();
    if (!h || !live || live.editor !== editor || live.view.isDestroyed) return false;
    const view = live.view;
    const doc = view.state.doc;
    const first = doc.firstChild?.firstChild?.firstChild;
    if (first?.type.name === "paragraph" && first.content.size > 0 && plainTextOf(first) === text) return true;
    h.undoBoundary();
    const tr = view.state.tr;
    if (first?.type.name === "paragraph" && first.content.size === 0) {
      tr.insertText(text, TOP_LEVEL_BLOCK_DEPTH);
    } else {
      const { blockContainer, paragraph } = doc.type.schema.nodes;
      tr.insert(1, blockContainer.createAndFill(null, paragraph.create(null, doc.type.schema.text(text))));
    }
    view.dispatch(tr);
    h.undoBoundary();
    return true;
  } catch {
    return false;
  }
}

/**
 * `handleTextInput` hook: `#name` plus a space typed in the first top-level paragraph becomes a tag and the text disappears.
 * Judged on what the paragraph will contain once `[from, to)` is replaced by `text`, because IME commits and autocorrect arrive as multi-character replacements.
 * Not an input rule: those also run when composition ends.
 */
export function handleHashTagInput(view: Any, from: number, to: number, text: string, hooks: HashTagHooksRef): boolean {
  const h = hooks.current;
  if (!h || view.composing) return false;
  const state = view.state;
  if (state.selection.from !== from || state.selection.to !== to) return false;
  if (state.storedMarks && state.storedMarks.length > 0) return false;

  const $from = state.doc.resolve(from);
  if ($from.depth !== TOP_LEVEL_BLOCK_DEPTH || $from.parent.type.name !== "paragraph") return false;
  if ($from.node(1).type.name !== "blockGroup" || $from.index(1) !== 0) return false;
  if (to !== $from.end()) return false;

  const typed = state.doc.textBetween($from.start(), from) + text;
  const last = typed.slice(-1);
  if (last !== " " && last !== "　") return false;
  const body = typed.slice(0, -1);
  const match = HASH_TAG_RE.exec(body);
  if (!match) return false;

  let plain = true;
  $from.parent.forEach((child: Any) => {
    if (!child.isText || child.marks.length > 0) plain = false;
  });
  if (!plain) return false;

  const name = normalizeTagName(match[1]!);
  if (name === null) return false;

  const editor = h.active()?.editor;
  h.undoBoundary();
  view.dispatch(state.tr.delete($from.start(), to));
  h.undoBoundary();
  h.applyHash({ names: [name], restore: () => restoreFirstLine(hooks, editor, body) });
  return true;
}
