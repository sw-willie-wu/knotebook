/**
 * Wire size is about 2.1 × payload: the mirrored text repeats the payload, JSON-escaped. The
 * overall 262 144 sentinel lives in `test/mcp-size.test.ts`; exceeding it means a per-field
 * limit below was missed, not that the sentinel should be raised. Measure the wire response,
 * not the payload, or the mirror's cost disappears from the sentinel.
 */

/** Counted after JSON escaping (UTF-16 code units, excluding quotes). */
export const MCP_TEXT_MAX = 200;
export const MCP_PAGE_MAX = 100;
/** UTF-16 code units. */
export const MCP_SECTION_CHARS = 4000;
/** After JSON escaping; budget 158 plus one `…` on each side. */
export const MCP_SNIPPET_MAX = 160;

/** The production target at which search_notes stops adding matches, not the sentinel (262 144 in `test/mcp-size.test.ts`); the 22 144 gap is left for the JSON-RPC envelope and `id`. */
export const MCP_SEARCH_WIRE_BUDGET = 240_000;

/*
 * Worst-case wire sizes per item (mirrored copies and commas included), from
 * `test/mcp-size.test.ts`: list_notes 2 895, list_trash 3 761, list_folders 2 563 (about 93
 * would fit in the budget, one page holds 50), delete_folder response 8 376, read_comments 57 402,
 * list_notifications 14 394.
 */

/** JSON-escaped code units; names within 80 code points that need no escaping (including CJK) are never cut. */
export const MCP_FOLDER_NAME_MAX = 80;
export const MCP_FOLDER_PATH_MAX = 400;
/** Same value and reason as `MCP_SEARCH_WIRE_BUDGET`. */
export const MCP_LIST_WIRE_BUDGET = 240_000;
/** 50 leaves headroom under the wire budget, which is only the backstop. */
export const MCP_FOLDER_PAGE_MAX = 50;
export const MCP_DELETE_FOLDER_IDS_MAX = 100;

/** Matches well-formed `JSON.stringify` (scanned over 0x0000–0xFFFF in `test/unit/mcp-limits.test.ts`). C1, DEL and U+2028/2029 aren't escaped. A lone surrogate costs 6; a valid pair is counted by `stepAt` as 2. */
function escapedUnitCost(code: number): number {
  if (code < 0x20) return code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
  if (code === 0x22 || code === 0x5c) return 2;
  if (code >= 0xd800 && code <= 0xdfff) return 6;
  return 1;
}

function stepAt(s: string, i: number): { cost: number; width: 1 | 2 } {
  const code = s.charCodeAt(i);
  const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
  const isPair = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return isPair ? { cost: 2, width: 2 } : { cost: escapedUnitCost(code), width: 1 };
}

export function escapedLength(s: string): number {
  let cost = 0;
  for (let i = 0; i < s.length; ) {
    const st = stepAt(s, i);
    cost += st.cost;
    i += st.width;
  }
  return cost;
}

/**
 * Budgets the JSON-escaped cost: each field appears twice on the wire (structuredContent and
 * mirrored text), so cutting by raw length could exceed the wire limit. A surrogate pair is
 * kept or dropped whole (a lone surrogate serializes silently). Returns `truncated` so the
 * DTO `*Truncated` flags are decided in one place. Short fields only: `read_note_section`
 * uses `truncateCodeUnits` because newlines in markdown would make escaped counting cut
 * nearly every page below 4000 (`instructions` and docs promise 4000 characters); raw counting
 * is safe there: at most 13 wire units per code unit, about 52 000.
 */
export function truncateText(s: string, max: number = MCP_TEXT_MAX): { text: string; truncated: boolean } {
  let cost = 0;
  let i = 0;
  while (i < s.length) {
    const st = stepAt(s, i);
    if (cost + st.cost > max) return { text: s.slice(0, i), truncated: true };
    cost += st.cost;
    i += st.width;
  }
  return { text: s, truncated: false };
}

/** Raw length, backing off one unit when the cut falls inside a surrogate pair; `nextOffset` relies on the result being a prefix whose length is the advance. */
export function truncateCodeUnits(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  const code = s.charCodeAt(max - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return { text: s.slice(0, cut), truncated: true };
}

/**
 * 5 MiB: PNGs up to 10 MiB reached the client intact. The base64 (about 7 MB)
 * far exceeds the 262 144 wire sentinel; the image block is its only exemption.
 */
export const MCP_IMAGE_MAX_BYTES = 5_242_880;
