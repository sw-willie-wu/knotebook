import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { baseLabel, baseLabelOrDeleted, currentSubtitle, shortVersionId, versionLabel, versionName } from "./version-labels";

// #272 §10.1（D5、D6'、D12）。
const ID = "3F2A9C1E-7b4d-4e8a-9c21-5d6e7f8a9b0c";
const en = i18n.getFixedT("en");
const zh = i18n.getFixedT("zh-TW");

describe("版本標籤（#272 §10.1）", () => {
  it("shortVersionId：uuid 前 7 碼、小寫", () => {
    expect(shortVersionId(ID)).toBe("3f2a9c1");
  });

  it("versionLabel：有名稱 →「名稱 (短 id)」（自動、手動一樣）；沒名稱 → uuid 推名", () => {
    expect(versionLabel({ id: ID, name: "定稿" })).toBe("定稿 (3f2a9c1)");
    expect(versionLabel({ id: ID, name: null })).toBe("plucky-finch (3f2a9c1)");
    expect(versionName({ id: ID, name: null })).toBe("plucky-finch");
    expect(versionName({ id: ID, name: "定稿" })).toBe("定稿");
  });

  it("baseLabel 三態：未刪 → 標籤；已刪且有 id → 推名＋短 id＋(deleted)（不用原名）；升級前就已刪（id null）→ a deleted version", () => {
    expect(baseLabel(en, { id: ID, name: "定稿", deleted: false })).toBe("定稿 (3f2a9c1)");
    expect(baseLabel(en, { id: ID, name: "定稿", deleted: true })).toBe("plucky-finch (3f2a9c1) (deleted)");
    expect(baseLabel(en, { id: null, name: null, deleted: true })).toBe("a deleted version");
    expect(baseLabel(zh, { id: ID, name: null, deleted: true })).toBe("plucky-finch (3f2a9c1)（已刪除）");
  });

  it("currentSubtitle：沒有基底／沿自（無修改、有修改）／基底已刪", () => {
    expect(currentSubtitle(en, { baseSeq: null, base: null, dirty: true, nextSeq: 1, autoEnabled: true })).toBe("No base version");
    expect(currentSubtitle(en, { baseSeq: 3, base: { id: ID, name: null, deleted: false }, dirty: false, nextSeq: 4, autoEnabled: true })).toBe("Based on plucky-finch (3f2a9c1) · no changes");
    expect(currentSubtitle(zh, { baseSeq: 3, base: { id: ID, name: "定稿", deleted: true }, dirty: true, nextSeq: 4, autoEnabled: true })).toBe("沿自 plucky-finch (3f2a9c1)（已刪除） · 有未儲存的修改");
  });

  it("baseLabelOrDeleted：有 baseSeq 卻沒有 base（DTO 漂移）→ 當成已刪除的版本，不留空白（目前狀態與列第二行共用）", () => {
    expect(baseLabelOrDeleted(en, null)).toBe("a deleted version");
    expect(baseLabelOrDeleted(en, { id: ID, name: null, deleted: false })).toBe("plucky-finch (3f2a9c1)");
    expect(currentSubtitle(en, { baseSeq: 3, base: null, dirty: false, nextSeq: 4, autoEnabled: true })).toBe("Based on a deleted version · no changes");
  });
});
