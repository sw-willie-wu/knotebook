const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Parses what a user types into the hex box and returns the canonical
 * `#rrggbb` (lowercase), or null when it is not a 3- or 6-digit hex value.
 * The leading `#` is optional; alpha digits and `rgb()` forms are rejected.
 */
export function parseHexInput(raw: string): string | null {
  const m = HEX_RE.exec(raw.trim());
  if (!m) return null;
  let digits = m[1].toLowerCase();
  if (digits.length === 3) {
    digits = digits
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return `#${digits}`;
}
