/** Bytes, not UTF-16 code units: numerically equal to `MD` in notes/schemas.ts but never merge them (262,144 code units of CJK is ~786 KB of UTF-8 and hits this 413 before zod's 400). */

export const WRITE_BODY_LIMIT = 262_144;

/** Bytes → 413 content_too_large. Lowered from 1 MiB to WRITE_BODY_LIMIT because full parse cost isn't linear in size (a 1 MiB file dense in inline formatting takes 9–22 s; 256 KiB at most ~5 s in the shapes tried). Separate name because the export's tooLargeToSend flag and the write-back route read it. */
export const TRANSFER_WRITE_BODY_LIMIT = WRITE_BODY_LIMIT;

/** Bytes → 413 content_too_large. 4,000 code points of body, a 200-code-point quote and the JSON envelope fit with room to spare even when every character is a control character escaped to six bytes. */
export const COMMENT_BODY_LIMIT = 65_536;
