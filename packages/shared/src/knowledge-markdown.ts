import type { KnowledgeInfo } from "./knowledge.js";

export const KNOWLEDGE_COMMENT_MARK = "knotebook:knowledge";

export type KnowledgeCommentKey = "id" | "when" | "conclusion" | "evidence" | "verified" | "status" | "superseded_by";
export const KNOWLEDGE_COMMENT_KEYS: readonly KnowledgeCommentKey[] = ["id", "when", "conclusion", "evidence", "verified", "status", "superseded_by"];

export type KnowledgeCommentProblem =
  | "not_multiline" | "bad_line" | "duplicate_key" | "bad_value" | "unstorable" | "blank_line_missing" | "two_comments" | "unclosed"
  | "too_long" | "line_break" | "bad_id" | "bad_evidence" | "bad_status" | "bad_date" | "bad_ref"
  | "empty" | "superseded_required" | "superseded_self";

/** Raw strings as written (after decoding); `evidence: unconfirmed` is already mapped to "". Values are not checked here. `id` null = the line was left out. */
export interface KnowledgeCommentFields {
  id: string | null;
  when: string;
  conclusion: string;
  evidence: string;
  verified: string;
  status: string;
  supersededBy: string;
}

export interface KnowledgeProblem {
  problem: KnowledgeCommentProblem;
  key?: KnowledgeCommentKey;
  /** Plain text of the heading, not cut. */
  heading: string;
}

// `--` is quoted as a whole so neither `-->` nor `--!>` (which HTML also treats as a comment end) can appear.
// Lone surrogates are quoted because JSON.stringify escapes them, which keeps the text well-formed.
const NEEDS_QUOTES = /[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]|--|\p{Surrogate}/u;
// JSON.stringify leaves these raw; `>` is escaped so `--!>` cannot end the comment early.
const EXTRA_ESCAPES = /[>\u{7f}-\u{9f}\u{2028}\u{2029}]/gu;
const unicodeEscape = (c: string): string => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;

export function encodeKnowledgeValue(value: string): string {
  if (value === value.trim() && !value.startsWith('"') && !NEEDS_QUOTES.test(value)) return value;
  return JSON.stringify(value).replace(EXTRA_ESCAPES, unicodeEscape);
}

/** `raw` is the text after the colon, already trimmed. null: it starts with `"` but isn't exactly one JSON string. */
export function decodeKnowledgeValue(raw: string): string | null {
  if (!raw.startsWith('"')) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function formatKnowledgeComment(info: KnowledgeInfo): string {
  const values: Record<KnowledgeCommentKey, string> = {
    id: info.id,
    when: info.when,
    conclusion: info.conclusion,
    evidence: info.evidence,
    verified: info.verified,
    status: info.status,
    superseded_by: info.supersededBy,
  };
  const lines = [`<!-- ${KNOWLEDGE_COMMENT_MARK}`];
  for (const key of KNOWLEDGE_COMMENT_KEYS) if (values[key] !== "") lines.push(`${key}: ${encodeKnowledgeValue(values[key])}`);
  lines.push("-->");
  return lines.join("\n");
}

const MARK_START = /^\s*knotebook:knowledge(\s|$)/;
/** `data` is a Comment node's data: the text between `<!--` and `-->`. */
export function isKnowledgeCommentData(data: string): boolean {
  return MARK_START.test(data);
}

const KEY_RE = /^[a-z_]+$/;
const FIELD_OF: Record<KnowledgeCommentKey, keyof KnowledgeCommentFields> = {
  id: "id",
  when: "when",
  conclusion: "conclusion",
  evidence: "evidence",
  verified: "verified",
  status: "status",
  superseded_by: "supersededBy",
};
const isKnownKey = (key: string): key is KnowledgeCommentKey => Object.hasOwn(FIELD_OF, key);

export function parseKnowledgeComment(
  data: string,
): { ok: true; fields: KnowledgeCommentFields } | { ok: false; problem: KnowledgeCommentProblem; key?: KnowledgeCommentKey } {
  const lines = data.split(/\r\n|\r|\n/);
  if (lines.length < 2 || lines[0]!.trim() !== KNOWLEDGE_COMMENT_MARK) return { ok: false, problem: "not_multiline" };
  let end = lines.length;
  while (end > 1 && lines[end - 1]!.trim() === "") end -= 1;
  const fields: KnowledgeCommentFields = { id: null, when: "", conclusion: "", evidence: "", verified: "", status: "", supersededBy: "" };
  const seen = new Set<string>();
  for (let i = 1; i < end; i += 1) {
    const line = lines[i]!.trimStart();
    const colon = line.indexOf(":");
    if (colon === -1) return { ok: false, problem: "bad_line" };
    const key = line.slice(0, colon).trimEnd();
    if (!KEY_RE.test(key)) return { ok: false, problem: "bad_line" };
    if (!isKnownKey(key)) continue;
    if (seen.has(key)) return { ok: false, problem: "duplicate_key", key };
    seen.add(key);
    const value = decodeKnowledgeValue(line.slice(colon + 1).trim());
    if (value === null) return { ok: false, problem: "bad_value", key };
    if (value.includes("\u0000") || /\p{Surrogate}/u.test(value)) return { ok: false, problem: "unstorable", key };
    if (key === "id") fields.id = value === "" ? null : value;
    else if (key === "evidence") fields.evidence = value === "unconfirmed" ? "" : value;
    else fields[FIELD_OF[key] as Exclude<keyof KnowledgeCommentFields, "id">] = value;
  }
  return { ok: true, fields };
}
