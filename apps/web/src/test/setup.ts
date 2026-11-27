import { afterEach } from "vitest";
import { act, cleanup, configure } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { resetNoteWidthsForTest } from "@/components/note-width";
import { dismissAllToasts } from "@/components/ui/toast";
// The admin / settings string bundles register lazily (each consumer imports its own); component tests register them up front, otherwise rendering a single child component would show raw keys.
import "@/i18n/management-strings";

// The first render of a lazy chunk (settings blocks / site admin / sign-in flow pages) in a test does a real dynamic import;
// under CI load it can exceed 1 s, which is Testing Library's default waitFor / findBy limit, so cases would fail intermittently on CI while passing locally.
// A test's strength is in the assertion content, not in the wait length.
// The limit is raised further from 3 s to 10 s: the first case of each file pays the cold lazy import / first heavy render, about 0.6-1 s on its own;
// when several suites run at once (3 suites x 23 workers competing for 24 cores) that gets dragged past 3 s and the first wait fails with "Unable to find".
// Raising the limit matters for tests that guard a hook's `retry: false` by waiting for the error to appear: react-query's default retry backoff
// (1+2+4 = about 7 s) would fail a 3 s wait but not a 10 s one, so such guards must assert the call count (the endpoint is hit exactly once
// when the error appears) and use a QueryClient that doesn't disable retry, rather than rely on the wait length.
// 10 s is not an upper bound under oversubscribed CPUs: the cold load is unbounded there.
// When running several suites at once add `--maxWorkers=8`.
configure({ asyncUtilTimeout: 10_000 });

// jsdom has no `ResizeObserver` - when `@blocknote/mantine`'s `<BlockNoteView>` mounts, internal mantine components (`MantineProvider` / popover / tabs)
// touch it and throw `ResizeObserver is not defined`. A fake constructor that does nothing is enough here (our tests
// don't assert real size measurement, only that it doesn't blow up).
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom doesn't implement `window.matchMedia` - `@blocknote/react`'s `usePrefersColorScheme` guards with
// `window.matchMedia?.(...)` optional chaining and doesn't break, but mantine's
// `MantineProvider` / `ColorSchemeManager` has no such guard and calling it throws
// `window.matchMedia is not a function`. A fake MediaQueryList that always reports "no match" is added;
// the existing "jsdom has no matchMedia" assumption in `theme.test.tsx` is unaffected (`matches: false`
// has the same effect as the branch `typeof window.matchMedia !== 'function'` fell into).
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom's getBoundingClientRect() returns an object without toJSON, and BlockNote's
// SuggestionMenuView.update (wikilink autocomplete) throws when it calls it.
// A real DOMRect (with toJSON) is put in as the default; tests that need real sizes spy and override it themselves.
Element.prototype.getBoundingClientRect = function () {
  return new DOMRect(0, 0, 0, 0);
};

// jsdom's `window.scrollTo` only prints "Not implemented". On phones the list and notes scroll the document, and `AppShell` calls it when switching screens;
// replaced with a no-op, tests that need to measure calls spy on it themselves.
window.scrollTo = (() => {}) as typeof window.scrollTo;

// jsdom doesn't implement Range.getClientRects() / getBoundingClientRect() at all (the methods don't exist, rather than returning empty values).
// When a really mounted BlockNote editor calls `.focus()` / `scrollIntoView`, ProseMirror's coordsAtPos builds a Range over the text node at the cursor to measure coordinates
// (the wikilink autocomplete "create and link" flow's `setTextSelection(...).run()` reaches here),
// and without these two methods it throws `range.getClientRects is not a function`.
Range.prototype.getBoundingClientRect = function () {
  return new DOMRect(0, 0, 0, 0);
};
Range.prototype.getClientRects = function () {
  return [] as unknown as DOMRectList;
};

// jsdom doesn't implement `ClipboardEvent` - `new ClipboardEvent("paste")` inside `prosemirror-view`'s `pasteHTML` (reached by BlockNote's
// `pasteMarkdown`) throws. A minimal subclass lets that existing code path run (not faked results, same nature as the two stubs above).
// The comparison test in markdown-link.oracle.test.ts has to use `pasteMarkdown`, so this gap must be filled.
if (typeof globalThis.ClipboardEvent === "undefined") {
  globalThis.ClipboardEvent = class extends Event {} as unknown as typeof ClipboardEvent;
}

// jsdom has no pointer capture and `scrollIntoView`; Radix Select calls them when opening its panel (no-ops are enough and don't affect assertions).
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

// Tests that mount the app shell would otherwise open a real notification socket against whatever listens on jsdom's origin;
// tests that need a socket inject their own fake.
class InertWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(readonly url: string) {
    super();
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}
globalThis.WebSocket = InertWebSocket as unknown as typeof WebSocket;

afterEach(() => {
  cleanup();
  // The module-level Map of in-app widths survives across cases; without a reset, cases pollute each other depending on test order.
  resetNoteWidthsForTest();
  // Toasts also live in a module-level store and survive across cases: a toast left by the previous case can be picked up by the next case's findByText and make it falsely green
  // (it really happened with AuthorizePage "410 -> error page": the page text is the same as the previous case's toast, so zero requests still passed).
  act(() => dismissAllToasts());
});
