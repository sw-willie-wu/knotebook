import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteDto, TrashItemDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { EDITOR_PERMS, OWNER_PERMS, VIEWER_PERMS } from "@/test/fixtures";
import {
  canRestoreAfterTrash,
  DAY_MS,
  remainingLabel,
  selectedTrashIds,
  splitTrashSections,
  trashDetailLine,
  trashItemTitle,
  trashLocationLine,
  trashResultMessage,
} from "./trash-display";

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const HOUR = 3_600_000;
const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);
const iso = (ms: number) => new Date(ms).toISOString();
const SHORT = { dateStyle: "short", timeStyle: "short" } as const;

function item(over: Partial<TrashItemDto> & { id: string }): TrashItemDto {
  return {
    title: `T-${over.id}`,
    deletedAt: iso(NOW - 2 * DAY_MS),
    purgeAt: iso(NOW + 3 * DAY_MS),
    deletedBy: { handle: "tester", displayName: "Tester" },
    group: null,
    folderPath: [],
    ...over,
  };
}

const GROUP = { id: "g1", name: "R&D" };
const AMY = { handle: "amy", displayName: "Amy" };

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("remainingLabel", () => {
  const at = (ms: number) => remainingLabel(iso(NOW + ms), NOW, t);

  it("TD1 ceil、最小 1；null → null", () => {
    expect(at(3.5 * DAY_MS)).toBe("4 days left");
    expect(at(DAY_MS)).toBe("1 day left");
    expect(at(DAY_MS + 1)).toBe("2 days left");
    expect(at(23 * HOUR)).toBe("1 day left");
    expect(at(-2 * HOUR)).toBe("1 day left");
    expect(at(7 * DAY_MS - 60_000)).toBe("7 days left");
    expect(remainingLabel(null, NOW, t)).toBeNull();
  });

  it("TD1 zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    expect(at(3.5 * DAY_MS)).toBe("剩 4 天");
  });
});

describe("trashDetailLine", () => {
  const line = (i: TrashItemDto, locale = "en") => trashDetailLine(i, { now: NOW, t, locale });
  const deletedDate = new Date(NOW - 2 * DAY_MS).toLocaleDateString("en");

  it("TD2 個人：只有時間段；NULL 保留天數 → 刪除日期", () => {
    expect(line(item({ id: "p" }))).toBe("3 days left");
    expect(line(item({ id: "p", purgeAt: null }))).toBe(`Deleted ${deletedDate}`);
  });

  it("TD2 群組：群組名 · 刪除者 · 剩餘", () => {
    expect(line(item({ id: "w", group: GROUP, deletedBy: AMY }))).toBe("R&D · Deleted by Amy · 3 days left");
  });

  it("TD2 群組：刪除者帳號已刪", () => {
    expect(line(item({ id: "w", group: GROUP, deletedBy: null }))).toBe("R&D · Deleted by a deleted account · 3 days left");
  });

  it("TD2 群組＋NULL 保留天數：時間段只放日期", () => {
    expect(line(item({ id: "w", group: GROUP, deletedBy: AMY, purgeAt: null }))).toBe(`R&D · Deleted by Amy · ${deletedDate}`);
  });

  it("TD2 zh-TW 群組", async () => {
    await i18n.changeLanguage("zh-TW");
    expect(line(item({ id: "w", group: GROUP, deletedBy: AMY }), "zh-TW")).toBe("R&D · Amy 刪除 · 剩 3 天");
  });
});

describe("trashDetailLine × 資料夾路徑（資料夾 spec §6.9）", () => {
  const line = (i: TrashItemDto, locale = "en") => trashDetailLine(i, { now: NOW, t, locale });
  const RD = { id: "g2", name: "研發組" };

  it("TD-F1 個人 [A, B]、剩 3 天 → A › B · 3 days left（無「我的筆記」前綴）", () => {
    expect(line(item({ id: "p", folderPath: ["A", "B"] }))).toBe("A › B · 3 days left");
  });

  it("TD-F2 群組 [團隊週報]：en 由既有鍵組；zh 研發組 › 團隊週報 · Amy 刪除 · 剩 3 天", async () => {
    const w = item({ id: "w", group: RD, deletedBy: AMY, folderPath: ["團隊週報"] });
    expect(line(w)).toBe("研發組 › 團隊週報 · Deleted by Amy · 3 days left");
    await i18n.changeLanguage("zh-TW");
    expect(line(w, "zh-TW")).toBe("研發組 › 團隊週報 · Amy 刪除 · 剩 3 天");
  });
});

describe("trashLocationLine（第二行的 title，資料夾 spec §6.9「太長：title 給完整路徑」）", () => {
  it("TP-F1 個人 [A, B] → A › B（無「我的筆記」前綴、不含時間段）", () => {
    expect(trashLocationLine(item({ id: "p", folderPath: ["A", "B"] }))).toBe("A › B");
  });

  it("TP-F2 群組 [團隊週報] → 研發組 › 團隊週報", () => {
    expect(trashLocationLine(item({ id: "w", group: { id: "g2", name: "研發組" }, deletedBy: AMY, folderPath: ["團隊週報"] }))).toBe("研發組 › 團隊週報");
  });

  it("TP-F3 個人根層 → 空字串；群組根層 → 群組名", () => {
    expect(trashLocationLine(item({ id: "r" }))).toBe("");
    expect(trashLocationLine(item({ id: "g", group: GROUP }))).toBe("R&D");
  });
});

