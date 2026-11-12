import { describe, expect, it, vi } from "vitest";
import { AVATAR_DISPLAY_SIZE, MAX_AVATAR_DISPLAY_BYTES } from "@knotebook/shared";
import { AvatarImageError, decodeImage, renderDisplay, type EncodeDeps } from "./encode";

/** jsdom 沒有 canvas／createImageBitmap：注入替身驗呼叫形；真實編碼由 e2e 覆蓋。 */
function fakeDeps(results: Array<{ type: string; size?: number } | null>, opts: { noContext?: boolean } = {}) {
  const calls: string[] = [];
  const ctx = {
    imageSmoothingQuality: "low" as ImageSmoothingQuality,
    fillStyle: "",
    drawImage: vi.fn(() => calls.push("draw")),
    fillRect: vi.fn(() => calls.push("fill")),
  };
  let n = 0;
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => (opts.noContext ? null : ctx)),
    toBlob: vi.fn((cb: BlobCallback) => {
      calls.push("toBlob");
      const r = results[n++] ?? null;
      cb(r === null ? null : new Blob([new Uint8Array(r.size ?? 10)], { type: r.type }));
    }),
  };
  const deps: EncodeDeps = { createCanvas: () => canvas as unknown as HTMLCanvasElement };
  return { deps, canvas, ctx, calls };
}
const bitmap = { width: 600, height: 400 } as unknown as ImageBitmap;
const crop = { x: 100, y: 0, size: 400 };

describe("renderDisplay", () => {
  it("canvas 256×256、drawImage 來源矩形＝crop、目標＝整個 canvas；webp 直接用", async () => {
    const f = fakeDeps([{ type: "image/webp" }]);
    const blob = await renderDisplay(bitmap, crop, f.deps);
    expect(f.canvas.width).toBe(AVATAR_DISPLAY_SIZE);
    expect(f.canvas.height).toBe(AVATAR_DISPLAY_SIZE);
    expect(f.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(f.ctx.drawImage).toHaveBeenCalledWith(bitmap, 100, 0, 400, 400, 0, 0, AVATAR_DISPLAY_SIZE, AVATAR_DISPLAY_SIZE);
    expect(f.ctx.imageSmoothingQuality).toBe("high");
    expect(f.canvas.toBlob).toHaveBeenCalledTimes(1);
    expect(f.canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/webp", 0.9);
    expect(f.ctx.fillRect).not.toHaveBeenCalled();
    expect(blob.type).toBe("image/webp");
  });

  it("瀏覽器不支援 WebP（toBlob 回 png）→ 先填白底再重畫，改產 image/jpeg 品質 0.9", async () => {
    const f = fakeDeps([{ type: "image/png" }, { type: "image/jpeg" }]);
    const blob = await renderDisplay(bitmap, crop, f.deps);
    expect(f.canvas.toBlob).toHaveBeenCalledTimes(2);
    expect(f.canvas.toBlob).toHaveBeenLastCalledWith(expect.any(Function), "image/jpeg", 0.9);
    expect(f.ctx.fillStyle).toBe("#ffffff");
    expect(f.ctx.fillRect).toHaveBeenCalledWith(0, 0, AVATAR_DISPLAY_SIZE, AVATAR_DISPLAY_SIZE);
    // 順序：畫 → 編 webp → 填白 → 重畫 → 編 jpeg
    expect(f.calls).toEqual(["draw", "toBlob", "fill", "draw", "toBlob"]);
    expect(f.ctx.drawImage).toHaveBeenLastCalledWith(bitmap, 100, 0, 400, 400, 0, 0, AVATAR_DISPLAY_SIZE, AVATAR_DISPLAY_SIZE);
    expect(blob.type).toBe("image/jpeg");
  });

  it("toBlob 回 null（編碼失敗）也走 jpeg 後備", async () => {
    const f = fakeDeps([null, { type: "image/jpeg" }]);
    expect((await renderDisplay(bitmap, crop, f.deps)).type).toBe("image/jpeg");
  });

  it("jpeg 也失敗 → AvatarImageError", async () => {
    const f = fakeDeps([{ type: "image/png" }, null]);
    await expect(renderDisplay(bitmap, crop, f.deps)).rejects.toBeInstanceOf(AvatarImageError);
  });

  it("jpeg 後備產出的不是 jpeg → AvatarImageError", async () => {
    const f = fakeDeps([{ type: "image/png" }, { type: "image/png" }]);
    await expect(renderDisplay(bitmap, crop, f.deps)).rejects.toBeInstanceOf(AvatarImageError);
  });

  it("產物超過顯示圖上限 → AvatarImageError", async () => {
    const f = fakeDeps([{ type: "image/webp", size: MAX_AVATAR_DISPLAY_BYTES + 1 }]);
    await expect(renderDisplay(bitmap, crop, f.deps)).rejects.toBeInstanceOf(AvatarImageError);
  });

  it("剛好等於上限可以", async () => {
    const f = fakeDeps([{ type: "image/webp", size: MAX_AVATAR_DISPLAY_BYTES }]);
    expect((await renderDisplay(bitmap, crop, f.deps)).size).toBe(MAX_AVATAR_DISPLAY_BYTES);
  });

  it("拿不到 2d context → AvatarImageError", async () => {
    const f = fakeDeps([{ type: "image/webp" }], { noContext: true });
    await expect(renderDisplay(bitmap, crop, f.deps)).rejects.toBeInstanceOf(AvatarImageError);
  });
});

describe("decodeImage", () => {
  it("傳 imageOrientation: from-image 並回傳 bitmap", async () => {
    const spy = vi.fn(async () => bitmap);
    vi.stubGlobal("createImageBitmap", spy);
    try {
      const file = new Blob([new Uint8Array(3)], { type: "image/png" });
      await expect(decodeImage(file)).resolves.toBe(bitmap);
      expect(spy).toHaveBeenCalledWith(file, { imageOrientation: "from-image" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("解碼失敗 → AvatarImageError", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => { throw new Error("bad"); }));
    try {
      await expect(decodeImage(new Blob([new Uint8Array(3)]))).rejects.toBeInstanceOf(AvatarImageError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("AvatarImageError", () => {
  it("name 是字面字串（首包檢查用它當 marker，不能被 minify 改掉）", () => {
    expect(new AvatarImageError("x").name).toBe("AvatarImageError");
  });
});
