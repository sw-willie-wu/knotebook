const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function relativeTime(iso: string, language: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.trunc(seconds / size), unit);
  }
  // A clock slightly ahead of the server would otherwise say "in 3 seconds".
  return rtf.format(0, "second");
}

export function fullTime(iso: string, language: string): string {
  return new Date(iso).toLocaleString(language);
}

/** Agents read "handle (label)" from the label snapshot, as last-edited and presence show them. */
export function authorName(c: { authorHandle: string; authorDisplayName: string; agentLabel: string | null }): string {
  return c.agentLabel !== null ? `${c.authorHandle} (${c.agentLabel})` : c.authorDisplayName || c.authorHandle;
}
