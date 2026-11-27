import { ApiFail } from "@/api/client";
import { toast } from "@/components/ui/toast";
import { storageQuotaDescription, type Translate } from "@/lib/storage-quota-text";
import { uploadErrorKey } from "@/lib/upload-error-text";
import type { PrecheckCtx } from "./precheck";
import { getUploadItems, subscribeUploads } from "./upload-queue-store";
import { startUpload } from "./upload-runner";

export { storageQuotaDescription, type Translate } from "@/lib/storage-quota-text";

const TOAST_DEDUPE_WINDOW_MS = 5000;
const lastToastAtByKey = new Map<string, number>();

function toastOncePerCode(err: ApiFail, translate: Translate, file: File): void {
  // Keyed by the text shown, so an SVG-specific 415 doesn't swallow a generic 415 that follows.
  const textKey = uploadErrorKey(err, file) ?? `errors.${err.code}`;
  const now = Date.now();
  const last = lastToastAtByKey.get(textKey);
  if (last !== undefined && now - last < TOAST_DEDUPE_WINDOW_MS) return;
  lastToastAtByKey.set(textKey, now);
  if (err.code === "storage_quota_exceeded") {
    toast({ title: translate(`errors.${err.code}`), description: storageQuotaDescription(err, translate) });
    return;
  }
  toast({ title: translate(textKey) });
}

/** The upload runs on after the person leaves the note; the first failure is announced once, wherever they are. */
function toastWhenItFails(id: string, file: File, translate: Translate): void {
  const unsubscribe = subscribeUploads(() => {
    const item = getUploadItems().find((i) => i.id === id);
    if (item && (item.status === "uploading" || item.status === "writing")) return;
    unsubscribe();
    if (item?.status === "failed" && item.error instanceof ApiFail) toastOncePerCode(item.error, translate, file);
  });
}

export interface CreateUploadFileOptions {
  noteId: string;
  translate: Translate;
  /** Called per upload: limits and room are fetched fresh each time. */
  precheckCtx: () => Promise<PrecheckCtx>;
}

/**
 * Resolves at once, without waiting for the pre-check: BlockNote awaits each file of a drop in turn, so waiting would run
 * the checks one after another instead of sharing one. Never rejects either: handleFileInsertion has no catch, and a
 * rejection would stop its loop over the remaining files. The queue writes the URL into the block later, and the block
 * shows progress, a refusal or a failure, so nothing is removed here.
 */
export function createUploadFile(opts: CreateUploadFileOptions): (file: File, blockId?: string) => Promise<{ props: { name: string } }> {
  const { noteId, translate, precheckCtx } = opts;
  return async (file, blockId) => {
    if (blockId !== undefined) {
      void startUpload({ noteId, blockId, file, expectedUrl: "", precheckCtx }).then(
        (started) => {
          if (started.ok) toastWhenItFails(started.id, file, translate);
        },
        () => {},
      );
    }
    return { props: { name: file.name } };
  };
}
