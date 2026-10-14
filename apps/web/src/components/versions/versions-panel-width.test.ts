import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VERSIONS_PANEL_WIDTH_DEFAULT,
  VERSIONS_PANEL_WIDTH_MAX,
  VERSIONS_PANEL_WIDTH_MIN,
  VERSIONS_PANEL_WIDTH_STEP,
  VERSIONS_PANEL_WIDTH_STORAGE_KEY,
  clampVersionsPanelWidth,
  readVersionsPanelWidth,
  writeVersionsPanelWidth,
} from "./versions-panel-width";

const KEY = "versions.panelWidth";

describe("版本面板寬度工具", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.removeItem(KEY);
  });

  it("常數：預設 320、範圍 240–560、步進 16、獨立的 key（不與 sidebar.width 共用）", () => {
    expect(VERSIONS_PANEL_WIDTH_DEFAULT).toBe(320);
    expect(VERSIONS_PANEL_WIDTH_MIN).toBe(240);
    expect(VERSIONS_PANEL_WIDTH_MAX).toBe(560);
    expect(VERSIONS_PANEL_WIDTH_STEP).toBe(16);
    expect(VERSIONS_PANEL_WIDTH_STORAGE_KEY).toBe(KEY);
  });

  it.each([
    [100, 240],
    [240, 240],
    [300.4, 300],
    [300.6, 301],
    [560, 560],
    [9999, 560],
  ])("clamp(%d) → %d", (input, expected) => {
    expect(clampVersionsPanelWidth(input)).toBe(expected);
  });

  it.each([
    [null, 320],
    ["abc", 320],
    ["", 320],
    ["239", 320],
    ["561", 320],
    ["300.5", 320],
    ["240", 240],
    ["560", 560],
    ["400", 400],
  ])("讀到 %j → %d", (raw, expected) => {
    if (raw !== null) window.localStorage.setItem(KEY, raw);
    expect(readVersionsPanelWidth()).toBe(expected);
  });

  it("讀取丟錯 → 預設", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readVersionsPanelWidth()).toBe(320);
  });

  it("寫入：非預設值存字串；等於預設時移除鍵；寫入丟錯不外洩", () => {
    writeVersionsPanelWidth(400);
    expect(window.localStorage.getItem(KEY)).toBe("400");
    writeVersionsPanelWidth(320);
    expect(window.localStorage.getItem(KEY)).toBeNull();

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeVersionsPanelWidth(400)).not.toThrow();
  });
});
