import type { QueryClient } from "@tanstack/react-query";
import {
  formatBytes,
  uploadCategoryOfName,
  uploadLimitClass,
  type AuthConfigDto,
  type GroupStorageUsageDto,
  type StorageUsageDto,
  type UploadCategory,
} from "@knotebook/shared";
import { AUTH_CONFIG_QUERY_KEY } from "@/api/authConfig";
import { api } from "@/api/client";
import { STORAGE_USAGE_QUERY_KEY, groupStorageKey } from "@/api/storage";
import type { Translate } from "@/lib/storage-quota-text";
import "@/i18n/upload-precheck-strings";

export interface PrecheckCtx {
  maxUploadBytes?: number;
  maxMediaUploadBytes?: number;
  /** `null`: no storage limit. `undefined`: the person can't see the space's usage, or it couldn't be fetched. */
  roomBytes: number | null | undefined;
  /** Set when a fetch failed; the caller proceeds and lets the server decide. */
  fetchFailed?: true;
}

export type PrecheckResult =
  | { ok: true; category: UploadCategory }
  | { ok: false; reason: "unsupported" | "empty" | "tooLarge" | "noRoom"; limitBytes?: number; roomBytes?: number };

export function precheckUpload(file: File, ctx: PrecheckCtx): PrecheckResult {
  // Images are accepted by content on the server, so a name without a known extension still passes as an image.
  const category = uploadCategoryOfName(file.name) ?? (file.type.startsWith("image/") ? "image" : null);
  if (category === null) return { ok: false, reason: "unsupported" };
  // The server refuses empty uploads.
  if (file.size === 0) return { ok: false, reason: "empty" };
  const limitBytes = uploadLimitClass(category) === "media" ? ctx.maxMediaUploadBytes : ctx.maxUploadBytes;
  if (limitBytes !== undefined && file.size > limitBytes) return { ok: false, reason: "tooLarge", limitBytes };
  if (typeof ctx.roomBytes === "number" && file.size > ctx.roomBytes) {
    return { ok: false, reason: "noRoom", roomBytes: ctx.roomBytes };
  }
  return { ok: true, category };
}

export function precheckMessage(file: File, r: PrecheckResult & { ok: false }, t: Translate): string {
  const size = formatBytes(file.size);
  if (r.reason === "unsupported") return t("uploadPrecheck.unsupported");
  if (r.reason === "empty") return t("uploadPrecheck.empty");
  if (r.reason === "tooLarge") return t("uploadPrecheck.tooLarge", { size, limit: formatBytes(r.limitBytes ?? 0) });
  return t("uploadPrecheck.noRoom", { size, room: formatBytes(r.roomBytes ?? 0) });
}

const FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout<T>(path: string): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await api<T>(path, { signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs outside React and never rejects. It fetches directly instead of through `fetchQuery`: that would join a fetch an
 * observer already started (possibly paused offline, with default retries), and neither `networkMode` nor the timeout
 * would apply. A failed fetch falls back to the cached limits and unknown room; the server decides.
 */
export function createPrecheckCtxProvider(
  queryClient: QueryClient,
  note: { groupId: string | null; canViewUsage: boolean },
): () => Promise<PrecheckCtx> {
  const { groupId, canViewUsage } = note;
  return async () => {
    const cachedConfig = () => queryClient.getQueryData<AuthConfigDto>(AUTH_CONFIG_QUERY_KEY);
    const limitsOf = (c: AuthConfigDto | undefined) => ({
      maxUploadBytes: c?.maxUploadBytes,
      maxMediaUploadBytes: c?.maxMediaUploadBytes,
    });
    try {
      const config = await fetchWithTimeout<AuthConfigDto>("/api/auth/config");
      queryClient.setQueryData(AUTH_CONFIG_QUERY_KEY, config);
      if (!canViewUsage) return { ...limitsOf(config), roomBytes: undefined };

      const usage = await fetchWithTimeout<StorageUsageDto | GroupStorageUsageDto>(
        groupId === null ? "/api/storage" : `/api/groups/${encodeURIComponent(groupId)}/storage`,
      );
      queryClient.setQueryData(groupId === null ? STORAGE_USAGE_QUERY_KEY : groupStorageKey(groupId), usage);
      return {
        ...limitsOf(config),
        // Usage can exceed the quota after a plan is lowered.
        roomBytes: usage.quotaBytes === null ? null : Math.max(0, usage.quotaBytes - usage.usedBytes),
      };
    } catch {
      return { ...limitsOf(cachedConfig()), roomBytes: undefined, fetchFailed: true };
    }
  };
}
