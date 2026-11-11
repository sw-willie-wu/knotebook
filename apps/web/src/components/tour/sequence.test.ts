import { beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { buildSequence, stopTitle } from "./sequence";
import { FULL_TOUR, STOPS, type StopId } from "./stops";

/** 序列只看 id 與「這一版新增」標記；這裡把它攤成好比對的字串。 */
function shape(entries: ReturnType<typeof buildSequence>): string[] {
  return entries.map((e) => (e.newInVersion === null ? e.id : `${e.id}@${e.newInVersion}`));
}

describe("buildSequence", () => {
  it("Q1 highlights 為空：序列就是完整導覽，最後一站是 userMenu", () => {
    const seq = buildSequence(FULL_TOUR, { version: "1.2.3", stops: [] });
    expect(shape(seq)).toEqual([...FULL_TOUR]);
    expect(seq[seq.length - 1]!.id).toBe("userMenu");
  });

  it("Q2 highlights 兩站：照登記的順序插在最後一站（userMenu）之前，帶登記檔的版本", () => {
    const full: [StopId, ...StopId[]] = ["tabs", "search", "userMenu"];
    const seq = buildSequence(full, { version: "1.2.3", stops: ["versions", "header"] });
    expect(shape(seq)).toEqual(["tabs", "search", "versions@1.2.3", "header@1.2.3", "userMenu"]);
  });

  it("Q3 與完整導覽重複的站只出現一次，留在完整導覽裡原本的位置、不帶「這一版新增」標記", () => {
    const full: [StopId, ...StopId[]] = ["tabs", "newNote", "search", "userMenu"];
    const seq = buildSequence(full, { version: "1.2.3", stops: ["header", "newNote", "userMenu", "header"] });
    expect(shape(seq)).toEqual(["tabs", "newNote", "search", "header@1.2.3", "userMenu"]);
  });

  it("不改呼叫端傳入的陣列", () => {
    const full: [StopId, ...StopId[]] = ["tabs", "userMenu"];
    const stops: StopId[] = ["header"];
    buildSequence(full, { version: "1.2.3", stops });
    expect(full).toEqual(["tabs", "userMenu"]);
    expect(stops).toEqual(["header"]);
  });
});

describe("stopTitle", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("完整導覽的站：就是站點標題", () => {
    expect(stopTitle(i18n.t, STOPS.header, null)).toBe(i18n.t(STOPS.header.titleKey));
  });

  it("「這一版新增」的站：標題前綴帶登記檔的版本（兩種語言）", async () => {
    const title = i18n.t(STOPS.header.titleKey);
    expect(stopTitle(i18n.t, STOPS.header, "9.9.9")).toBe(`New in v9.9.9: ${title}`);
    await i18n.changeLanguage("zh-TW");
    expect(stopTitle(i18n.t, STOPS.header, "9.9.9")).toBe(`v9.9.9 新增：${i18n.t(STOPS.header.titleKey)}`);
  });
});