describe("trashItemTitle", () => {
  it("TD3 有 purgeAt：兩個時間；NULL：只有移入時間", () => {
    const i = item({ id: "a" });
    const deletedAt = new Date(i.deletedAt).toLocaleString("en", SHORT);
    const purgeAt = new Date(i.purgeAt!).toLocaleString("en", SHORT);
    const withPurge = trashItemTitle(i, { t, locale: "en" });
    expect(withPurge).toContain(deletedAt);
    expect(withPurge).toContain(purgeAt);
    const noPurge = trashItemTitle({ ...i, purgeAt: null }, { t, locale: "en" });
    expect(noPurge).toContain(deletedAt);
    expect(noPurge).not.toContain(purgeAt);
    expect(noPurge).not.toContain("to be permanently deleted");
  });
});

describe("日期 formatter 快取（final review M-1）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 每案用別處沒用過的語系：快取是模組層的，用過的語系不會再建。
  it("TD8 同語系每種格式只建一次 Intl.DateTimeFormat；剩餘天數有值時不格式化刪除日期；輸出同 toLocale*", () => {
    const ctor = vi.spyOn(Intl, "DateTimeFormat");
    const items = [item({ id: "a" }), item({ id: "b", deletedAt: iso(NOW - 5 * DAY_MS) }), item({ id: "c", group: GROUP })];

    for (const i of items) trashDetailLine(i, { now: NOW, t, locale: "fr-CA" });
    expect(ctor).not.toHaveBeenCalled();

    const titles = items.map((i) => trashItemTitle(i, { t, locale: "fr-CA" }));
    const lines = items.map((i) => trashDetailLine({ ...i, purgeAt: null }, { now: NOW, t, locale: "fr-CA" }));
    expect(ctor).toHaveBeenCalledTimes(2);
    items.forEach((i, n) => {
      expect(titles[n]).toContain(new Date(i.deletedAt).toLocaleString("fr-CA", SHORT));
      expect(titles[n]).toContain(new Date(i.purgeAt!).toLocaleString("fr-CA", SHORT));
      expect(lines[n]).toContain(new Date(i.deletedAt).toLocaleDateString("fr-CA"));
    });

    trashItemTitle(items[0]!, { t, locale: "de-CH" });
    expect(ctor).toHaveBeenCalledTimes(3);
  });
});

describe("splitTrashSections", () => {
  it("TD4 個人在前、各區保留輸入順序；不改輸入陣列", () => {
    const w1 = item({ id: "w1", group: GROUP });
    const p1 = item({ id: "p1" });
    const w2 = item({ id: "w2", group: GROUP });
    const p2 = item({ id: "p2" });
    const input = [w1, p1, w2, p2];
    const sections = splitTrashSections(input);
    expect(sections.personal).toEqual([p1, p2]);
    expect(sections.workspace).toEqual([w1, w2]);
    expect(sections.order).toEqual(["note:p1", "note:p2", "note:w1", "note:w2"]);
    expect(input).toEqual([w1, p1, w2, p2]);
  });
});

describe("selectedTrashIds", () => {
  it("TD7 照清單順序（個人在前）、略過不在清單的鍵", () => {
    const w1 = item({ id: "w1", group: GROUP });
    const p1 = item({ id: "p1" });
    const p2 = item({ id: "p2" });
    // 勾選順序 w1 → p2 → p1，外加一個清單上沒有的鍵（重抓後消失）。
    const keys = new Set(["note:w1", "note:gone", "note:p2", "note:p1"]);
    expect(selectedTrashIds([w1, p1, p2], keys)).toEqual(["p1", "p2", "w1"]);
    expect(selectedTrashIds([w1, p1, p2], new Set(["note:gone"]))).toEqual([]);
  });
});

describe("canRestoreAfterTrash", () => {
  const groupNote = (permissions: NoteDto["permissions"]): Pick<NoteDto, "group" | "permissions"> => ({ group: GROUP, permissions });

  it("TD5 個人恆可；群組要 edit 且 delete", () => {
    expect(canRestoreAfterTrash({ group: null, permissions: VIEWER_PERMS })).toBe(true);
    expect(canRestoreAfterTrash(groupNote(OWNER_PERMS))).toBe(true);
    expect(canRestoreAfterTrash(groupNote({ ...VIEWER_PERMS, delete: true }))).toBe(false);
    expect(canRestoreAfterTrash(groupNote({ ...EDITOR_PERMS, delete: false }))).toBe(false);
  });
});

describe("trashResultMessage", () => {
  it("TD6 en：skipped 為 0 不加後綴", () => {
    expect(trashResultMessage("restore", 2, 0, t)).toBe("Restored 2 notes");
    expect(trashResultMessage("restore", 1, 1, t)).toBe("Restored 1 note, 1 no longer in the trash");
    expect(trashResultMessage("purge", 3, 0, t)).toBe("Permanently deleted 3 notes");
  });

  it("TD6 zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    expect(trashResultMessage("restore", 1, 2, t)).toBe("已還原 1 篇，2 篇已不在垃圾桶");
  });
});
