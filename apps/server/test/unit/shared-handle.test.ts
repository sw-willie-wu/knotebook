import { describe, expect, it } from "vitest";
import { normalizeHandle, validateHandle } from "@knotebook/shared";

/**
 * #122 PR1 Task 1：handle 驗證與正規化（spec §2b）。
 *
 * 與 slug 的關鍵差異（spec 明文）：**ASCII-only**——handle 是身分識別，跨鍵盤可
 * 輸入性與避免 IDN 同形混淆優先於在地化；正規化只做 A-Z→a-z 的碼位映射，**不
 * transliterate、不用 normalizeSlug**（其 Unicode lowercase 會產生 combining mark）。
 */
describe("normalizeHandle（ASCII lowercase，僅 A-Z→a-z）", () => {
  it("大寫 ASCII 轉小寫", () => {
    expect(normalizeHandle("WiLLie-Wu2")).toBe("willie-wu2");
  });

  it("非 ASCII 字元原樣保留（不 transliterate——交給 validateHandle 拒收）", () => {
    expect(normalizeHandle("İstanbul")).toBe("İstanbul");
    expect(normalizeHandle("Ünsal")).toBe("Ünsal");
  });

  it("土耳其 İ 不得經 Unicode toLowerCase 產生 combining mark（那是 normalizeSlug 的行為，這裡禁止）", () => {
    // 若誤用 String.prototype.toLowerCase()，"İ" 會變成 "i" + U+0307 兩個 code point
    expect(Array.from(normalizeHandle("İ")).length).toBe(1);
  });

  it("不 trim 空白（意圖釘）：空白原樣保留，由 validateHandle 的 charset 拒收", () => {
    expect(normalizeHandle(" Willie ")).toBe(" willie ");
    expect(validateHandle(normalizeHandle(" Willie "))).toBe("charset");
  });

  it("normalize→validate 組合：大寫輸入經正規化後合法", () => {
    expect(validateHandle(normalizeHandle("WILLIE-Wu2"))).toBeNull();
  });
});

describe("validateHandle（1–32、^[a-z0-9-]+$、dash 規則、非 uuid 形；無保留字單）", () => {
  it("合法：小寫英數與中段連字號", () => {
    expect(validateHandle("willie-wu")).toBeNull();
    expect(validateHandle("a")).toBeNull();
    expect(validateHandle("user-3f2a9c1d")).toBeNull(); // DB default 兜底形必須合法
    expect(validateHandle("a".repeat(32))).toBeNull();
  });

  it("長度：空字串與 33 字元皆拒", () => {
    expect(validateHandle("")).toBe("length");
    expect(validateHandle("a".repeat(33))).toBe("length");
  });

  it("長度以 code point 計（比照 validateSlug）：34 code unit／17 code point 的 emoji 串落 charset 而非 length", () => {
    // 把實作改回 normalized.length（code unit）這條會回 "length" 而紅——守住 code-point 決定
    expect(validateHandle("😀".repeat(17))).toBe("charset");
  });

  it("charset：非 ASCII、底線、點、空白、大寫（未正規化）皆拒", () => {
    expect(validateHandle("ünsal")).toBe("charset");
    expect(validateHandle("willie_wu")).toBe("charset");
    expect(validateHandle("willie.wu")).toBe("charset");
    expect(validateHandle("willie wu")).toBe("charset");
    expect(validateHandle("Willie")).toBe("charset");
    // İ 經錯誤的 Unicode lowercase 產生的 combining mark 形也在 charset 這關被擋
    expect(validateHandle("i̇stanbul")).toBe("charset");
  });

  it("dash：頭尾與連續連字號拒收", () => {
    expect(validateHandle("-abc")).toBe("dash");
    expect(validateHandle("abc-")).toBe("dash");
    expect(validateHandle("a--b")).toBe("dash");
    expect(validateHandle("-")).toBe("dash");
  });

  it("uuid 形拒收（完整 uuid 也同時超長——兩個規則各自成立，斷言非 null 即可）", () => {
    expect(validateHandle("550e8400-e29b-41d4-a716-446655440000")).not.toBeNull();
  });

  it("反向釘（plan m4）：handle **無保留字單**——api/new/settings/admin/login 都是合法 handle（spec 的否定性決定：handle 恆在 /n/ /p/ 第二段，零路由衝突面）", () => {
    for (const word of ["api", "new", "settings", "admin", "login", "notes", "p", "n", "g", "u"]) {
      expect(validateHandle(word), word).toBeNull();
    }
  });
});
