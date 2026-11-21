import type { QueryClient } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import { addNoteTag, removeNoteTag, tagSpaceOfNote } from "@/api/tags";
import type { HashTagBatchInput } from "@/collab/hash-tag-input";
import { toast } from "@/components/ui/toast";

type TFn = (key: string, opts?: Record<string, unknown>) => string;

/** The batch code is a lazy chunk; starting its download when the note opens means a `#name` typed offline is still handled. */
export function preloadHashTagBatch(): void {
  void import("./hash-tag-batch").catch(() => undefined);
}

export function currentNoteTagNames(queryClient: QueryClient, noteId: string): string[] {
  const row = queryClient.getQueryData<NoteDto[]>(["notes"])?.find((n) => n.id === noteId);
  return (row?.tags ?? []).map((tag) => tag.name);
}

/** The text was already taken out of the note: if the chunk can't load there is nobody else to put it back. */
export function applyHashTags(
  deps: { queryClient: QueryClient; note: Pick<NoteDto, "id" | "groupId">; t: TFn },
  input: HashTagBatchInput,
): void {
  const { queryClient, note, t } = deps;
  const space = tagSpaceOfNote(note);
  import("./hash-tag-batch")
    .then(({ runHashTagBatch }) =>
      runHashTagBatch(
        {
          noteId: note.id,
          currentNames: () => currentNoteTagNames(queryClient, note.id),
          add: (name) => addNoteTag(queryClient, { noteId: note.id, name, space }),
          remove: (tagId) => removeNoteTag(queryClient, { noteId: note.id, tagId, space }),
          t,
        },
        input,
      ),
    )
    .catch(() => {
      try {
        input.restore();
      } catch {
        // Nothing left to do: the error toast below says the tag was not added.
      }
      toast({ title: t("errors.fallback"), variant: "destructive" });
    });
}
