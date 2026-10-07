import { MAX_PROVIDER_ICON_SOURCE_BYTES, PROVIDER_ICON_SIZE } from "@knotebook/shared";

/**
 * 登入服務圖示的瀏覽器端縮圖（spec 2026-10-07-provider-icon §6.4、D7）：等比縮到最長邊 128 px（不放大）、一律重新編碼成 PNG（保留透明）。
 * server 不做影像處理（§1.3），仍照 §4.2 驗檔頭與 256 KB。`deps` 只為測試注入（jsdom 沒有 canvas／createImageBitmap）。
 */

/** 選檔 `<input accept>`；本函式另檢 `file.type`（Q11）。 */
export const PROVIDER_ICON_ACCEPT = "image/png,image/jpeg,image/webp";
const ACCEPTED_TYPES = new Set(PROVIDER_ICON_ACCEPT.split(","));

/** 對應 i18n `admin.auth.icon.<reason>`。 */
export type ProviderIconResizeFailure = "unsupportedType" | "tooLarge" | "unreadable";

export class ProviderIconResizeError extends Error {
  constructor(readonly reason: ProviderIconResizeFailure) {
    super(reason);
    this.name = "ProviderIconResizeError";
  }
}

export interface ResizeDeps {
  decode(file: File): Promise<ImageBitmap>;
  createCanvas(): HTMLCanvasElement;
}

const browserDeps: ResizeDeps = {
  decode: file => createImageBitmap(file),
  createCanvas: () => document.createElement("canvas"),
};

/** `scale = min(1, 128 / max(w, h))`；每邊至少 1 px（Q12：不放大）。 */
export function providerIconTargetSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, PROVIDER_ICON_SIZE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function resizeProviderIcon(file: File, deps: ResizeDeps = browserDeps): Promise<Blob> {
  if (!ACCEPTED_TYPES.has(file.type)) throw new ProviderIconResizeError("unsupportedType");
  if (file.size > MAX_PROVIDER_ICON_SOURCE_BYTES) throw new ProviderIconResizeError("tooLarge");
  let bitmap: ImageBitmap;
  try {
    bitmap = await deps.decode(file);
  } catch {
    throw new ProviderIconResizeError("unreadable");
  }
  try {
    const { width, height } = providerIconTargetSize(bitmap.width, bitmap.height);
    const canvas = deps.createCanvas();
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new ProviderIconResizeError("unreadable");
    ctx.imageSmoothingQuality = "high";
    // 不填底色：保留透明。
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    if (blob === null) throw new ProviderIconResizeError("unreadable");
    return blob;
  } finally {
    bitmap.close();
  }
}
