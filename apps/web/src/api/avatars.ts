import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { AvatarCandidateDto, AvatarCropUpload, AvatarListDto, UserDto } from "@knotebook/shared";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { notifyAvatarWritten } from "@/avatars/display-filler";
import { api, ApiFail } from "./client";
import { STORAGE_USAGE_QUERY_KEY } from "./storage";

/**
 * 個人頭貼的候選清單與寫入。讀圖不經這裡，一律用 shared 的 `avatarUrl`；本檔的路徑只有
 * `/api/auth/avatars…` 與 `/api/auth/avatar`（候選管理），不手組讀圖網址。
 *
 * 寫入成功一律失效候選清單、目前使用者（`["me"]`）與個人儲存用量（原圖與顯示圖都計入）。
 */
export const AVATARS_QUERY_KEY = ["avatars"] as const;

/** 重抓候選清單、目前使用者與用量，不代表有頭貼被寫入（背景補產發現版本過期時用）。 */
export function invalidateAvatarQueries(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: AVATARS_QUERY_KEY }),
    qc.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
    qc.invalidateQueries({ queryKey: STORAGE_USAGE_QUERY_KEY }),
  ]);
}

export function invalidateAvatarRelated(qc: QueryClient): Promise<unknown> {
  // 頭貼寫入成功：因空間不足補不出顯示圖的候選重新排隊（也許已經騰出空間）。
  notifyAvatarWritten();
  return invalidateAvatarQueries(qc);
}

/** 顯示圖的檔名副檔名跟著實際格式（WebP 不支援時編碼端會退回 JPEG）。 */
function displayFileName(display: Blob): string {
  return display.type === "image/jpeg" ? "display.jpg" : "display.webp";
}

export function useAvatars(): UseQueryResult<AvatarListDto> {
  return useQuery({ queryKey: AVATARS_QUERY_KEY, queryFn: () => api<AvatarListDto>("/api/auth/avatars") });
}

export interface UploadAvatarInput {
  /** 使用者選的原檔。 */
  original: Blob;
  /** 瀏覽器裁出的顯示圖。 */
  display: Blob;
  /** 裁切框（原圖像素座標）。 */
  crop: AvatarCropUpload;
}

/** 上傳新頭貼（multipart：`original`、`display`、`crop`＝JSON 字串）。`api()` 對 FormData 不補 Content-Type。 */
export function useUploadAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ original, display, crop }: UploadAvatarInput) => {
      const form = new FormData();
      form.append("original", original, original instanceof File && original.name !== "" ? original.name : "original");
      form.append("display", display, displayFileName(display));
      form.append("crop", JSON.stringify(crop));
      return api<AvatarCandidateDto>("/api/auth/avatars", { method: "POST", body: form });
    },
    onSuccess: () => invalidateAvatarRelated(qc),
  });
}

export interface UpdateAvatarDisplayInput {
  id: string;
  display: Blob;
  crop: AvatarCropUpload;
  /** 呼叫端看到的候選版本，即該候選 DTO 的 `avatar.v`；server 發現不是最新就回 `avatar_outdated`。 */
  version: number;
  /** 背景補產用：逾時就中止，免得卡住的連線讓補產佇列停擺。 */
  signal?: AbortSignal;
}

/** `PUT …/display`：只換顯示圖與 crop，原圖不動。不碰快取；重新裁切與背景補產共用。 */
export function putAvatarDisplay({ id, display, crop, version, signal }: UpdateAvatarDisplayInput): Promise<AvatarCandidateDto> {
  const form = new FormData();
  form.append("display", display, displayFileName(display));
  form.append("crop", JSON.stringify(crop));
  form.append("version", String(version));
  return api<AvatarCandidateDto>(`/api/auth/avatars/${encodeURIComponent(id)}/display`, { method: "PUT", body: form, signal });
}

/** 重新裁切既有候選（只換顯示圖與 crop，原圖不動）。 */
export function useUpdateAvatarDisplay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: putAvatarDisplay,
    onSuccess: () => invalidateAvatarRelated(qc),
  });
}

/** 手動重新取得某個登入服務的頭貼（server 重新下載）。成功回更新後的清單。 */
export function useRefreshOidcAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (identityId: string) =>
      api<AvatarListDto>(`/api/auth/avatars/oidc/${encodeURIComponent(identityId)}/refresh`, { method: "POST", body: "{}" }),
    onSuccess: list => {
      qc.setQueryData(AVATARS_QUERY_KEY, list);
      return invalidateAvatarRelated(qc);
    },
  });
}

/** 選用某張候選；`null` ＝ 不使用頭貼（改回首字）。回應是更新後的使用者，先寫進 session 快取讓畫面立刻換。 */
export function useSelectAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (candidateId: string | null) =>
      api<UserDto>("/api/auth/avatar", { method: "PUT", body: JSON.stringify({ candidateId }) }),
    onSuccess: user => {
      qc.setQueryData(SESSION_QUERY_KEY, user);
      return invalidateAvatarRelated(qc);
    },
  });
}

export function useDeleteAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/auth/avatars/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidateAvatarRelated(qc),
  });
}

/** 取某張候選的原圖（重新裁切用）。回應不是 JSON，所以不經 `api()`；非 2xx 轉成 `ApiFail`。 */
export async function fetchAvatarOriginal(id: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`/api/auth/avatars/${encodeURIComponent(id)}/original`, { credentials: "include", signal });
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const error = (body as { error?: { code?: unknown; message?: unknown } } | null | undefined)?.error;
    if (typeof error?.code === "string" && typeof error.message === "string") {
      throw new ApiFail(response.status, error.code, error.message);
    }
    throw new ApiFail(response.status, "internal", "Unexpected error response from server");
  }
  return response.blob();
}
