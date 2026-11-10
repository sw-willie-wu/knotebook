import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECENT_COLORS_KEY,
  RECENT_COLORS_MAX,
  pushRecentColor,
  readRecentColors,
  resetRecentColorsForTest,
} from "./recent-colors";

beforeEach(() => {
  localStorage.clear();
  resetRecentColorsForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("recent colors", () => {
  it("RC1 starts empty and puts the newest first", () => {
    expect(readRecentColors()).toEqual([]);
    pushRecentColor("#111111");
    pushRecentColor("#222222");
    expect(pushRecentColor("#333333")).toEqual(["#333333", "#222222", "#111111"]);
    expect(readRecentColors()).toEqual(["#333333", "#222222", "#111111"]);
  });

  it("RC2 moves a repeated color to the front without duplicating", () => {
    pushRecentColor("#111111");
    pushRecentColor("#222222");
    pushRecentColor("#333333");
    expect(pushRecentColor("#111111")).toEqual(["#111111", "#333333", "#222222"]);
  });

  it("RC3 keeps at most RECENT_COLORS_MAX entries, newest first", () => {
    const all: string[] = [];
    for (let i = 0; i < 10; i++) {
      const hex = `#${String(i).repeat(6)}`;
      all.push(hex);
      pushRecentColor(hex);
    }
    const list = readRecentColors();
    expect(list).toHaveLength(RECENT_COLORS_MAX);
    expect(list).toEqual(all.slice(-RECENT_COLORS_MAX).reverse());
  });

  it("RC4 ignores bad JSON and filters out non-canonical entries", () => {
    localStorage.setItem(RECENT_COLORS_KEY, "not json");
    expect(readRecentColors()).toEqual([]);
    resetRecentColorsForTest();
    localStorage.setItem(
      RECENT_COLORS_KEY,
      '["#ff6600","RED",3,"#FF0000","#00ff00"]',
    );
    expect(readRecentColors()).toEqual(["#ff6600", "#00ff00"]);
  });

  it("RC5 survives a throwing localStorage and keeps the list in memory", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => pushRecentColor("#111111")).not.toThrow();
    expect(() => pushRecentColor("#222222")).not.toThrow();
    expect(readRecentColors()).toEqual(["#222222", "#111111"]);
  });

  it("RC7 keeps colors another tab wrote to storage since the last read", () => {
    pushRecentColor("#111111");
    expect(readRecentColors()).toEqual(["#111111"]);
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(["#444444", "#111111"]));
    expect(pushRecentColor("#555555")).toEqual(["#555555", "#444444", "#111111"]);
  });

  it("RC6does not record non-canonical values", () => {
    expect(pushRecentColor("red")).toEqual([]);
    expect(pushRecentColor("#FF6600")).toEqual([]);
    expect(readRecentColors()).toEqual([]);
  });
});
