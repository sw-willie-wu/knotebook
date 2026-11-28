import { api } from "@/api/client";

/** Fire and forget: the file is already in its block, so a lost report only costs the bell entry. */
export function reportUploadFinished(uploadId: string, blockId: string): void {
  api<void>(`/api/uploads/${encodeURIComponent(uploadId)}/finished`, { method: "POST", body: JSON.stringify({ blockId }) }).catch(() => {});
}
