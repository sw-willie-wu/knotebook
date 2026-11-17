import { describe, expect, it } from "vitest";
import { loadedMediaLightbox, loadMediaLightbox, prefetchMediaLightbox } from "./lightbox-chunk";

describe("lightbox-chunk", () => {
  it("同一個 promise；載好後 loadedMediaLightbox 回模組；預取不重複觸發", async () => {
    expect(loadedMediaLightbox()).toBeNull();
    prefetchMediaLightbox();
    const first = loadMediaLightbox();
    expect(loadMediaLightbox()).toBe(first);
    const mod = await first;
    expect(loadedMediaLightbox()).toBe(mod);
    prefetchMediaLightbox();
    expect(loadMediaLightbox()).toBe(first);
  });
});
