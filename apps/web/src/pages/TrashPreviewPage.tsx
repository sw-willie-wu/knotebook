import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import { trashPreviewKey } from "@/api/trash";
import { InTrashCard } from "@/components/InTrashCard";
import { toast } from "@/components/ui/toast";
import { useActiveNote } from "@/lib/active-note";

/** Lazy route page for `/trash/:id`: read-only preview of a trashed note opened from the Trash sidebar tab. */
export default function TrashPreviewPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setActiveNoteId, clearActiveNoteId } = useActiveNote();

  useEffect(() => {
    if (!id) return;
    setActiveNoteId(id);
    return () => clearActiveNoteId(id);
  }, [id, setActiveNoteId, clearActiveNoteId]);

  const handleRestored = useCallback(
    (restored: NoteDto | null) => {
      if (restored !== null) {
        void navigate(canonicalNotePath(restored), { replace: true });
      } else {
        void navigate("/", { replace: true });
      }
    },
    [navigate],
  );

  const handlePurged = useCallback(() => {
    void navigate("/", { replace: true });
  }, [navigate]);

  const handleNotFound = useCallback(
    ({ afterLoad }: { afterLoad: boolean }) => {
      if (afterLoad) {
        // Restoring from the sidebar seeds `["note", id]` before invalidating `["trash"]`; ignore older pre-trash cache entries so a sidebar purge still goes home.
        const noteState = queryClient.getQueryState<NoteDto>(["note", id]);
        const previewState = queryClient.getQueryState(trashPreviewKey(id));
        if (noteState?.data && noteState.dataUpdatedAt >= (previewState?.dataUpdatedAt ?? 0)) {
          void navigate(canonicalNotePath(noteState.data), { replace: true });
          return;
        }
      } else {
        toast({ title: t("note.linkInvalid"), variant: "destructive" });
      }
      void navigate("/", { replace: true });
    },
    [id, navigate, queryClient, t],
  );

  return (
    <InTrashCard
      noteId={id}
      showGoToTrash={false}
      onRestored={handleRestored}
      onPurged={handlePurged}
      onNotFound={handleNotFound}
    />
  );
}
