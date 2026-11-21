import { createContext } from "react";
import { parseKnowledgeRef, type KnowledgeEntry } from "@knotebook/shared";

export interface KnowledgeRefCandidate {
  /** What gets stored in `knowledgeSupersededBy`: a bare id for this note, `noteId#id` for another. */
  ref: string;
  noteId: string | null;
  noteTitle: string | null;
  blockId: string;
  heading: string;
  conclusion: string;
  href: string | null;
}

export interface KnowledgeRefSource {
  search(query: string, signal?: AbortSignal): Promise<KnowledgeRefCandidate[]>;
  resolve(ref: string, signal?: AbortSignal): Promise<KnowledgeRefCandidate | null>;
}

/** null = same-note only. */
export const KnowledgeRefSourceContext = createContext<KnowledgeRefSource | null>(null);

function candidateOf(entry: KnowledgeEntry, noteId: string | null): KnowledgeRefCandidate {
  return {
    ref: entry.info.id,
    noteId,
    noteTitle: null,
    blockId: entry.blockId,
    heading: entry.heading,
    conclusion: entry.info.conclusion,
    href: null,
  };
}

/** Heading matches come before conclusion and when-to-read matches; ties keep document order. */
export function rankKnowledgeMatches(entries: readonly KnowledgeEntry[], query: string): KnowledgeEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...entries];
  const scored: Array<{ entry: KnowledgeEntry; score: number; index: number }> = [];
  entries.forEach((entry, index) => {
    const heading = entry.heading.toLowerCase();
    let score = -1;
    if (heading.startsWith(q)) score = 0;
    else if (heading.includes(q)) score = 1;
    else if (entry.info.conclusion.toLowerCase().includes(q) || entry.info.when.toLowerCase().includes(q)) score = 2;
    if (score >= 0) scored.push({ entry, score, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((s) => s.entry);
}

export function localKnowledgeRefSource(entries: () => readonly KnowledgeEntry[], noteId: string | null): KnowledgeRefSource {
  return {
    search: (query) => Promise.resolve(rankKnowledgeMatches(entries(), query).map((e) => candidateOf(e, noteId))),
    resolve: (ref) => {
      const parsed = parseKnowledgeRef(ref);
      const sameNote = parsed && (parsed.noteId === null || (noteId !== null && parsed.noteId === noteId.toLowerCase()));
      if (!parsed || !sameNote) return Promise.resolve(null);
      const found = entries().find((e) => e.info.id === parsed.knowledgeId);
      return Promise.resolve(found ? candidateOf(found, noteId) : null);
    },
  };
}
