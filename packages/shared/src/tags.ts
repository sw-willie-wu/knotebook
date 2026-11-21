import type { NotePermissions, Role } from "./note-dto.js";
import { canonicalColor, isCustomColor } from "./note-colors.js";

export const TAG_NAME_MAX = 40;
export const TAGS_PER_NOTE_MAX = 50;
export const TAGS_PER_SPACE_MAX = 1000;

// Yellow and gray last: yellow has the weakest contrast on light backgrounds and gray reads as disabled.
export const TAG_PRESET_COLORS = ["blue", "green", "orange", "purple", "pink", "red", "yellow", "brown", "gray"] as const;
export type TagPresetColor = (typeof TAG_PRESET_COLORS)[number];
/** Lowercase `#rrggbb`, the same form as a custom text color. */
export type TagCustomColor = `#${string}`;
export type TagColor = TagPresetColor | TagCustomColor;

const TAG_PRESET_SET: ReadonlySet<string> = new Set(TAG_PRESET_COLORS);

export function isTagPresetColor(v: unknown): v is TagPresetColor {
  return typeof v === "string" && TAG_PRESET_SET.has(v);
}

export function isTagColor(v: unknown): v is TagColor {
  return isTagPresetColor(v) || isCustomColor(v);
}

/** A preset name, or any form `canonicalColor` accepts for an opaque color (`#RGB`, `#rrggbbff`, `rgb()`), as stored; otherwise null. */
export function canonicalTagColor(v: unknown): TagColor | null {
  if (isTagPresetColor(v)) return v;
  const c = canonicalColor(v);
  return isCustomColor(c) ? (c as TagCustomColor) : null;
}

export interface NoteTagDto {
  id: string;
  name: string;
  color: TagColor;
}

export interface SpaceTagDto extends NoteTagDto {
  noteCount: number;
}

export interface NoteTagsDto {
  tags: NoteTagDto[];
}

/** `tag` is the one this request attached, or the one already on the note. */
export interface AddNoteTagResultDto extends NoteTagsDto {
  tag: NoteTagDto;
  /** False when the note already had the tag, so undoing the request must not remove it. */
  attached: boolean;
}

const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f]|\p{Cs}/u;

export function normalizeTagName(raw: string): string | null {
  const name = raw.normalize("NFC").trim();
  if (name.length === 0 || FORBIDDEN_CHARS.test(name)) return null;
  if ([...name].length > TAG_NAME_MAX) return null;
  return name;
}

export function pickTagColor(used: readonly string[]): TagPresetColor {
  const counts = new Map<string, number>(TAG_PRESET_COLORS.map((c) => [c, 0]));
  for (const u of used) counts.set(u, (counts.get(u) ?? 0) + 1);
  let best: TagPresetColor = TAG_PRESET_COLORS[0];
  let bestCount = Infinity;
  for (const c of TAG_PRESET_COLORS) {
    const n = counts.get(c)!;
    if (n < bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

// Personal notes: an edit share must not edit the owner's tag list, so edit permission alone is not enough.
export function canEditNoteTags(a: {
  role: Role;
  groupId: string | null;
  permissions: Pick<NotePermissions, "edit">;
}): boolean {
  return a.groupId === null ? a.role === "owner" : a.permissions.edit;
}
