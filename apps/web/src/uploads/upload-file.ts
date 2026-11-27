import type { UploadResponseDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { removeBlocksKeepColumns } from "@/collab/columns/keep-columns";
import { toast } from "@/components/ui/toast";
import { storageQuotaDescription, type Translate } from "@/lib/storage-quota-text";
import type { EditorRef } from "@/components/wikilink/menu";
import { xhrUpload } from "./xhr-upload";

/**
 * May reject; createUploadFile wraps it. An oversize file fails before sending, with the same 413 code the server
 * uses, so callers needn't tell the two apart.
 */
export async function postUpload(
  noteId: string,
  file: File,
  maxBytes?: number,
): Promise<UploadResponseDto> {
  if (maxBytes !== undefined && file.size > maxBytes) {
    throw new ApiFail(413, "file_too_large", "client-side precheck");
  }
  const fd = new FormData();
  fd.append("file", file);
  return xhrUpload(`/api/notes/${encodeURIComponent(noteId)}/uploads`, fd);
}

export { storageQuotaDescription, type Translate } from "@/lib/storage-quota-text";

const TOAST_DEDUPE_WINDOW_MS = 5000;
const lastToastAtByCode = new Map<string, number>();

function toastOncePerCode(err: unknown, translate: Translate): void {
  const code = err instanceof ApiFail ? err.code : "internal";
  const now = Date.now();
  const last = lastToastAtByCode.get(code);
  if (last !== undefined && now - last < TOAST_DEDUPE_WINDOW_MS) return;
  lastToastAtByCode.set(code, now);
  if (err instanceof ApiFail && code === "storage_quota_exceeded") {
    toast({ title: translate(`errors.${code}`), description: storageQuotaDescription(err, translate) });
    return;
  }
  toast({ title: translate(`errors.${code}`) });
}

export interface CreateUploadFileOptions {
  noteId: string;
  /** Read at failure time: createUploadFile is created before the editor exists. */
  editorRef: EditorRef;
  translate: Translate;
  /** Called per upload: the config loads later and admins can change it. `undefined` skips the precheck. */
  maxUploadBytes?: () => number | undefined;
}

/**
 * Never rejects: BlockNote's handleFileInsertion has no catch, so a rejection goes unhandled and stops its loop over
 * the remaining files. On failure it returns "" and removes the placeholder in a macrotask: handleFileInsertion calls
 * updateBlock right after the await resolves, and a microtask would delete the block before that update.
 */
export function createUploadFile(
  opts: CreateUploadFileOptions,
): (file: File, blockId?: string) => Promise<string> {
  const { noteId, editorRef, translate, maxUploadBytes } = opts;
  return async (file, blockId) => {
    try {
      const { url } = await postUpload(noteId, file, maxUploadBytes?.());
      return url;
    } catch (err) {
      toastOncePerCode(err, translate);
      setTimeout(() => {
        try {
          const ed = editorRef.current;
          if (blockId && ed && ed.getBlock(blockId)) {
            removeBlocksKeepColumns(ed, [blockId]);
          }
        } catch {
          // Block or editor already gone; cleanup must not throw into the caller.
        }
      }, 0);
      return "";
    }
  };
}
