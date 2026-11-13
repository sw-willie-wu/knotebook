import { AVATAR_DISPLAY_SIZE, MAX_AVATAR_DISPLAY_BYTES, type AvatarCropDto } from "@knotebook/shared";

/**
 * 頭貼的瀏覽器端解碼與編碼（獨立 chunk：只能經動態 `import()` 載入，不進首包）。
 * server 不做影像處理，只驗檔頭與大小；顯示圖（256 px 方圖）在這裡產。
 * `deps` 只為測試注入（jsdom 沒有 canvas）。
 */

/** 解碼失敗、編碼失敗或產物超過上限。`name` 寫成字串字面，首包檢查用它當 marker（類別名會被 minify 改掉）。 */
export class AvatarImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvatarImageError";
  }
}

export interface EncodeDeps {
  createCanvas(): HTMLCanvasElement;
}

const browserDeps: EncodeDeps = {
  createCanvas: () => document.createElement("canvas"),
};

const QUALITY = 0.9;

/** 解碼並依 EXIF 轉正（裁切座標以轉正後的圖為準）。呼叫端用完要 `bitmap.close()`。 */
export async function decodeImage(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new AvatarImageError("cannot decode image");
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, QUALITY));
}

/**
 * 把 `crop`（原圖像素座標）畫成 256×256 並編碼：先 WebP；瀏覽器不支援 WebP 時 `toBlob` 會悄悄改回 PNG，
 * 這時填白底（JPEG 沒有透明）重畫再產 JPEG。不關閉 `bitmap`，由呼叫端負責。
 */
export async function renderDisplay(bitmap: ImageBitmap, crop: AvatarCropDto, deps: EncodeDeps = browserDeps): Promise<Blob> {
  const canvas = deps.createCanvas();
  canvas.width = AVATAR_DISPLAY_SIZE;
  canvas.height = AVATAR_DISPLAY_SIZE;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new AvatarImageError("no 2d canvas context");
  ctx.imageSmoothingQuality = "high";
  const draw = () => ctx.drawImage(bitmap, crop.x, crop.y, crop.size, crop.size, 0, 0, AVATAR_DISPLAY_SIZE, AVATAR_DISPLAY_SIZE);
  draw();
  let blob = await toBlob(canvas, "image/webp");
  if (blob === null || blob.type !== "image/webp") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, AVATAR_DISPLAY_SIZE, AVATAR_DISPLAY_SIZE);
    draw();
    blob = await toBlob(canvas, "image/jpeg");
    if (blob === null || blob.type !== "image/jpeg") throw new AvatarImageError("cannot encode image");
  }
  if (blob.size > MAX_AVATAR_DISPLAY_BYTES) throw new AvatarImageError("encoded image too large");
  return blob;
}
