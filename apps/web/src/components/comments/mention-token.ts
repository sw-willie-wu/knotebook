import { parseMentionSpans } from "@knotebook/shared";

export interface MentionToken {
  /** UTF-16 offset of the `@`. */
  start: number;
  /** UTF-16 offset of the caret; a pick replaces `start..end`. */
  end: number;
  /** Lowercased; empty right after a bare `@`. */
  handle: string;
  /** Text after `/`; null when no `/` was typed. */
  label: string | null;
}

const LABEL_CHAR = /[A-Za-z0-9._-]/;

/** The `@…` being typed: the one that ends exactly at the caret, found with the same parser the server uses (`請@bob` counts). */
export function mentionTokenAt(text: string, caret: number): MentionToken | null {
  const before = text.slice(0, caret);
  const cps = [...before];
  const utf16 = (cpIndex: number) => cps.slice(0, cpIndex).join("").length;
  const last = parseMentionSpans(before).at(-1);
  if (last !== undefined) {
    const end = last.start + last.length;
    if (end === cps.length) return { start: utf16(last.start), end: caret, handle: last.handle, label: last.label };
    if (end === cps.length - 1 && cps[end] === "/" && last.label === null) return { start: utf16(last.start), end: caret, handle: last.handle, label: "" };
  }
  // The parser needs at least one handle character, so a bare `@` is recognised here.
  if (cps.at(-1) === "@" && (cps.length === 1 || !LABEL_CHAR.test(cps.at(-2)!))) return { start: utf16(cps.length - 1), end: caret, handle: "", label: null };
  return null;
}
