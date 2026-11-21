import { createContext, useCallback, useMemo, useState } from "react";

export type KnowledgeSurfaceMode = "view" | "edit";

export interface KnowledgeOpenState {
  blockId: string;
  mode: KnowledgeSurfaceMode;
  returnFocus: HTMLElement | null;
}

export interface KnowledgeController {
  state: KnowledgeOpenState | null;
  open(blockId: string, mode: KnowledgeSurfaceMode, returnFocus?: HTMLElement | null): void;
  close(): void;
}

export function useKnowledgeController(): KnowledgeController {
  const [state, setState] = useState<KnowledgeOpenState | null>(null);
  const open = useCallback((blockId: string, mode: KnowledgeSurfaceMode, returnFocus: HTMLElement | null = null) => setState({ blockId, mode, returnFocus }), []);
  const close = useCallback(() => setState(null), []);
  return useMemo(() => ({ state, open, close }), [state, open, close]);
}

let returning = false;

/** Gives focus back to the icon without letting its hover card pop up again: Radix opens a hover card on any focus. */
export function returnFocusQuietly(el: HTMLElement | null): void {
  if (!el || !el.isConnected) return;
  returning = true;
  try {
    el.focus({ preventScroll: true });
  } finally {
    returning = false;
  }
}

export function isReturningFocus(): boolean {
  return returning;
}

export const KnowledgeControllerContext = createContext<KnowledgeController | null>(null);
