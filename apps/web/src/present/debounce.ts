/** A8：防抖 trailing 500 ms＋maxWait 2 s（spec §3.4、§7.1-2）。時間以 `Date.now()` 量（vitest fake timers 會一併假造）。 */
export const UPDATE_DEBOUNCE_MS = 500;
export const UPDATE_MAX_WAIT_MS = 2000;

export interface Debouncer {
  schedule(): void;
  cancel(): void;
}

export function createDebouncer(
  fn: () => void,
  { wait = UPDATE_DEBOUNCE_MS, maxWait = UPDATE_MAX_WAIT_MS }: { wait?: number; maxWait?: number } = {},
): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt: number | null = null;

  const run = () => {
    timer = undefined;
    firstAt = null;
    fn();
  };

  return {
    schedule() {
      const now = Date.now();
      if (firstAt === null) firstAt = now;
      if (timer !== undefined) clearTimeout(timer);
      const delay = Math.max(0, Math.min(wait, maxWait - (now - firstAt)));
      timer = setTimeout(run, delay);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      firstAt = null;
    },
  };
}
