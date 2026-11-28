/** Only the bytes are trusted: extension and Content-Type are forgeable. `null` means reject; never fall back to the claimed extension. */
export type RasterImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const GIF_PREFIX = [0x47, 0x49, 0x46, 0x38];
const GIF_VERSION_37 = 0x37; // '7'
const GIF_VERSION_39 = 0x39; // '9'
const GIF_SUFFIX_A = 0x61; // 'a'
// RIFF alone doesn't mean WEBP (AVI/WAV use it too); the "WEBP" at offset 8 decides.
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46];
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50];
const WEBP_OFFSET = 8;

function matchesAt(bytes: Uint8Array, signature: readonly number[], offset: number): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/** Magic-byte detection for raster formats only (never accepts SVG). */
export function detectRasterImageMimeType(bytes: Uint8Array): RasterImageMimeType | null {
  if (matchesAt(bytes, PNG_SIGNATURE, 0)) return "image/png";
  if (matchesAt(bytes, JPEG_SIGNATURE, 0)) return "image/jpeg";
  if (
    matchesAt(bytes, GIF_PREFIX, 0) &&
    (bytes[4] === GIF_VERSION_37 || bytes[4] === GIF_VERSION_39) &&
    bytes[5] === GIF_SUFFIX_A
  ) {
    return "image/gif";
  }
  if (matchesAt(bytes, RIFF_SIGNATURE, 0) && matchesAt(bytes, WEBP_SIGNATURE, WEBP_OFFSET)) return "image/webp";
  return null;
}
