import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/knowledge-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import knowledgeEn from "./knowledge.en.json";
import knowledgeZhTW from "./knowledge.zh-TW.json";
import knowledgeEnRaw from "./knowledge.en.json?raw";
import knowledgeZhTWRaw from "./knowledge.zh-TW.json?raw";

/** Lazy string bundle for knowledge info (`knowledge.*`), registered only by the lazy knowledge chain via `knowledge-strings.ts`. */

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function duplicateKeys(raw: string): string[] {
  const dups: string[] = [];
  const stack: { keys: Set<string> | null; expectKey: boolean }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const top = stack[stack.length - 1];
    if (ch === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (ch === "[") stack.push({ keys: null, expectKey: false });
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ":" && top) top.expectKey = false;
    else if (ch === "," && top?.keys) top.expectKey = true;
    else if (ch === '"') {
      let j = i + 1;
      while (raw[j] !== '"') j += raw[j] === "\\" ? 2 : 1;
      if (top?.keys && top.expectKey) {
        const key = raw.slice(i + 1, j);
        if (top.keys.has(key)) dups.push(key);
        top.keys.add(key);
      }
      i = j;
    }
  }
  return dups;
}

describe("knowledge bundle: both locales have the same key set, top level is only knowledge", () => {
  it("same key set", () => {
    expect(flattenKeys(knowledgeZhTW).sort()).toEqual(flattenKeys(knowledgeEn).sort());
  });

  it("exactly one top-level key, knowledge", () => {
    expect(Object.keys(knowledgeEn)).toEqual(["knowledge"]);
    expect(Object.keys(knowledgeZhTW)).toEqual(["knowledge"]);
  });
});

describe("knowledge copy literals", () => {
  const ZH: Record<string, string> = {
    "knowledge.iconLabel": "知識資訊：{{status}}",
    "knowledge.state.outdated": "過時",
    "knowledge.state.needsReview": "待驗證",
    "knowledge.state.noVerifiedDate": "未驗證",
    "knowledge.state.verified": "已驗證",
    "knowledge.field.when": "何時讀",
    "knowledge.field.conclusion": "結論",
    "knowledge.field.evidence": "依據",
    "knowledge.field.verified": "最後驗證日",
    "knowledge.field.status": "狀態",
    "knowledge.field.supersededBy": "被哪一條取代",
    "knowledge.evidence.tested": "實測",
    "knowledge.evidence.docs": "文件",
    "knowledge.evidence.inferred": "推論",
    "knowledge.evidence.unconfirmed": "未確認",
    "knowledge.status.current": "正常",
    "knowledge.status.unverified": "待驗證",
    "knowledge.status.outdated": "過時",
    "knowledge.card.notVerified": "未驗證",
    "knowledge.card.quotedTitle": "「{{title}}」",
    "knowledge.card.belongsTo": "屬於：{{title}}",
    "knowledge.card.bannerNeedsReview": "待驗證・上次驗證 {{date}}，建議重新確認",
    "knowledge.card.bannerNeedsReviewNoDate": "待驗證・建議重新確認",
    "knowledge.card.bannerOutdated": "過時 → 被<ref/>取代",
    "knowledge.card.bannerInheritedOutdated": "過時：上層<ref/>已過時",
    "knowledge.card.refOtherNote": "另一篇筆記中的知識",
    "knowledge.card.refMissing": "已不存在的知識",
    "knowledge.card.summary": "底下 {{total}} 條：{{verified}} 條已驗證、{{noDate}} 條未驗證、{{review}} 條待驗證",
    "knowledge.card.summaryOutdated": "、{{outdated}} 條過時",
    "knowledge.card.edit": "編輯",
    "knowledge.card.untitled": "未命名標題",
    "knowledge.card.markVerified": "標記為已驗證",
    "knowledge.form.title": "知識資訊",
    "knowledge.form.markToday": "標記今天已驗證",
    "knowledge.form.remove": "移除知識資訊",
    "knowledge.form.save": "儲存",
    "knowledge.form.cancel": "取消",
    "knowledge.form.escHint": "Esc 取消",
    "knowledge.form.error.empty": "至少要填一個欄位。",
    "knowledge.form.error.tooLong": "最多 {{max}} 字（目前 {{n}} 字）。",
    "knowledge.form.error.verifiedInvalid": "請輸入正確的日期。",
    "knowledge.form.error.supersededRequired": "請選擇取代這條的知識。",
    "knowledge.form.error.supersededInvalid": "請從清單中選擇知識。",
    "knowledge.form.error.supersededSelf": "不能選這條自己。",
    "knowledge.form.error.notEligible": "這個標題已不存在，或不能設知識資訊。",
    "knowledge.picker.placeholder": "搜尋知識",
    "knowledge.picker.none": "沒有相符的知識",
  };
  const EN: Record<string, string> = {
    "knowledge.iconLabel": "Knowledge info: {{status}}",
    "knowledge.state.outdated": "Outdated",
    "knowledge.state.needsReview": "Needs review",
    "knowledge.state.noVerifiedDate": "Not verified",
    "knowledge.state.verified": "Verified",
    "knowledge.field.when": "When to read",
    "knowledge.field.conclusion": "Conclusion",
    "knowledge.field.evidence": "Basis",
    "knowledge.field.verified": "Last verified",
    "knowledge.field.status": "Status",
    "knowledge.field.supersededBy": "Replaced by",
    "knowledge.evidence.tested": "Tested",
    "knowledge.evidence.docs": "Documentation",
    "knowledge.evidence.inferred": "Inferred",
    "knowledge.evidence.unconfirmed": "Unconfirmed",
    "knowledge.status.current": "Current",
    "knowledge.status.unverified": "Needs review",
    "knowledge.status.outdated": "Outdated",
    "knowledge.card.notVerified": "Not verified",
    "knowledge.card.quotedTitle": "{{title}}",
    "knowledge.card.belongsTo": "Part of: {{title}}",
    "knowledge.card.bannerNeedsReview": "Needs review · last verified {{date}}, worth checking again",
    "knowledge.card.bannerNeedsReviewNoDate": "Needs review · worth checking again",
    "knowledge.card.bannerOutdated": "Outdated → replaced by <ref/>",
    "knowledge.card.bannerInheritedOutdated": "Outdated: <ref/> above is outdated",
    "knowledge.card.refOtherNote": "knowledge in another note",
    "knowledge.card.refMissing": "knowledge that no longer exists",
    "knowledge.card.summary": "{{total}} below: {{verified}} verified, {{noDate}} not verified, {{review}} need review",
    "knowledge.card.summaryOutdated": ", {{outdated}} outdated",
    "knowledge.card.edit": "Edit",
    "knowledge.card.untitled": "Untitled heading",
    "knowledge.card.markVerified": "Mark as verified",
    "knowledge.form.title": "Knowledge info",
    "knowledge.form.markToday": "Mark verified today",
    "knowledge.form.remove": "Remove knowledge info",
    "knowledge.form.save": "Save",
    "knowledge.form.cancel": "Cancel",
    "knowledge.form.escHint": "Esc to cancel",
    "knowledge.form.error.empty": "Fill in at least one field.",
    "knowledge.form.error.tooLong": "At most {{max}} characters (now {{n}}).",
    "knowledge.form.error.verifiedInvalid": "Enter a valid date.",
    "knowledge.form.error.supersededRequired": "Choose the knowledge that replaces this one.",
    "knowledge.form.error.supersededInvalid": "Choose one of the listed knowledge.",
    "knowledge.form.error.supersededSelf": "A piece of knowledge can't replace itself.",
    "knowledge.form.error.notEligible": "This heading no longer exists or can't hold knowledge info.",
    "knowledge.picker.placeholder": "Search knowledge",
    "knowledge.picker.none": "No matching knowledge",
  };
  for (const [key, text] of Object.entries(ZH)) it(`zh ${key}`, () => expect(get(knowledgeZhTW, key)).toBe(text));
  for (const [key, text] of Object.entries(EN)) it(`en ${key}`, () => expect(get(knowledgeEn, key)).toBe(text));
});

