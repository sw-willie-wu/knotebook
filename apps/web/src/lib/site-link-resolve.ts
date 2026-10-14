import { targetFromList, type NoteDto, type SiteLinkCandidate, type SiteLinkTarget, type SiteNoteHref } from "@knotebook/shared";
import { api } from "@/api/client";

/**
 * #269 §6.5：client 端站內網址解析。同步層＝`["notes"]` 快取（使用者可見清單＝寫入者權限）；非同步後備＝三支 session 端點
 * （同樣以寫入者授權，並涵蓋轉址表／prev_slug／legacy slug）。上限與逾時見 A6。
 */
export type CacheResolution = { kind: "hit"; target: SiteLinkTarget } | { kind: "miss" } | { kind: "unknown" };

export function resolveFromCache(notes: readonly SiteLinkCandidate[] | undefined, parsed: SiteNoteHref): CacheResolution {
  if (!notes) return { kind: "unknown" };
  const target = targetFromList(parsed.path, notes);
  return target ? { kind: "hit", target } : { kind: "miss" };
}

/** A6：每次轉換動作最多 20 個相異 href、單發逾時 5 s。 */
export const FALLBACK_MAX_HREFS = 20;
export const FALLBACK_TIMEOUT_MS = 5_000;

function endpointOf(parsed: SiteNoteHref): string {
  const p = parsed.path;
  if (p.kind === "n") return `/api/notes/by-path/${encodeURIComponent(p.handle)}/${encodeURIComponent(p.slug)}`;
  if (p.kind === "g") return `/api/notes/by-group-path/${encodeURIComponent(p.groupId)}/${encodeURIComponent(p.slug)}`;
  return `/api/notes/${encodeURIComponent(p.ref)}`;
}

export async function resolveViaServer(parsed: SiteNoteHref, timeoutMs = FALLBACK_TIMEOUT_MS): Promise<SiteLinkTarget | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const dto = await api<NoteDto>(endpointOf(parsed), { signal: controller.signal });
    return { id: dto.id, title: dto.title };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
