import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "./index.js";
import {
  BUILTIN_ACTION_IDS, CONTINUE_WRITING_ACTION_ID, FOCUS_MAX_CODE_POINTS, INSTRUCT_ACTION_ID, INSTRUCTION_MAX_CODE_POINTS,
  REWRITE_ACTION_ID, SUMMARIZE_ACTION_ID, TRANSLATE_ACTION_ID, aiActionKind, codePointLength, truncateCodePoints,
} from "./ai.js";

describe("AI 動作常數（#263 spec §4.1、§4.3）", () => {
  it("內建五個 id：既有四個值不變、Instruct 是固定的小寫 uuid、順序固定且不重複", () => {
    expect([REWRITE_ACTION_ID, TRANSLATE_ACTION_ID, SUMMARIZE_ACTION_ID, CONTINUE_WRITING_ACTION_ID]).toEqual([
      "ab0a1517-bec1-4709-b13f-756548375b86",
      "362788cb-d2f0-41ce-b697-c929b67bf20e",
      "2e37a47e-a6cd-4f14-b2f6-0cdebd715b2a",
      "4a8e18da-1d9c-4be1-ba32-a0c5429b0a22",
    ]);
    expect(INSTRUCT_ACTION_ID).toBe("58ef60fd-e99e-4f19-aa57-6fea5e652749");
    expect(BUILTIN_ACTION_IDS).toEqual([
      REWRITE_ACTION_ID, TRANSLATE_ACTION_ID, SUMMARIZE_ACTION_ID, CONTINUE_WRITING_ACTION_ID, INSTRUCT_ACTION_ID,
    ]);
    expect(new Set(BUILTIN_ACTION_IDS).size).toBe(5);
  });

  it("上限：instruction 500、focus 2000（code point）", () => {
    expect([INSTRUCTION_MAX_CODE_POINTS, FOCUS_MAX_CODE_POINTS]).toEqual([500, 2000]);
  });

  it("kind：只有 Instruct 是 instruct，其餘內建與任意自訂 id 都是 quick", () => {
    expect(aiActionKind(INSTRUCT_ACTION_ID)).toBe("instruct");
    for (const id of BUILTIN_ACTION_IDS.filter((x) => x !== INSTRUCT_ACTION_ID)) expect(aiActionKind(id)).toBe("quick");
    expect(aiActionKind("00000000-0000-4000-8000-000000000000")).toBe("quick");
  });

  it("code point：emoji（surrogate pair）算 1；截斷不切半個 emoji、沒超過就原樣回傳", () => {
    const emoji = "😀".repeat(3);
    expect(codePointLength(emoji)).toBe(3);
    expect(emoji.length).toBe(6);
    expect(truncateCodePoints(emoji, 2)).toBe("😀😀");
    expect(truncateCodePoints("abc", 5)).toBe("abc");
    expect(truncateCodePoints("", 0)).toBe("");
  });

  it("錯誤碼 instruct_preview_only 在 ERROR_CODES（§4.4）", () => {
    expect(ERROR_CODES).toContain("instruct_preview_only");
  });
});
