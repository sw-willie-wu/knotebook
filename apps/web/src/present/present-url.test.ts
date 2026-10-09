import { afterEach, describe, expect, it } from "vitest";
import { installFakeFullscreen, type FakeFullscreen } from "@/test/fake-fullscreen";
import { enterPresentationFullscreen, msSinceFullscreenExit } from "./fullscreen";
import {
  exitFullscreenIfLeftPresentation, hashForSlide, isPresentingSearch, PRESENT_PUSHED_KEY, PRESENT_SEARCH,
  presentPushedState, searchWithoutPresent, slideIdFromHash, wasPresentPushed,
} from "./present-url";

describe("present-url", () => {
  it("PRESENT_SEARCH 恰為 ?present；旗標鍵名", () => {
    expect(PRESENT_SEARCH).toBe("?present");
    expect(PRESENT_PUSHED_KEY).toBe("knotebookPresentPushed");
  });

  it.each([
    ["?present", true], ["?present=1", true], ["?a=1&present", true], ["", false], ["?presentation", false], ["?x=present", false],
  ])("isPresentingSearch(%j) → %s", (search, expected) => {
    expect(isPresentingSearch(search)).toBe(expected);
  });

  it.each([
    ["?present", ""], ["?present&a=1", "?a=1"], ["?a=1&present&b=2", "?a=1&b=2"], ["", ""],
  ])("searchWithoutPresent(%j) → %j", (search, expected) => {
    expect(searchWithoutPresent(search)).toBe(expected);
  });

  it("presentPushedState 只放旗標；wasPresentPushed 只認 true", () => {
    expect(presentPushedState()).toEqual({ knotebookPresentPushed: true });
    expect(wasPresentPushed({ knotebookPresentPushed: true, knotebookCanonicalizedFrom: "/x" })).toBe(true);
    expect(wasPresentPushed({ knotebookPresentPushed: "true" })).toBe(false);
    expect(wasPresentPushed(null)).toBe(false);
  });

  it("hash 往返：hashForSlide／slideIdFromHash", () => {
    expect(hashForSlide("_title")).toBe("#/_title");
    expect(slideIdFromHash(hashForSlide("a b"))).toBe("a b");
  });

  it.each(["#/%E0%A4%A", "#/", "#x", "", "#"])("RF1：畸形或空的 hash %j → null、不 throw", (hash) => {
    expect(slideIdFromHash(hash)).toBeNull();
  });
});

describe("exitFullscreenIfLeftPresentation（§6.5 卸載型呼叫點：讀真實網址）", () => {
  let fake: FakeFullscreen | null = null;
  afterEach(async () => {
    await fake?.uninstall();
    fake = null;
    window.history.replaceState(null, "", "/");
  });

  it("網址仍含 present（StrictMode 假卸載）→ 不退；不含 → 退", async () => {
    fake = installFakeFullscreen();
    enterPresentationFullscreen();
    await fake.grantEventFirst();

    window.history.replaceState(null, "", "/n/a/b?present");
    exitFullscreenIfLeftPresentation();
    expect(fake.exitFullscreen).not.toHaveBeenCalled();

    window.history.replaceState(null, "", "/n/a/b");
    exitFullscreenIfLeftPresentation();
    expect(fake.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("fake 的 uninstall 把模組的 lastExitAt 歸 0：之後沒裝 fake 的案 msSinceFullscreenExit() 是 Infinity（不被防連退吃掉）", async () => {
    fake = installFakeFullscreen();
    enterPresentationFullscreen();
    await fake.grantEventFirst();
    await fake.userExit();
    await fake.uninstall();
    fake = null;
    expect(msSinceFullscreenExit()).toBe(Infinity);
  });
});
