import { describe, expect, it, vi } from "vitest";
import { MAX_PROVIDER_ICON_SOURCE_BYTES } from "@knotebook/shared";
import { ProviderIconResizeError, providerIconTargetSize, resizeProviderIcon, type ResizeDeps } from "./provider-icon-resize";

/** jsdom 沒有 canvas／createImageBitmap（spec §2.8-6）：注入替身，驗尺寸計算與 MIME。真瀏覽器路徑由 e2e E1 覆蓋。 */
function fakeDeps(size: { width: number; height: number }, opts: { decodeFails?: boolean; noContext?: boolean; nullBlob?: boolean } = {}) {
  const close = vi.fn();
  const bitmap = { ...size, close } as unknown as ImageBitmap;
  const ctx = { drawImage: vi.fn(), imageSmoothingQuality: "low" as ImageSmoothingQuality };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => (opts.noContext ? null : ctx)),
    toBlob: vi.fn((cb: BlobCallback, type?: string) => cb(opts.nullBlob ? null : new Blob([new Uint8Array([0x89, 0x50])], { type }))),
  };
  const deps: ResizeDeps = {
    decode: vi.fn(async () => {
      if (opts.decodeFails) throw new Error("bad image");
      return bitmap;
    }),
    createCanvas: () => canvas as unknown as HTMLCanvasElement,
  };
  return { deps, canvas, ctx, bitmap, close };
}
const png = (bytes = 10, type = "image/png") => new File([new Uint8Array(bytes)], "a.png", { type });
const reasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "resolved";
  } catch (err) {
    return err instanceof ProviderIconResizeError ? err.reason : `other: ${String(err)}`;
  }
};

describe("providerIconTargetSize（spec §6.4 第 4 步、§8.2 W3）", () => {
  it("512×256 → 128×64；64×300 → 27×128；100×50 → 100×50（不放大，Q12）；128×128 不變；極端比例至少 1 px", () => {
    expect(providerIconTargetSize(512, 256)).toEqual({ width: 128, height: 64 });
    expect(providerIconTargetSize(64, 300)).toEqual({ width: 27, height: 128 });
    expect(providerIconTargetSize(100, 50)).toEqual({ width: 100, height: 50 });
    expect(providerIconTargetSize(128, 128)).toEqual({ width: 128, height: 128 });
    expect(providerIconTargetSize(5000, 1)).toEqual({ width: 128, height: 1 });
  });
});

describe("resizeProviderIcon（spec §6.4、§8.2 W3）", () => {
  it("512×256 → canvas 128×64、drawImage(bitmap, 0, 0, 128, 64)、高品質平滑、輸出 image/png；釋放 bitmap", async () => {
    const f = fakeDeps({ width: 512, height: 256 });
    const blob = await resizeProviderIcon(png(), f.deps);
    expect(f.canvas.width).toBe(128);
    expect(f.canvas.height).toBe(64);
    expect(f.ctx.drawImage).toHaveBeenCalledWith(f.bitmap, 0, 0, 128, 64);
    expect(f.ctx.imageSmoothingQuality).toBe("high");
    expect(f.canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(blob.type).toBe("image/png");
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("64×300 → 27×128；100×50 → 100×50（不放大，只重新編碼）", async () => {
    const tall = fakeDeps({ width: 64, height: 300 });
    await resizeProviderIcon(png(), tall.deps);
    expect([tall.canvas.width, tall.canvas.height]).toEqual([27, 128]);
    const small = fakeDeps({ width: 100, height: 50 });
    await resizeProviderIcon(png(), small.deps);
    expect([small.canvas.width, small.canvas.height]).toEqual([100, 50]);
    expect(small.canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
  });

  it("JPEG、WebP 也收（輸出一律 PNG）", async () => {
    for (const type of ["image/jpeg", "image/webp"]) {
      const f = fakeDeps({ width: 10, height: 10 });
      expect((await resizeProviderIcon(png(10, type), f.deps)).type, type).toBe("image/png");
    }
  });

  it("GIF／SVG／空 type → unsupportedType，不解碼（Q11）", async () => {
    for (const type of ["image/gif", "image/svg+xml", ""]) {
      const f = fakeDeps({ width: 10, height: 10 });
      expect(await reasonOf(resizeProviderIcon(png(10, type), f.deps)), type).toBe("unsupportedType");
      expect(f.deps.decode, type).not.toHaveBeenCalled();
    }
  });

  it("> 5 MB → tooLarge，不解碼；剛好 5 MB 放行", async () => {
    const big = fakeDeps({ width: 10, height: 10 });
    expect(await reasonOf(resizeProviderIcon(png(MAX_PROVIDER_ICON_SOURCE_BYTES + 1), big.deps))).toBe("tooLarge");
    expect(big.deps.decode).not.toHaveBeenCalled();
    const edge = fakeDeps({ width: 10, height: 10 });
    expect(await reasonOf(resizeProviderIcon(png(MAX_PROVIDER_ICON_SOURCE_BYTES), edge.deps))).toBe("resolved");
  });

  it("解碼失敗／getContext 回 null／toBlob 回 null → unreadable；解碼後的失敗也釋放 bitmap", async () => {
    expect(await reasonOf(resizeProviderIcon(png(), fakeDeps({ width: 10, height: 10 }, { decodeFails: true }).deps))).toBe("unreadable");
    const noCtx = fakeDeps({ width: 10, height: 10 }, { noContext: true });
    expect(await reasonOf(resizeProviderIcon(png(), noCtx.deps))).toBe("unreadable");
    expect(noCtx.close).toHaveBeenCalledTimes(1);
    const nullBlob = fakeDeps({ width: 10, height: 10 }, { nullBlob: true });
    expect(await reasonOf(resizeProviderIcon(png(), nullBlob.deps))).toBe("unreadable");
    expect(nullBlob.close).toHaveBeenCalledTimes(1);
  });
});
