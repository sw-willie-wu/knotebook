import { describe, it, expect } from "vitest";
import {
  normalizeSlug,
  validateSlug,
  titleSlug,
  extractRefUuid,
  canonicalNotePath,
} from "@knotebook/shared";

describe("normalizeSlug", () => {
  it("NFD -> NFC", () => {
    // Built purely from \u escapes (plain ASCII source) so the NFD vs. NFC
    // distinction can never get silently collapsed by an editor/tool re-encoding
    // the file. NFD: bare "e" + U+0301 combining acute accent (two code units for
    // the accented letter). NFC: U+00E9 precomposed accented "e" (one code unit).
    const nfd = "e\u0301cole";
    const nfc = "\u00e9cole";
    expect(nfd.normalize("NFC")).toBe(nfc); // sanity-check the fixture itself
    expect(nfd).not.toBe(nfc); // and confirm they really are distinct code unit sequences
    expect(normalizeSlug(nfd)).toBe(nfc);
  });

  it("大寫 → 小寫", () => {
    expect(normalizeSlug("Hello-World")).toBe("hello-world");
  });
});

describe("validateSlug", () => {
  it("合法 slug → null", () => {
    expect(validateSlug("hello-world")).toBeNull();
    expect(validateSlug("你好-世界")).toBeNull();
  });

  it("İstanbul lowercase 後帶 combining dot above → charset（不含 \\p{M}）", () => {
    // normalizeSlug("İ") produces "i̇" = i + U+0307 (combining dot above), which is \p{M}
    const s = normalizeSlug("İstanbul");
    expect(validateSlug(s)).toBe("charset");
  });

  it("整串 uuid → uuid_like", () => {
    expect(validateSlug("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe("uuid_like");
  });

  it("report-<uuid> 結尾 → uuid_like", () => {
    expect(validateSlug("report-3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe("uuid_like");
  });

  it("保留字 new → reserved", () => {
    expect(validateSlug("new")).toBe("reserved");
  });

  it("開頭/結尾 dash → dash", () => {
    expect(validateSlug("-a-")).toBe("dash");
    expect(validateSlug("-abc")).toBe("dash");
    expect(validateSlug("abc-")).toBe("dash");
  });

  it("連續 dash → dash", () => {
    expect(validateSlug("a--b")).toBe("dash");
  });

  it("純 dash → dash", () => {
    expect(validateSlug("-")).toBe("dash");
    expect(validateSlug("---")).toBe("dash");
  });

  it("101 字元 → length", () => {
    expect(validateSlug("a".repeat(101))).toBe("length");
  });

  it("空字串 → length", () => {
    expect(validateSlug("")).toBe("length");
  });

  it("100 字元剛好合法 → null", () => {
    expect(validateSlug("a".repeat(100))).toBeNull();
  });

  it("含空白／符號 → charset", () => {
    expect(validateSlug("a b")).toBe("charset");
    expect(validateSlug("a_b")).toBe("charset");
    expect(validateSlug("a.b")).toBe("charset");
  });
});

describe("titleSlug", () => {
  it("中文保留", () => {
    expect(titleSlug("你好世界")).toBe("你好世界");
  });

  it("大小寫保留（titleSlug 不做 lowercase，只有 normalizeSlug 做）、空白轉 dash", () => {
    expect(titleSlug("Hello World")).toBe("Hello-World");
  });

  it('"!!!" → ""', () => {
    expect(titleSlug("!!!")).toBe("");
  });

  it("摺疊連續分隔字元 & 去頭尾 dash", () => {
    expect(titleSlug("  Hello   World!!  ")).toBe("Hello-World");
  });

  it("𠮷 repeat 40 截斷後 encodeURIComponent 不 throw、截斷不產生尾 dash", () => {
    const title = "𠮷".repeat(40);
    const slug = titleSlug(title);
    expect(() => encodeURIComponent(slug)).not.toThrow();
    expect(slug.endsWith("-")).toBe(false);
    expect(Array.from(slug).length).toBeLessThanOrEqual(60);
  });

  it("截斷剛好切在 surrogate pair 中間也不產生半個代理對（不 throw、可安全 encode）", () => {
    // 61 astral chars (each 2 UTF-16 code units) forces the 60-code-point Array.from
    // truncation to land mid-way through the surrogate-pair boundary handling.
    const title = "𠮷".repeat(61);
    const slug = titleSlug(title);
    expect(Array.from(slug).length).toBeLessThanOrEqual(60);
    expect(() => encodeURIComponent(slug)).not.toThrow();
  });

  it("空字串 → 空字串", () => {
    expect(titleSlug("")).toBe("");
  });
});

describe("extractRefUuid", () => {
  it("大寫 uuid 也取得到", () => {
    const uuid = "F47AC10B-58CC-4372-A567-0E02B2C3D479";
    expect(extractRefUuid(`note-${uuid}`)).toBe(uuid.toLowerCase());
  });

  it("小寫 uuid 取得到", () => {
    const uuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    expect(extractRefUuid(uuid)).toBe(uuid);
  });

  it("無 uuid → null", () => {
    expect(extractRefUuid("hello-world")).toBeNull();
  });
});

describe("canonicalNotePath", () => {
  // 三態:(1) 有自訂 slug → 直接用;(2) 無 slug 但 title 可轉出非空 vanity slug →
  // `<titleSlug(title)>-<id>`（vanity 部分僅供好看,查找靠尾碼 uuid,故不強制小寫,
  // 與 extractRefUuid/validateSlug 的 uuid_like 規則相呼應);(3) 無 slug 且 title
  // 轉出空字串 → 純 `<id>`。
  it("有自訂 slug → /notes/<slug>", () => {
    expect(
      canonicalNotePath({ id: "f47ac10b-58cc-4372-a567-0e02b2c3d479", slug: "hello-world", title: "Hello World" })
    ).toBe("/notes/hello-world");
  });

  it("slug 為 null、title 可轉出 vanity slug → /notes/<titleSlug>-<id>", () => {
    expect(
      canonicalNotePath({ id: "f47ac10b-58cc-4372-a567-0e02b2c3d479", slug: null, title: "Hello World" })
    ).toBe("/notes/Hello-World-f47ac10b-58cc-4372-a567-0e02b2c3d479");
  });

  it("slug 為 null 且 title 轉 slug 為空（例如全符號 title）→ 純 /notes/<id>", () => {
    expect(
      canonicalNotePath({ id: "f47ac10b-58cc-4372-a567-0e02b2c3d479", slug: null, title: "!!!" })
    ).toBe("/notes/f47ac10b-58cc-4372-a567-0e02b2c3d479");
  });
});
