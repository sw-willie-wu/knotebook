import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import zhTW from "./zh-TW.json";
import en from "./en.json";
import groupsAdminEn from "./groups-admin.en.json";
import groupsAdminZhTW from "./groups-admin.zh-TW.json";
import managementZhTW from "./management.zh-TW.json";

/**
 * #181 trash copy literals (zh-TW). Changing these strings changes product copy: confirm with the maintainer first.
 * Two deliberate choices: there is no "less than 1 day"; the site description sentence uses the precise version (at most 2,000 notes each time).
 */
const SPEC_COPY: Record<string, string> = {
  "sidebar.trash": "垃圾桶",
  "trash.empty": "垃圾桶是空的。",
  "trash.footerNever": "垃圾桶不會自動清除",
  "trash.moved": "已移到垃圾桶",
  "trash.undo": "復原",
  "trash.purgeDescription": "筆記與附件會永久刪除，無法復原。",
  "trash.emptyTitle": "清空垃圾桶？",
  "trash.includesOthers": "（含其他成員刪除的）",
  "trash.inTrashTitle": "這篇筆記在垃圾桶裡",
  "trash.goToTrash": "前往垃圾桶",
  "note.menu.delete": "刪除",
  "admin.trash.description":
    "筆記移到垃圾桶後，超過保留天數會自動永久刪除（每小時檢查一次）。縮短天數時，已超過新天數的筆記會從下一次檢查開始刪除（每次最多 2,000 篇）。",
  "storage.trashNote": "垃圾桶裡的筆記也計入用量，永久刪除後才會釋放。",
  "groups.roles.flags.delete.description": "把群組筆記移到垃圾桶。同時有編輯權的話，還能在垃圾桶裡還原或永久刪除。",
  "groups.roles.deleteWithoutEditHint": "沒有編輯權的話，刪掉的筆記自己無法從垃圾桶還原。",
  "groups.delete.transferTrashNote": "垃圾桶裡的群組筆記會進 {{name}} 的個人垃圾桶，保留期照原刪除時間計算；它們的公開連結同樣會關閉。",
  "groups.delete.deleteDescriptionNoCount": "群組裡的筆記（含垃圾桶裡的）連同附件與修改紀錄會永久刪除，不會進垃圾桶，無法復原。",
};

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe("trash copy literals (zh-TW)", () => {
  for (const [key, text] of Object.entries(SPEC_COPY)) {
    // admin.* / settings.* strings are in the lazy bundle (management.*.json), groups.* ones in groups-admin.*.json, the rest in the main file.
    const source = key.startsWith("admin.") ? managementZhTW : key.startsWith("groups.") ? groupsAdminZhTW : zhTW;
    it(key, () => expect(get(source, key)).toBe(text));
  }

  it("trash.daysLeft (count=3) -> 「剩 3 天」", () => {
    expect(i18n.t("trash.daysLeft", { count: 3, lng: "zh-TW" })).toBe("剩 3 天");
  });

  it("neither locale has trash.lessThanDay (ceil, minimum 1)", () => {
    expect(get(zhTW, "trash.lessThanDay")).toBeUndefined();
    expect(get(en, "trash.lessThanDay")).toBeUndefined();
  });

  it("en note.menu.delete is 'Delete'", () => {
    expect(get(en, "note.menu.delete")).toBe("Delete");
  });

  it("en groups.delete.deleteDescriptionNoCount has 'including those in its trash' and \"they don't go to the trash\"", () => {
    expect(get(groupsAdminEn, "groups.delete.deleteDescriptionNoCount")).toBe(
      "The group's notes (including those in its trash), their attachments and their edit history are permanently deleted — they don't go to the trash. This can't be undone.",
    );
  });
});

describe("delete-confirmation copy removed (moving to the trash needs no confirmation)", () => {
  for (const key of ["home.deleteTitle", "home.deleteDescription", "home.delete"]) {
    it(key, () => {
      expect(get(en, key)).toBeUndefined();
      expect(get(zhTW, key)).toBeUndefined();
    });
  }
});

describe("personal destination and section label are uniformly 「我的筆記」 (tab and menu share the name)", () => {
  for (const key of ["note.menu.personalSpace", "trash.sectionPersonal"]) {
    it(`${key} removed in both locales (replaced by sidebar.myNotes)`, () => {
      expect(get(en, key)).toBeUndefined();
      expect(get(zhTW, key)).toBeUndefined();
    });
  }

  it("zh trash.emptyPersonal_other (count=3) -> 「我的筆記 3 篇」", () => {
    expect(i18n.t("trash.emptyPersonal", { count: 3, lng: "zh-TW" })).toBe("我的筆記 3 篇");
  });

  it("en trash.emptyPersonal_one (count=1) -> 'My notes: 1 note'", () => {
    expect(i18n.t("trash.emptyPersonal", { count: 1, lng: "en" })).toBe("My notes: 1 note");
  });
});
