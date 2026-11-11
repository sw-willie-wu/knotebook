import { beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { buildSequence, stopTitle } from "./sequence";
import { FULL_TOUR, STOPS, type StopId } from "./stops";

describe("buildSequence", () => {
  it("序列照完整導覽的順序，最後一站是 userMenu，沒有任何一站帶版本標記", () => {
    const seq = buildSequence(FULL_TOUR);
    expect(seq.map((e) => e.id)).toEqual([...FULL_TOUR]);
    expect(seq[seq.length - 1]!.id).toBe("userMenu");
    for (const entry of seq) expect(Object.keys(entry)).toEqual(["id"]);
  });

  it("不改呼叫端傳入的陣列", () => {
    const full: [StopId, ...StopId[]] = ["tabs", "userMenu"];
    buildSequence(full);
    expect(full).toEqual(["tabs", "userMenu"]);
  });
});

describe("stopTitle", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("標題就是站點標題，兩種語言都沒有版本前綴", async () => {
    const title = i18n.t(STOPS.header.titleKey);
    expect(stopTitle(i18n.t, STOPS.header)).toBe(title);
    expect(title).not.toMatch(/New in v|v\d+\.\d+\.\d+/);
    await i18n.changeLanguage("zh-TW");
    const zh = i18n.t(STOPS.header.titleKey);
    expect(stopTitle(i18n.t, STOPS.header)).toBe(zh);
    expect(zh).not.toMatch(/新增：|v\d+\.\d+\.\d+/);
  });
});