// Read the raw text: deep-merge addResourceBundle merges `knowledge` into the main JSON object from i18n init.
describe("main JSON has no knowledge top-level key (strings go only into the lazy bundle)", () => {
  it.each([
    ["en", enRaw],
    ["zh-TW", zhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(Object.keys(JSON.parse(raw) as object)).not.toContain("knowledge");
  });
});

describe("entry strings for the slash menu and the block menu stay in the main bundle", () => {
  it.each([
    ["en", enRaw, { slashTitle: "Knowledge info", slashSubtext: "Mark this heading as a piece of knowledge", menuItem: "Knowledge info…", menuEditItem: "Edit knowledge info…" }],
    ["zh-TW", zhTWRaw, { slashTitle: "知識資訊", slashSubtext: "把這個標題標成一條知識", menuItem: "知識資訊…", menuEditItem: "編輯知識資訊…" }],
  ] as const)("%s", (_name, raw, expected) => {
    expect((JSON.parse(raw) as { note: { knowledge: unknown } }).note.knowledge).toEqual(expected);
  });
});

describe("available after registration", () => {
  it("knowledge.iconLabel: en / zh-TW", () => {
    expect(i18n.t("knowledge.iconLabel", { status: "Outdated", lng: "en" })).toBe("Knowledge info: Outdated");
    expect(i18n.t("knowledge.iconLabel", { status: "過時", lng: "zh-TW" })).toBe("知識資訊：過時");
  });
});

describe("knowledge bundle has no duplicate keys", () => {
  it.each([
    ["en", knowledgeEnRaw],
    ["zh-TW", knowledgeZhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(duplicateKeys(raw)).toEqual([]);
  });
});
