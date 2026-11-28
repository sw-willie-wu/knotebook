import { safeMediaUrl } from "./media-url";

/**
 * Maps `/api/uploads/<id>` to the trashed-note upload endpoint so images belonging to the previewed
 * trashed note load while `/api/uploads/:id` stays 403. `safeMediaUrl` runs first so the mapping
 * cannot bypass the render-side URL guard.
 */
export function trashMediaUrl(noteId: string): (url: string) => string {
  const base = `/api/trash/${encodeURIComponent(noteId)}`;
  return (raw: string): string => {
    const safe = safeMediaUrl(raw);
    if (safe !== raw) return safe;
    const match = /^\/api\/uploads\/([^/?#]+)$/.exec(raw);
    if (!match) return raw;
    return `${base}/uploads/${match[1]}`;
  };
}
