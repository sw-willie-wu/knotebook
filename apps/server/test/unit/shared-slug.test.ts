import { describe, it, expect } from "vitest";
import {
  normalizeSlug,
  validateSlug,
  titleSlug,
  extractRefUuid,
  canonicalNotePath,
  publicAliasPath,
  autoSlugFromTitle,
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

describe("autoSlugFromTitle", () => {
  it("正常標題 → 小寫 slug", () => {
    expect(autoSlugFromTitle("Hello World")).toBe("hello-world");
  });

  it("合法非 ASCII 候選原封不動穿過首驗——不剝重音（與 0007 SQL 版刻意分歧）", () => {
    expect(autoSlugFromTitle("École Normale")).toBe("école-normale");
    expect(autoSlugFromTitle("Tiếng Việt")).toBe("tiếng-việt");
    expect(autoSlugFromTitle("你好世界")).toBe("你好世界");
  });

  it("uuid 形標題 → untitled（uuid_like 擋下、剝 mark 救不了）", () => {
    expect(autoSlugFromTitle("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe("untitled");
    expect(autoSlugFromTitle("Report 3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe("untitled");
  });

  it("İstanbul → NFD 剝 \\p{M} 後過驗 → istanbul", () => {
    // normalizeSlug("İ") 產 i + U+0307（\p{M}）→ 首驗 charset 紅；剝 mark 後合法
    expect(autoSlugFromTitle("İstanbul")).toBe("istanbul");
  });

  it("首驗失敗才進 fallback，且剝 mark 先 NFD：同串的預組合重音一併被剝", () => {
    // 只有 İ 肇事，但 fallback 是整串去變音符——Café 的 é 一起變 e
    expect(autoSlugFromTitle("İstanbul Café")).toBe("istanbul-cafe");
  });

  it("剝 mark 後回 NFC：產物是 normalizeSlug 的固定點", () => {
    // NFD 會把諺文拆成 conjoining jamo（\p{Lo}，不是 mark 不會被剝）——
    // 少了尾端 NFC 就會回分解形，與 DB 唯一比對用的 NFC 形對不上
    const out = autoSlugFromTitle("İ한글");
    expect(out).toBe("i한글");
    expect(normalizeSlug(out)).toBe(out);
  });

  it("保留字標題 new → untitled", () => {
    expect(autoSlugFromTitle("new")).toBe("untitled");
    expect(autoSlugFromTitle("New")).toBe("untitled");
  });

  it("空標題 → untitled", () => {
    expect(autoSlugFromTitle("")).toBe("untitled");
  });

  it("全符號標題 → untitled", () => {
    expect(autoSlugFromTitle("!!! ??? ***")).toBe("untitled");
  });

  it("untitled 本身是合法 slug（fallback 不會自我打架）", () => {
    expect(validateSlug("untitled")).toBeNull();
  });

  it("截長：>60 字元標題 → 截 60（與 0007 SQL 版同界）", () => {
    // 此組輸入/期望值供 0007 的 SQL/TS 雙實作對照複用（同 PR Task 2）——改值要兩處一起
    const title = "Q3 Planning Meeting Notes For The Whole Engineering Organization Retro";
    expect(autoSlugFromTitle(title)).toBe("q3-planning-meeting-notes-for-the-whole-engineering-organiza");
  });

  it("截斷點恰落在 dash 之後 → 去尾 dash 而非退 untitled", () => {
    // 第 60 個 code point 正是 dash；titleSlug 若少了「截斷後去尾 dash」那步，
    // validateSlug 會判 dash → 整串退 untitled（0007 對照亦複用此值）
    expect(autoSlugFromTitle("a".repeat(59) + " bbbb")).toBe("a".repeat(59));
  });

  it("性質：未被精確釘死的輸入，產物恆過 validateSlug 且為 normalizeSlug 固定點", () => {
    for (const t of ["Ünsal Çelik Ötesi", "𠮷".repeat(61), "ヘッダー The-Header", "école--fancy!!"]) {
      const out = autoSlugFromTitle(t);
      expect(validateSlug(out)).toBeNull();
      expect(normalizeSlug(out)).toBe(out);
    }
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
  // #122 起單一形：`/n/<ownerHandle>/<slug>`（slug NOT NULL、每篇必有 ownerHandle，
  // 舊三態退役）。兩段不做 URL 編碼——handle 是 a-z0-9-、slug 已過 normalizeSlug，
  // 非 ASCII 交給傳輸層（與舊 /notes/<slug> 形同慣例）。
  it("→ /n/<ownerHandle>/<slug>", () => {
    expect(canonicalNotePath({ ownerHandle: "alice", slug: "hello-world" })).toBe("/n/alice/hello-world");
  });

  it("非 ASCII slug 原樣輸出（不預編碼）", () => {
    expect(canonicalNotePath({ ownerHandle: "alice", slug: "café" })).toBe("/n/alice/café");
  });
});

describe("publicAliasPath", () => {
  // #122 PR3：`/p/` 兩段形**頁面**網址組字點（gate m-2 收窄版）——ShareDialog
  // 前綴/複製走它；API 網址另有 web 的 public-note-ref.ts（編碼政策不同、刻意
  // 不共用，見 shared 的 JSDoc）。不編碼理由同 canonicalNotePath。
  it("→ /p/<handle>/<slug>；非 ASCII 原樣", () => {
    expect(publicAliasPath({ handle: "alice", slug: "team-doc" })).toBe("/p/alice/team-doc");
    expect(publicAliasPath({ handle: "alice", slug: "café" })).toBe("/p/alice/café");
  });
});
