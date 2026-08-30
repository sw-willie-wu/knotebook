import { describe, expect, it } from "vitest";
import { BlockNoteEditor, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
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
    // 這條守的是「**預設 block 不得被弄掉**」——`BlockNoteSchema.create` 的 `blockSpecs`
    // 是整組覆寫，漏 `...defaultBlockSpecs` 的 spread 會靜默拆掉一半的編輯器。
    // issue #94 起 schema 多了自訂的 `mermaid`，所以判定從「全等」改成「包含」；
    // ⚠ 鑑別力不變：任何一個預設 block 掉了，這條仍然紅（下面另一條釘住自訂 block 有掛上，
    // 兩條合起來才等於原本那條全等斷言的覆蓋範圍）。
    expect(Object.keys(noteSchema.blockSpecs)).toEqual(expect.arrayContaining(Object.keys(defaultBlockSpecs)));
  });

  it("自訂 block 有掛上，且僅限刻意新增的那些", () => {
    // 與上一條互補：上一條擋「預設的被拿掉」，這一條擋「不小心多掛了東西」。
    const custom = Object.keys(noteSchema.blockSpecs).filter((type) => !(type in defaultBlockSpecs));
    expect(custom.sort()).toEqual(["mermaid"]);
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

/**
 * issue #43：`toExternalHTML`（複製到剪貼簿的 `text/html`、`blocksToMarkdownLossy` 的
 * markdown 匯出）拿的是 raw `props.url`，不走 #12 掛在 `resolveFileUrl` 上的渲染端
 * 守衛——把被污染的 block 複製到別的應用程式，帶過去的是 `<a href="javascript:…">`／
 * `<img src="javascript:…">`。四個檔案類 block spec 的 `toExternalHTML` 必須套同一個
 * `safeMediaUrl`。
 *
 * 測法比照 `NoteEditor.test.ts` 對 `defaultBlockSpecs.image` 的 render 守衛測試：直接
 * 呼叫 spec implementation（jsdom 有 document.createElement），不掛整個編輯器。
 */
describe("檔案類 block 的 toExternalHTML 走媒體 URL 守衛（issue #43）", () => {
  /** 本測試只碰得到的那一層：`implementation.toExternalHTML(block, editor)` → `{ dom }`。 */
  type FileSpecLike = {
    implementation: {
      meta?: { fileBlockAccept?: unknown };
      toExternalHTML: (block: Record<string, unknown>, editor: unknown) => { dom: HTMLElement };
    };
  };
  const specs = noteSchema.blockSpecs as unknown as Record<string, FileSpecLike>;
  const FILE_BLOCK_TYPES = ["audio", "file", "image", "video"] as const;

  /** 假 block 帶上 `type`/`id`/`children`——被委派的原實作（`createBlockSpec` 回傳的
   * toExternalHTML，內含 `wrapInBlockStructure`）會讀 `block.type` 吐成
   * `data-content-type`，只給 props 的話產出的 DOM 跟 production 形狀對不上（審查指出）。 */
  function block(type: string, url: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type,
      id: "b1",
      children: [],
      props: {
        url,
        name: "n",
        caption: "",
        showPreview: true,
        previewWidth: undefined,
        backgroundColor: "default",
        textAlignment: "left",
        ...overrides,
      },
    };
  }

  /** 取出實際承載 URL 的節點值：`<a href>`（file、或關掉預覽的媒體）或 `<img|video|audio src>`。 */
  function carriedUrl(dom: HTMLElement): string | null {
    const el = dom.matches("[src],[href]") ? dom : dom.querySelector("[src],[href]");
    return el ? (el.getAttribute("src") ?? el.getAttribute("href")) : null;
  }

  for (const type of FILE_BLOCK_TYPES) {
    it(`${type}：危險 scheme → about:blank，絕不出現 javascript:（data-url 也是）`, () => {
      const { dom } = specs[type].implementation.toExternalHTML(block(type, "javascript:alert(1)"), {});
      expect(dom.outerHTML).not.toContain("javascript:");
      expect(carriedUrl(dom)).toBe("about:blank");
    });

    it(`${type}：自家上傳的相對網址原樣放行`, () => {
      const { dom } = specs[type].implementation.toExternalHTML(block(type, "/api/uploads/u1"), {});
      expect(carriedUrl(dom)).toBe("/api/uploads/u1");
    });

    it(`${type}：外部 https 原樣放行`, () => {
      const { dom } = specs[type].implementation.toExternalHTML(block(type, "https://example.com/a.png"), {});
      expect(carriedUrl(dom)).toBe("https://example.com/a.png");
    });
  }

  it("data: URL 一樣被擋（同 #12 的白名單：只有 http/https 過關）", () => {
    const { dom } = specs.image.implementation.toExternalHTML(block("image", "data:text/html;base64,PHNjcmlwdD4="), {});
    expect(carriedUrl(dom)).toBe("about:blank");
  });

  it("空 url（block 還沒有檔案）走 BlockNote 自己的 placeholder 路徑，不炸", () => {
    const { dom } = specs.file.implementation.toExternalHTML(block("file", ""), {});
    expect(dom).toBeInstanceOf(HTMLElement);
  });

  it("showPreview:false（<a href> 分支）一樣被守（審查補：守衛在分支之前，兩條出口都要釘）", () => {
    const { dom } = specs.video.implementation.toExternalHTML(
      block("video", "javascript:alert(1)", { showPreview: false }),
      {},
    );
    expect(dom.outerHTML).not.toContain("javascript:");
    expect(carriedUrl(dom)).toBe("about:blank");
  });

  it("帶 caption（figure/figcaption 分支）一樣被守", () => {
    const { dom } = specs.image.implementation.toExternalHTML(
      block("image", "javascript:alert(1)", { caption: "cap" }),
      {},
    );
    expect(dom.outerHTML).not.toContain("javascript:");
  });

  it("守衛覆蓋面＝上游檔案類 block 全集（meta.fileBlockAccept 為準）——上游新增第五種檔案類 block 時這條會紅，提醒把它加進 withGuardedExternalHTML", () => {
    const fileBlocks = Object.entries(defaultBlockSpecs)
      .filter(([, spec]) => {
        const impl = (spec as unknown as FileSpecLike).implementation;
        return impl?.meta && "fileBlockAccept" in (impl.meta as object);
      })
      .map(([type]) => type)
      .sort();
    expect(fileBlocks).toEqual([...FILE_BLOCK_TYPES]);
  });
});

/**
 * issue #43 的匯出鏈釘（審查指出：上面那組只釘 spec 本體——若上游匯出器改讀別的
 * 註冊表而非編輯器 schema 的 blockSpecs，上面全綠而洞悄悄回來）。用真編輯器 + 真匯出
 * 鏈（`blocksToMarkdownLossy` 正是 `AiSession.tsx` 送 AI 的那條路）驗到底。
 *
 * 這條釘的是「匯出器讀編輯器的 schema」這一半；另一半「`buildNoteEditorOptions`
 * 交付的就是 `noteSchema` 本尊」由 `NoteEditor.test.ts` 的接線釘負責（本測試自己
 * hardcode `schema: noteSchema`，管不到那件事）。
 */
describe("issue #43 端到端：真編輯器的匯出鏈吃到守衛", () => {
  it("blocksToMarkdownLossy 對被污染的 image 匯出 about:blank", async () => {
    const editor = BlockNoteEditor.create({
      schema: noteSchema,
      initialContent: [{ type: "image", props: { url: "javascript:alert(1)", name: "x" } }],
    });
    const markdown = await editor.blocksToMarkdownLossy(editor.document);
    expect(markdown).not.toContain("javascript:");
    expect(markdown).toContain("about:blank");
  });
});

/**
 * issue #96：codeBlock 的語法上色選項有沒有真的接上 schema。
 *
 * `createCodeBlockSpec(options)` 把 options 封在 spec 閉包裡，從 schema 物件上讀
 * 不回來——唯一誠實的觀察面是**渲染結果**：spec 的 `render` 只有在
 * `supportedLanguages` 非空時才會畫語言下拉（BlockNote 內建預設是 `{}`，下拉整個
 * 不出現）。所以這裡掛真編輯器、塞一個 codeBlock，斷言下拉存在且有我們清單裡的
 * 語言——這條紅＝有人把 `codeBlock: createCodeBlockSpec(CODE_BLOCK_OPTIONS)` 從
 * `noteSchema` 拿掉（退回無上色、空下拉的內建路徑）。
 */
describe("issue #96：codeBlock 語言下拉接線", () => {
  it("noteSchema 的 codeBlock 渲染出語言下拉，且清單來自 SUPPORTED_LANGUAGES", () => {
    const editor = BlockNoteEditor.create({
      schema: noteSchema,
      initialContent: [{ type: "codeBlock", props: { language: "typescript" }, content: "const x = 1;" }],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    try {
      editor.mount(container);
      const select = container.querySelector<HTMLSelectElement>('[data-content-type="codeBlock"] select');
      expect(select, "沒有語言下拉＝schema 沒接 CODE_BLOCK_OPTIONS（內建 supportedLanguages 是空物件）").not.toBeNull();
      const labels = [...select!.options].map((option) => option.text);
      expect(labels).toContain("TypeScript");
      expect(labels).toContain("Plain text");
      expect(select!.value).toBe("typescript");
    } finally {
      editor.unmount();
      container.remove();
    }
  });
});

/**
 * issue #96 的匯出不變量釘子：上色是 ProseMirror decoration（editor 層），**從不
 * 進文件、也從不進匯出**。這條在實作當下就綠（decoration 機制天生如此）——釘住它
 * 是防未來有人把上色改成「把 span 寫進 content」一類的實作（例如為了 SSR 或匯出
 * 也帶色），那會讓共編文件被灌入呈現細節、每個協作者的匯出都長不一樣。
 */
describe("issue #96：匯出不帶上色殘留", () => {
  it("codeBlock 的 HTML 匯出是乾淨的 pre>code（無 shiki span、無 inline style）", async () => {
    const editor = BlockNoteEditor.create({
      schema: noteSchema,
      initialContent: [{ type: "codeBlock", props: { language: "typescript" }, content: 'const x = "hi";' }],
    });
    const html = await editor.blocksToHTMLLossy(editor.document);
    expect(html).toContain('const x = "hi";');
    expect(html).not.toContain("shiki");
    expect(html).not.toContain("--code-");
    expect(html).not.toContain("style=");
  });
});

/**
 * issue #96：未知語言的 graceful-skip 是**承重路徑**，不只防惡意協作者——BlockNote 的
 * ``` 圍欄 input rule 是 `getLanguageId(...) ?? 原字串`（0.52.1 dist 核實），任何使用者
 * 打 ```foo 就會產生不在清單裡的 language prop。而 shiki 的 `loadLanguage()` 對 bundle
 * 外的 id 是 **throw**：這條路必須在「呼叫 loadLanguage 之前」就被 getLanguageId 的
 * undefined 擋掉，破掉的症狀是 unhandled rejection ＋ 上色靜默全滅。
 *
 * 對照組（typescript 有上色）先等到 .shiki decoration 真的出現，才斷言未知語言那塊
 * 沒有——不然「兩塊都還沒開始上色」也會讓斷言假綠。
 */
describe("issue #96：未知語言 graceful-skip", () => {
  it("language 不在清單 → 不炸、無 unhandled rejection、該塊不上色（其他塊照常上色）", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    const editor = BlockNoteEditor.create({
      schema: noteSchema,
      initialContent: [
        { type: "codeBlock", props: { language: "typescript" }, content: 'const x = "hi";' },
        { type: "codeBlock", props: { language: "notalang" }, content: "some code" },
      ],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    try {
      editor.mount(container);
      // highlighter 是 lazy（首次渲染 codeBlock 才 import shiki、載 grammar、重繪 decoration）
      // ——輪詢等對照組出現 .shiki，逾時才失敗（同 repo「不可固定 sleep」慣例）。
      const deadline = Date.now() + 10_000;
      while (container.querySelector('[data-content-type="codeBlock"] .shiki') === null) {
        if (Date.now() > deadline) throw new Error("對照組（typescript）10s 內沒出現 .shiki decoration");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const blocks = [...container.querySelectorAll<HTMLElement>('[data-content-type="codeBlock"]')];
      expect(blocks).toHaveLength(2);
      expect(blocks[0]!.querySelectorAll(".shiki").length, "對照組 typescript 應該有上色").toBeGreaterThan(0);
      expect(blocks[1]!.querySelectorAll(".shiki")).toHaveLength(0);
      expect(blocks[1]!.textContent).toContain("some code");
      // 多等一輪 macrotask 讓可能的 rejection 冒出來再收網。
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections, "graceful-skip 破掉的第一個症狀就是 unhandled rejection").toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
      editor.unmount();
      container.remove();
    }
  });
});
