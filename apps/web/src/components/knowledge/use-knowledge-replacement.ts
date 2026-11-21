import { useContext, useEffect, useState } from "react";
import { useInRouterContext, useNavigate } from "react-router";
import { parseKnowledgeRef, type KnowledgeEntry } from "@knotebook/shared";
import type { KnowledgeReplacementView } from "./KnowledgeCard";
import { KnowledgeRefSourceContext, type KnowledgeRefCandidate } from "./ref-source";

function useOptionalNavigate(): ((href: string) => void) | null {
  const inRouter = useInRouterContext();
  // Whether a router wraps this component never changes while it is mounted.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return inRouter ? useNavigate() : null;
}

/**
 * Same-note references resolve from `entries` at once; another note's goes through the ref source, and stays "otherNote" without a title or link when there is no source or it knows nothing.
 * `jump` scrolls to a heading in this note.
 */
export function useKnowledgeReplacement(
  entry: KnowledgeEntry | null,
  entries: readonly KnowledgeEntry[],
  noteId: string | null,
  jump: (blockId: string) => void = () => {},
): KnowledgeReplacementView | null {
  const source = useContext(KnowledgeRefSourceContext);
  const navigate = useOptionalNavigate();
  const outdated = entry !== null && entry.info.status === "outdated";
  const raw = outdated ? entry.info.supersededBy : "";
  const ref = raw === "" ? null : parseKnowledgeRef(raw);
  const sameNote = ref !== null && (ref.noteId === null || (noteId !== null && ref.noteId.toLowerCase() === noteId.toLowerCase()));
  const [resolved, setResolved] = useState<{ raw: string; candidate: KnowledgeRefCandidate | null } | null>(null);

  const elsewhere = ref !== null && !sameNote;
  useEffect(() => {
    if (!elsewhere || !source) return;
    const abort = new AbortController();
    void source.resolve(raw, abort.signal).then(
      (candidate) => {
        if (!abort.signal.aborted) setResolved({ raw, candidate });
      },
      () => {},
    );
    return () => abort.abort();
  }, [elsewhere, source, raw]);

  if (!ref) return null;
  if (!sameNote) {
    const candidate = resolved?.raw === raw ? resolved.candidate : null;
    const href = candidate?.href ?? null;
    return {
      state: "otherNote",
      title: candidate ? candidate.heading || candidate.noteTitle : null,
      open: href && navigate ? () => navigate(href) : null,
    };
  }
  const target = entries.find((e) => e.info.id === ref.knowledgeId);
  if (!target) return { state: "missing", title: null, open: null };
  return { state: "found", title: target.heading || null, open: () => jump(target.blockId) };
}
