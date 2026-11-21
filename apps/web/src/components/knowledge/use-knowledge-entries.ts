import { useEffect, useLayoutEffect, useState } from "react";
import type { KnowledgeEntry } from "@knotebook/shared";
import { knowledgeEntriesOf } from "@/collab/knowledge-decorations";

export interface KnowledgeEditorLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- EditorState can't be imported: prosemirror-state isn't an apps/web dependency
  readonly prosemirrorState: any;
  onChange(listener: () => void): (() => void) | void;
}

const NONE: readonly KnowledgeEntry[] = [];

function read(editor: KnowledgeEditorLike): readonly KnowledgeEntry[] {
  try {
    return knowledgeEntriesOf(editor.prosemirrorState);
  } catch {
    // The view isn't mounted (yet, or any more): there is no state to read.
    return NONE;
  }
}

/** `refreshKey`: bumping it re-reads at once, for a remounted view whose plugin state was rebuilt without a change event. */
export function useKnowledgeEntries(editor: KnowledgeEditorLike | null, refreshKey?: unknown): readonly KnowledgeEntry[] {
  const [entries, setEntries] = useState<readonly KnowledgeEntry[]>(NONE);

  useLayoutEffect(() => {
    if (editor) setEntries(read(editor));
    else setEntries(NONE);
  }, [editor, refreshKey]);

  useEffect(() => {
    if (!editor) return;
    let frame = 0;
    const flush = () => {
      frame = 0;
      // The plugin returns the same array while the entries are unchanged, so a keystroke in ordinary text re-renders nothing.
      setEntries(read(editor));
    };
    const unsubscribe = editor.onChange(() => {
      if (frame === 0) frame = requestAnimationFrame(flush);
    });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [editor]);

  return entries;
}
