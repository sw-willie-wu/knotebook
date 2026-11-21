/** How many pills fit on one line. The "+N" button is reserved only when something has to be left out. The first pill is always shown (the caller truncates it), so a single very long tag never leaves only "+N". */
export function fitPills(widths: readonly number[], available: number, gap: number, moreWidth: number): number {
  const total = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1);
  if (total <= available) return widths.length;
  let used = 0;
  let count = 0;
  for (const width of widths) {
    const next = used + (count > 0 ? gap : 0) + width;
    if (next + gap + moreWidth > available) break;
    used = next;
    count += 1;
  }
  return widths.length > 0 ? Math.max(count, 1) : 0;
}
