/**
 * 圖片格式偵測——只信任檔案內容本身（magic bytes），不信任任何呼叫端聲稱的副檔名
 * 或 `Content-Type`：上傳者可任意偽造這兩者，唯有實際 bytes 無法偽造（偽造了就不是
 * 該格式的合法檔案，解碼會失敗）。Task 10a/10b 的上傳路由用本函式的回傳值決定
 * 實際存檔用的副檔名／回應的 `Content-Type`，不採用請求端送來的值。
 */
export type ImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
// GIF87a / GIF89a 共用前 4 bytes "GIF8"，第 5 byte 是版本（'7' 或 '9'），第 6 byte 固定 'a'。
const GIF_PREFIX = [0x47, 0x49, 0x46, 0x38];
const GIF_VERSION_37 = 0x37; // '7'
const GIF_VERSION_39 = 0x39; // '9'
const GIF_SUFFIX_A = 0x61; // 'a'
// WEBP 是 RIFF 容器格式的一種：開頭 4 bytes "RIFF" + 4 bytes 檔案長度（略過不比對）
// + offset 8 起 4 bytes "WEBP"。RIFF 前綴本身不足以斷定是 WEBP（AVI/WAV 等其他格式
// 也用 RIFF 容器），offset 8 的 "WEBP" 才是判斷依據。
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46];
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50];
const WEBP_OFFSET = 8;

function matchesAt(bytes: Uint8Array, signature: readonly number[], offset: number): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/**
 * 偵測 `bytes` 開頭的 magic bytes 是否為支援的圖片格式之一。不支援／bytes 太短
 * （截半 header）／RIFF 容器但不是 WEBP，一律回傳 `null`——呼叫端據此拒絕上傳，
 * 不得對 `null` 做任何格式猜測或退回信任聲稱的副檔名。
 */
export function detectImageMimeType(bytes: Uint8Array): ImageMimeType | null {
  if (matchesAt(bytes, PNG_SIGNATURE, 0)) return "image/png";
  if (matchesAt(bytes, JPEG_SIGNATURE, 0)) return "image/jpeg";
  if (
    matchesAt(bytes, GIF_PREFIX, 0) &&
    (bytes[4] === GIF_VERSION_37 || bytes[4] === GIF_VERSION_39) &&
    bytes[5] === GIF_SUFFIX_A
  ) {
    return "image/gif";
  }
  if (matchesAt(bytes, RIFF_SIGNATURE, 0) && matchesAt(bytes, WEBP_SIGNATURE, WEBP_OFFSET)) return "image/webp";
  return null;
}
