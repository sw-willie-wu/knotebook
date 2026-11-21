/** Keys in fixed order (knotebook, id, title, role, base, url). `title` is always `JSON.stringify`'d so it stays one line; a value starting with `"` is read with `JSON.parse`, round-tripping exactly. The body follows the second `---` unnormalized. */
import { UUID_RE } from "@knotebook/shared";
import { normalizeBody } from "./normalize.js";
import { parseNoteTags, serializeNoteTags } from "./note-tags-format.js";

export const TRANSFER_FILE_VERSION = 1;

/** The closing `---` must be within the first 200 lines. */
export const FRONTMATTER_SCAN_LINES = 200;

export type ReadFile =
  | { kind: "existing"; id: string; base: string; title: string | undefined; tags: string[] | undefined; body: string }
  | { kind: "new"; title: string | undefined; folderId: string | undefined; tags: string[] | undefined; body: string }
  | { kind: "error"; message: string };

export function parseScalar(raw: string): { ok: true; value: string } | { ok: false } {
  if (raw.startsWith('"')) {
    try {
      const v: unknown = JSON.parse(raw);
      return typeof v === "string" ? { ok: true, value: v } : { ok: false };
    } catch {
      return { ok: false };
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return { ok: true, value: raw.slice(1, -1).replace(/''/g, "'") };
  return { ok: true, value: raw };
}

const READ_KEYS = ["id", "base", "title", "folder_id", "tags"] as const;
type ReadKey = (typeof READ_KEYS)[number];
const BASE_RE = /^[0-9a-f]{16}$/;
/** Not `isWellFormed()`, which ignores NUL. */
const UNSTORABLE = /[\0]|\p{Surrogate}/u;

const bad = (message: string): ReadFile => ({ kind: "error", message });
/** `base` is included so a base without an id is caught. */
const MARKER_LINE = /^(?:knotebook|id|base)[ \t]*:/;
/** A `base` without an `id` would be created as a new note (an extra note), so it is a 400. */
export const BASE_WITHOUT_ID_MESSAGE = "The front matter has a base but no id. This is a downloaded file: keep its original id line and send it again.";
export const UNCLOSED_FRONT_MATTER_MESSAGE =
  "The front matter has no closing `---`: the file starts with `---` and has a `knotebook:`, `id:` or `base:` line (spaces allowed before the colon) in its first 200 lines, but no `---` line closes it.";

/** All pure and before any DB query; error messages carry no values. */
export function readNoteFile(text: string): ReadFile {
  const s = text.replace(/^\ufeff/, "").replace(/\r\n/g, "\n");
  if (s.includes("\0")) return bad("The file contains a NUL character.");
  const lines = s.split("\n");
  let end = -1;
  if (s.startsWith("---\n")) {
    const limit = Math.min(lines.length, FRONTMATTER_SCAN_LINES);
    for (let i = 1; i < limit; i++) {
      if (lines[i] === "---") {
        end = i;
        break;
      }
    }
    if (end !== -1 && !lines.slice(1, end).some(l => MARKER_LINE.test(l))) end = -1;
    // An unclosed front matter is a 400: treating the file as body would create a stray note or write front matter into an existing one.
    else if (end === -1 && lines.slice(1, limit).some(l => MARKER_LINE.test(l))) return bad(UNCLOSED_FRONT_MATTER_MESSAGE);
  }
  if (end === -1) return { kind: "new", title: undefined, folderId: undefined, tags: undefined, body: normalizeBody(s) };

  const vals = new Map<ReadKey, string>();
  let tags: string[] | undefined;
  for (const l of lines.slice(1, end)) {
    const c = l.indexOf(":");
    if (c === -1) continue;
    const k = l.slice(0, c).trimEnd();
    if (!(READ_KEYS as readonly string[]).includes(k)) continue;
    const key = k as ReadKey;
    if (vals.has(key)) return bad(`The front matter has \`${key}\` more than once.`);
    if (key === "tags") {
      const t = parseNoteTags(l.slice(c + 1).trim());
      if (!t.ok) return bad(t.message);
      tags = t.tags;
      vals.set(key, "");
      continue;
    }
    const p = parseScalar(l.slice(c + 1).trim());
    if (!p.ok || UNSTORABLE.test(p.value)) return bad(`The front matter's \`${key}\` is malformed.`);
    vals.set(key, p.value);
  }
  const title = vals.get("title");
  if (title === "") return bad("The front matter's `title` can't be empty.");
  const body = normalizeBody(lines.slice(end + 1).join("\n"));
  const id = vals.get("id");
  if (id !== undefined) {
    const lid = id.toLowerCase();
    if (!UUID_RE.test(lid)) return bad("The front matter's `id` is malformed.");
    const base = vals.get("base");
    if (base === undefined) return bad("A file with an id must also have a base.");
    if (!BASE_RE.test(base)) return bad("The front matter's `base` is malformed.");
    return { kind: "existing", id: lid, base, title, tags, body };
  }
  if (vals.has("base")) return bad(BASE_WITHOUT_ID_MESSAGE);
  const folder = vals.get("folder_id");
  let folderId: string | undefined;
  if (folder !== undefined) {
    folderId = folder.toLowerCase();
    if (!UUID_RE.test(folderId)) return bad("The front matter's `folder_id` is malformed.");
  }
  return { kind: "new", title, folderId, tags, body };
}

export function writeNoteFile(fm: { id: string; title: string; role: string; base: string; url: string; tags: readonly string[] }, body: string): string {
  return (
    "---\n" +
    `knotebook: ${TRANSFER_FILE_VERSION}\n` +
    `id: ${fm.id}\n` +
    `title: ${JSON.stringify(fm.title)}\n` +
    `${serializeNoteTags(fm.tags)}\n` +
    `role: ${fm.role}\n` +
    `base: ${fm.base}\n` +
    `url: ${fm.url}\n` +
    "---\n" +
    body
  );
}
