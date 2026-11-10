import { isCustomColor } from "@knotebook/shared";

export const RECENT_COLORS_KEY = "knotebook:recent-colors";
export const RECENT_COLORS_MAX = 8;

// Last known list. Reads come from here; it is the only copy when storage is
// unavailable (private mode) or unwritable.
let memory: string[] | null = null;

/** Stored list, or null when storage cannot be read at all. */
function load(): string[] | null {
  try {
    const raw = localStorage.getItem(RECENT_COLORS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(isCustomColor))].slice(0, RECENT_COLORS_MAX);
  } catch {
    return null;
  }
}

/** Recently applied custom colors, newest first. */
export function readRecentColors(): string[] {
  if (memory === null) memory = load() ?? [];
  return [...memory];
}

/** Records a canonical `#rrggbb`; anything else is ignored. Returns the new list. */
export function pushRecentColor(hex: string): string[] {
  if (!isCustomColor(hex)) return readRecentColors();
  // Re-read storage so colors another tab recorded meanwhile are kept.
  const base = load() ?? memory ?? [];
  memory = [hex, ...base.filter((c) => c !== hex)].slice(0, RECENT_COLORS_MAX);
  try {
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(memory));
  } catch {
    // storage unavailable: the in-memory list is all we keep
  }
  return [...memory];
}

export function resetRecentColorsForTest(): void {
  memory = null;
}
