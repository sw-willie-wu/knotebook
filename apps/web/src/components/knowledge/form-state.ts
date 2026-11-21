import {
  KNOWLEDGE_CONCLUSION_MAX,
  KNOWLEDGE_WHEN_MAX,
  knowledgeTextLength,
  type KnowledgeDraft,
  type KnowledgeDraftError,
  type KnowledgeInfo,
} from "@knotebook/shared";

export const EMPTY_DRAFT: KnowledgeDraft = { when: "", conclusion: "", evidence: "", verified: "", status: "", supersededBy: "" };

export function draftOf(info: KnowledgeInfo | null): KnowledgeDraft {
  if (!info) return EMPTY_DRAFT;
  const { id: _id, ...rest } = info;
  return rest;
}

/** A single-line input can't show a line break written elsewhere; the stored value stays as it is until the field is edited. */
export function singleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

/** A replacement only means something for outdated knowledge. */
export function draftForSave(draft: KnowledgeDraft): KnowledgeDraft {
  return draft.status === "outdated" ? draft : { ...draft, supersededBy: "" };
}

export type FormField = keyof KnowledgeDraft | "form";

export function fieldOfError(error: KnowledgeDraftError): FormField {
  switch (error) {
    case "whenTooLong": return "when";
    case "conclusionTooLong": return "conclusion";
    case "verifiedInvalid": return "verified";
    case "supersededRequired":
    case "supersededInvalid":
    case "supersededSelf": return "supersededBy";
    case "empty": return "form";
  }
}

/** Set only for a field the user edited: a long value written elsewhere must not block saving another field. */
export function tooLongLength(field: "when" | "conclusion", draft: KnowledgeDraft, touched: ReadonlySet<keyof KnowledgeDraft>): { max: number; n: number } | null {
  if (!touched.has(field)) return null;
  const max = field === "when" ? KNOWLEDGE_WHEN_MAX : KNOWLEDGE_CONCLUSION_MAX;
  const n = knowledgeTextLength(draft[field]);
  return n > max ? { max, n } : null;
}
