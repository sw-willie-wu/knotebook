import { describe, it, expect } from "vitest";
import { detectImageMimeType } from "../../src/uploads/magic-bytes.js";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF87A_BYTES = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00]);
const GIF89A_BYTES = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const WEBP_BYTES = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

describe("detectImageMimeType（Task 9 magic bytes）", () => {
  it("PNG 簽名 → image/png", () => {
    expect(detectImageMimeType(PNG_BYTES)).toBe("image/png");
  });

  it("JPEG 簽名 → image/jpeg", () => {
    expect(detectImageMimeType(JPEG_BYTES)).toBe("image/jpeg");
  });

  it("GIF87a 簽名 → image/gif", () => {
    expect(detectImageMimeType(GIF87A_BYTES)).toBe("image/gif");
  });

  it("GIF89a 簽名 → image/gif", () => {
    expect(detectImageMimeType(GIF89A_BYTES)).toBe("image/gif");
  });

  it("WEBP 簽名（RIFF + offset 8 WEBP）→ image/webp", () => {
    expect(detectImageMimeType(WEBP_BYTES)).toBe("image/webp");
  });

  it("偽裝：純文字內容，即使呼叫端聲稱副檔名/Content-Type 是圖片 → null（只信任 bytes 本身）", () => {
    const fakeImageClaim = { filename: "totally-a.png", contentType: "image/png" };
    const bytes = new TextEncoder().encode("<html>not an image at all</html>");
    expect(detectImageMimeType(bytes)).toBe(null);
    // 上面的 fakeImageClaim 純粹是文件說明用——函式簽名根本不接受這種 metadata，
    // 這正是本測試要驗證的事：偵測結果與任何外部聲稱無關。
    void fakeImageClaim;
  });

  it("截半 header：只有 PNG 簽名前 3 bytes → null", () => {
    expect(detectImageMimeType(Uint8Array.from([0x89, 0x50, 0x4e]))).toBe(null);
  });

  it("截半 header：只有 WEBP 的 RIFF 前綴、bytes 長度不到 offset 8 + WEBP → null", () => {
    expect(detectImageMimeType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00]))).toBe(null);
  });

  it("空 buffer → null", () => {
    expect(detectImageMimeType(Uint8Array.from([]))).toBe(null);
  });

  it("RIFF 容器但不是 WEBP（例如 AVI：offset 8 是 AVI 而非 WEBP）→ null", () => {
    const aviLike = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20]);
    expect(detectImageMimeType(aviLike)).toBe(null);
  });

  it("GIF88a（版本 byte 是 '8'，非合法的 '7'/'9'）→ null", () => {
    expect(detectImageMimeType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x38, 0x61]))).toBe(null);
  });

  it("GIF89b（suffix byte 是 'b'，非合法的 'a'）→ null", () => {
    expect(detectImageMimeType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x62]))).toBe(null);
  });

  it("JPEG 前 2 byte 符合但第 3 byte 非 FF → null", () => {
    expect(detectImageMimeType(Uint8Array.from([0xff, 0xd8, 0x00, 0x00]))).toBe(null);
  });
});
