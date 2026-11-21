import { useSyncExternalStore } from "react";

export interface TagEntryOptions {
  /** Called when the input is left without a tag on the note (Escape, Tab): the row has nothing left to hold focus, so it would fall to <body>. */
  returnFocus?: () => void;
}

const counts = new Map<string, number>();
const returnFocusFns = new Map<string, (() => void) | undefined>();
const listeners = new Set<() => void>();

export function tagEntryRequestCount(noteId: string): number {
  return counts.get(noteId) ?? 0;
}

export function tagEntryReturnFocus(noteId: string): (() => void) | undefined {
  return returnFocusFns.get(noteId);
}

export function subscribeTagEntry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Asks the tag row of this note to show its input and focus it. */
export function openTagEntry(noteId: string, options: TagEntryOptions = {}): void {
  returnFocusFns.set(noteId, options.returnFocus);
  counts.set(noteId, tagEntryRequestCount(noteId) + 1);
  for (const listener of [...listeners]) listener();
}

/** Changes on every `openTagEntry` for this note; a row compares it with the value it saw when it mounted, so requests made earlier never reopen it. */
export function useTagEntryRequest(noteId: string): number {
  return useSyncExternalStore(subscribeTagEntry, () => tagEntryRequestCount(noteId));
}
