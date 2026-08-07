import { describe, expect, it } from "vitest";
import { defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { classifyMediaTransfer, containsMediaDataUrl, noteSchema } from "./schema";

/**
 * 最小的 DataTransfer 替身——jsdom 沒有可建構的 DataTransfer。
 *
 * `types` 刻意獨立於 `html`/`text`/`markdown`/`blocknoteHtml` 之外由呼叫端明講：
 * 規則②只看 `dataTransfer.types` 有沒有列出某個格式的名字，跟該格式底下
 * `getData` 撈不撈得到內容是兩回事（例如 `vscode-editor-data` 只需要出現在
 * `types` 裡，`classifyMediaTransfer` 從不對它呼叫 `getData`）。
 *
 * `files` 用真的 `File` 形狀（`new File([bytes], name, { type })`）——`classifyMediaTransfer`
 * 規則③④要讀 `File.type`，舊版只帶 `{ length }` 的假替身撐不住這條規則。
 */
function transfer(options: {
  files?: File[];
  types?: string[];
  html?: string;
  text?: string;
  markdown?: string;
  blocknoteHtml?: string;
  /** `vscode-editor-data` 的原始內容——規則①刻意不掃這個格式，測試用得到。 */
  vscodeEditorData?: string;
}): DataTransfer {
  const map: Record<string, string> = {};
  if (options.html !== undefined) map["text/html"] = options.html;
  if (options.text !== undefined) map["text/plain"] = options.text;
  if (options.markdown !== undefined) map["text/markdown"] = options.markdown;
  if (options.blocknoteHtml !== undefined) map["blocknote/html"] = options.blocknoteHtml;
  if (options.vscodeEditorData !== undefined) map["vscode-editor-data"] = options.vscodeEditorData;
  const files = options.files ?? [];
  return {
    files: files as unknown as FileList,
    types: options.types ?? [],
    getData: (type: string) => map[type] ?? "",
  } as unknown as DataTransfer;
}

/** 測試用真 `File`——預設一個位元組即可，`classifyMediaTransfer` 只讀 `.type`。 */
function file(name: string, type: string): File {
  return new File([new Uint8Array([1])], name, { type });
}

describe("noteSchema（Plan 3 Task 14：image block 恢復啟用）", () => {
  it("有 image block", () => {
    expect(Object.keys(noteSchema.blockSpecs)).toContain("image");
    expect("image" in noteSchema.blockSchema).toBe(true);
  });

  it("預設 block 全數保留（含 image）", () => {
    expect(Object.keys(noteSchema.blockSpecs).sort()).toEqual(Object.keys(defaultBlockSpecs).sort());
  });

  it("段落與標題這些基本 block 仍在（防止整份 schema 建錯）", () => {
    expect(Object.keys(noteSchema.blockSpecs)).toEqual(expect.arrayContaining(["paragraph", "heading", "table"]));
  });
});

// Plan 3：`wikilink` inline content spec 掛載——防的正是「傳 `inlineContentSpecs` 忘了
// spread `defaultInlineContentSpecs`」這個陷阱（見 schema.ts 頂端註解）：一旦漏掉，
// `text`/`link` 會從 `noteSchema.inlineContentSpecs` 靜默消失，但不會有任何型別或
// 執行期錯誤——只有這種明確列舉 key 的測試才擋得住。
describe("noteSchema（Plan 3 wikilink inline content 掛載）", () => {
  it("預設 inline content（text/link）全數保留，且新增了 wikilink", () => {
    expect(Object.keys(noteSchema.inlineContentSpecs).sort()).toEqual(
      [...Object.keys(defaultInlineContentSpecs), "wikilink"].sort(),
    );
  });
});

describe("containsMediaDataUrl", () => {
  it("認得 img src 的 base64 data URL", () => {
    expect(containsMediaDataUrl('<img src="data:image/png;base64,iVBORw0KGgo=">')).toBe(true);
  });

  it("認得純文字貼上的 data URL（行首）", () => {
    expect(containsMediaDataUrl("data:image/gif;base64,R0lGOD")).toBe(true);
  });

  it("認得非 base64 的 data URL（逗號結尾的參數段）", () => {
    expect(containsMediaDataUrl('<img src="data:image/svg+xml,%3Csvg/%3E">')).toBe(true);
  });

  it("認得 video/audio", () => {
    expect(containsMediaDataUrl("data:video/mp4;base64,AAA")).toBe(true);
    expect(containsMediaDataUrl("data:audio/mpeg;base64,AAA")).toBe(true);
  });

  it("不誤擋一般文字裡的 data: 字樣與非媒體 data URL", () => {
    expect(containsMediaDataUrl("請參考 data structures 這一章")).toBe(false);
    expect(containsMediaDataUrl("data:text/plain;base64,aGk=")).toBe(false);
    expect(containsMediaDataUrl("mydata:image/png;base64,x")).toBe(false);
    expect(containsMediaDataUrl("")).toBe(false);
    expect(containsMediaDataUrl(null)).toBe(false);
  });
});

describe("classifyMediaTransfer（§12.4 四規則）", () => {
  describe("規則①：data URL → \"dataUrl\"", () => {
    it("text/html 片段帶 data URL（從網頁複製圖片常見形狀）", () => {
      expect(classifyMediaTransfer(transfer({ html: '<img src="data:image/png;base64,AAA">' }))).toBe("dataUrl");
    });

    it("text/plain 帶 data URL", () => {
      expect(classifyMediaTransfer(transfer({ text: "data:image/png;base64,AAA" }))).toBe("dataUrl");
    });

    it("text/markdown 帶 data URL（markdown-only：其餘格式都沒有內容）", () => {
      expect(classifyMediaTransfer(transfer({ markdown: "![alt](data:image/png;base64,AAA)" }))).toBe("dataUrl");
    });

    it("blocknote/html 帶 data URL", () => {
      expect(
        classifyMediaTransfer(transfer({ blocknoteHtml: '<img src="data:image/png;base64,AAA">' })),
      ).toBe("dataUrl");
    });

    it("即使帶了 image 檔案，data URL 仍優先判定（規則①先於③）", () => {
      expect(
        classifyMediaTransfer(
          transfer({ files: [file("a.png", "image/png")], html: '<img src="data:image/png;base64,AAA">' }),
        ),
      ).toBe("dataUrl");
    });

    // 上一條的 `types` 是空陣列，規則②的 `hasFiles && types.some(...)` 分支根本不會被
    // 求值——只證明得了①先於③，證明不了①先於②。這條把 `types` 也一併塞進規則②會命中
    // 的形狀（`text/html` 排在裡面），逼兩條規則同時「有機會」命中，藉此鎖死①必須先判：
    // 若實作把②的判斷搬到①前面，這條會從 "dataUrl" 變成 "textRepresentation" 而變紅。
    it("files + types 含 text/html + html 帶 data URL → dataUrl（規則①先於②）", () => {
      expect(
        classifyMediaTransfer(
          transfer({
            files: [file("a.png", "image/png")],
            types: ["text/html", "Files"],
            html: '<img src="data:image/png;base64,AAA">',
          }),
        ),
      ).toBe("dataUrl");
    });

    it("vscode-editor-data 刻意不掃 data URL——即使它的內容帶 data URL 也不算 dataUrl", () => {
      expect(
        classifyMediaTransfer(
          transfer({ types: ["vscode-editor-data"], vscodeEditorData: "data:image/png;base64,AAA" }),
        ),
      ).toBeNull();
    });
  });

  describe("規則②：帶 File 且 types 含 acceptedMIMETypes 前五種任一 → \"textRepresentation\"", () => {
    const image = () => [file("a.png", "image/png")];

    it("vscode-editor-data", () => {
      expect(classifyMediaTransfer(transfer({ files: image(), types: ["vscode-editor-data"] }))).toBe(
        "textRepresentation",
      );
    });

    it("blocknote/html", () => {
      expect(classifyMediaTransfer(transfer({ files: image(), types: ["blocknote/html"] }))).toBe(
        "textRepresentation",
      );
    });

    it("text/markdown", () => {
      expect(classifyMediaTransfer(transfer({ files: image(), types: ["text/markdown"] }))).toBe(
        "textRepresentation",
      );
    });

    it("text/html", () => {
      expect(classifyMediaTransfer(transfer({ files: image(), types: ["text/html"] }))).toBe("textRepresentation");
    });

    it("text/plain", () => {
      expect(classifyMediaTransfer(transfer({ files: image(), types: ["text/plain"] }))).toBe("textRepresentation");
    });

    it("files 全 image + text/html 帶一般 https src（非 data URL）→ 仍判 textRepresentation（規則②先於③）", () => {
      expect(
        classifyMediaTransfer(
          transfer({
            files: image(),
            types: ["text/html"],
            html: '<img src="https://example.com/photo.png">',
          }),
        ),
      ).toBe("textRepresentation");
    });

    it("沒有 File 時，即使 types 含這些格式也不算——規則②要求先有 File", () => {
      expect(classifyMediaTransfer(transfer({ types: ["text/html"], html: "<p>hello</p>" }))).toBeNull();
    });
  });

  describe("規則③：files 非空且全部 File.type 以 image/ 開頭 → 放行", () => {
    it("單一 image 檔、types 只有 Files", () => {
      expect(classifyMediaTransfer(transfer({ files: [file("a.png", "image/png")], types: ["Files"] }))).toBeNull();
    });

    it("多個 image 檔", () => {
      expect(
        classifyMediaTransfer(
          transfer({ files: [file("a.png", "image/png"), file("b.gif", "image/gif")], types: ["Files"] }),
        ),
      ).toBeNull();
    });

    it("空字串 type 不算 image（不會誤放行成 nonImageFile 以外的東西）", () => {
      expect(classifyMediaTransfer(transfer({ files: [file("a", "")], types: ["Files"] }))).toBe("nonImageFile");
    });
  });

  describe("規則④：任一非 image 檔 → \"nonImageFile\"", () => {
    it("單一 video 檔", () => {
      expect(classifyMediaTransfer(transfer({ files: [file("a.mp4", "video/mp4")], types: ["Files"] }))).toBe(
        "nonImageFile",
      );
    });

    it("單一 audio 檔", () => {
      expect(classifyMediaTransfer(transfer({ files: [file("a.mp3", "audio/mpeg")], types: ["Files"] }))).toBe(
        "nonImageFile",
      );
    });

    it("混合 image + 非 image 檔", () => {
      expect(
        classifyMediaTransfer(
          transfer({ files: [file("a.png", "image/png"), file("b.pdf", "application/pdf")], types: ["Files"] }),
        ),
      ).toBe("nonImageFile");
    });
  });

  describe("預設放行（四規則皆不匹配）", () => {
    it("純文字／一般 HTML 放行", () => {
      expect(classifyMediaTransfer(transfer({ text: "hello", html: "<p>hello</p>" }))).toBeNull();
      expect(classifyMediaTransfer(transfer({}))).toBeNull();
    });

    it("沒有 dataTransfer 一律放行", () => {
      expect(classifyMediaTransfer(null)).toBeNull();
      expect(classifyMediaTransfer(undefined)).toBeNull();
    });
  });
});
