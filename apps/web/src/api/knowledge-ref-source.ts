import { formatKnowledgeRef, parseKnowledgeRef, type KnowledgeRefCandidateDto } from "@knotebook/shared";
import type { KnowledgeRefCandidate, KnowledgeRefSource } from "@/components/knowledge/ref-source";
import { ApiFail } from "./client";
import { fetchKnowledgeRef, fetchKnowledgeRefs } from "./knowledge";

/** A renamed or deleted note, or a lost permission, shows up on the card at the latest this long after it happened. */
const RESOLVE_TTL_MS = 60_000;

function candidateOf(dto: KnowledgeRefCandidateDto, currentNoteId: string): KnowledgeRefCandidate {
  return {
    ref: formatKnowledgeRef({ noteId: dto.noteId, knowledgeId: dto.knowledgeId }, currentNoteId),
    noteId: dto.noteId,
    noteTitle: dto.noteTitle,
    blockId: dto.blockId,
    heading: dto.heading,
    conclusion: dto.conclusion,
    href: `${dto.path}#b-${dto.blockId}`,
  };
}

/** Visibility is decided by the server: nothing here is built from locally cached notes. */
export function createRemoteKnowledgeRefSource(currentNoteId: string): KnowledgeRefSource {
  const cache = new Map<string, { at: number; promise: Promise<KnowledgeRefCandidate | null> }>();
  return {
    async search(query, signal) {
      const q = query.trim();
      if (q === "") return [];
      const { candidates } = await fetchKnowledgeRefs(q, currentNoteId, signal);
      return candidates.map((c) => candidateOf(c, currentNoteId));
    },
    resolve(ref) {
      const parsed = parseKnowledgeRef(ref);
      if (!parsed || parsed.noteId === null || parsed.noteId === currentNoteId.toLowerCase()) return Promise.resolve(null);
      const hit = cache.get(ref);
      if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.promise;
      // Not tied to one caller's signal: the promise is shared, and a caller that left just ignores the answer.
      const promise = fetchKnowledgeRef(parsed.noteId, parsed.knowledgeId).then(
        (dto) => candidateOf(dto, currentNoteId),
        (err: unknown) => {
          if (err instanceof ApiFail && err.status === 404) return null;
          cache.delete(ref);
          throw err;
        },
      );
      cache.set(ref, { at: Date.now(), promise });
      return promise;
    },
  };
}
