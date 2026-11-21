import type { AddNoteTagResultDto } from "@knotebook/shared";
import type { HashTagBatchInput } from "@/collab/hash-tag-input";
import { errorMessage } from "@/api/favorites";
import { toast } from "@/components/ui/toast";
import "@/i18n/tags-strings";

type TFn = (key: string, opts?: Record<string, unknown>) => string;

export interface HashTagBatchDeps {
  noteId: string;
  /** Read when the batch starts, not when it was queued: an earlier batch on the same note has attached its tags by then. */
  currentNames: () => readonly string[];
  add: (name: string) => Promise<AddNoteTagResultDto>;
  remove: (tagId: string) => Promise<unknown>;
  t: TFn;
}

// Same-note batches run one after another so a slow reply can't overwrite a newer one.
const queues = new Map<string, Promise<void>>();

export function runHashTagBatch(deps: HashTagBatchDeps, input: HashTagBatchInput): Promise<void> {
  const next = (queues.get(deps.noteId) ?? Promise.resolve()).then(() => runOne(deps, input));
  queues.set(deps.noteId, next);
  void next.then(() => {
    if (queues.get(deps.noteId) === next) queues.delete(deps.noteId);
  });
  return next;
}

export function notifyHashTagOverLimit(t: TFn, max: number): void {
  toast({ title: t("tagHash.overLimit", { max }) });
}

function safeRestore(input: HashTagBatchInput): boolean {
  try {
    return input.restore();
  } catch {
    return false;
  }
}

async function runOne(deps: HashTagBatchDeps, input: HashTagBatchInput): Promise<void> {
  const { t } = deps;
  const onNote = new Set(deps.currentNames().map((name) => name.toLowerCase()));
  const attached: Array<{ id: string; name: string }> = [];
  try {
    for (const name of input.names) {
      if (onNote.has(name.toLowerCase())) continue;
      const result = await deps.add(name);
      onNote.add(name.toLowerCase());
      if (result.attached) attached.push(result.tag);
    }
  } catch (err) {
    for (const tag of attached) {
      try {
        await deps.remove(tag.id);
      } catch {
        // The tag stays; the text is put back below either way.
      }
    }
    const restored = safeRestore(input);
    toast({ title: t(restored ? "tagHash.failedRestored" : "tagHash.failed"), description: errorMessage(t, err), variant: "destructive" });
    return;
  }
  if (attached.length === 0) return;

  const names = attached.map((tag) => tag.name).join(t("tags.separator"));
  let undone = false;
  const undo = async (): Promise<void> => {
    if (undone) return;
    undone = true;
    try {
      for (const tag of attached) await deps.remove(tag.id);
    } catch {
      toast({ title: t("tagHash.undoFailed"), variant: "destructive" });
      return;
    }
    if (!safeRestore(input)) toast({ title: t("tagHash.undoTextNotRestored"), variant: "destructive" });
  };
  toast({
    title: t("tagHash.added", { names }),
    action: { label: t("tagHash.undo"), altText: t("tagHash.undoAlt", { names }), onClick: () => void undo() },
  });
}
