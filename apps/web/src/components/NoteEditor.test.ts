import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor, SuggestionMenu } from "@blocknote/core";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { blocknoteZhTW } from "@/i18n/blocknote-zh-TW";
import type { EditorRef } from "@/components/wikilink/menu";

// toast 換成 spy：這裡要斷言的是「有沒有提示使用者」，不必把 Radix 整套渲染起來。
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));

const { buildNoteEditorOptions, collabUserColor, createMediaBlockingDOMEvents } = await import("./NoteEditor");

/**
 * jsdom 沒有可建構的 DataTransfer，做一個最小替身。
 *
 * `types` 獨立於 `html`/`text` 之外由呼叫端明講（`classifyMediaTransfer` 規則②只看
 * `dataTransfer.types` 有沒有列出格式名字，跟 `getData` 撈不撈得到內容是兩回事）；
 * `files` 用真的 `File` 形狀（`new File([bytes], name, { type })`）——規則③④要讀
 * `File.type`，舊版只帶 `{ length }` 的假替身撐不住。
 */
function transfer(options: { files?: File[]; types?: string[]; html?: string; text?: string }): DataTransfer {
  const map: Record<string, string> = {};
  if (options.html !== undefined) map["text/html"] = options.html;
  if (options.text !== undefined) map["text/plain"] = options.text;
  const files = options.files ?? [];
  return {
    files: files as unknown as FileList,
    types: options.types ?? [],
    getData: (type: string) => map[type] ?? "",
  } as unknown as DataTransfer;
}

/** 測試用真 `File`——`classifyMediaTransfer` 只讀 `.type`。 */
function file(name: string, type: string): File {
  return new File([new Uint8Array([1])], name, { type });
}

function clipboardEvent(data: DataTransfer): ClipboardEvent {
  const event = { clipboardData: data, preventDefault: vi.fn() };
  return event as unknown as ClipboardEvent;
}

function dragEvent(data: DataTransfer): DragEvent {
  const event = { dataTransfer: data, preventDefault: vi.fn() };
  return event as unknown as DragEvent;
}

const translate = (key: string) => `t:${key}`;

describe("createMediaBlockingDOMEvents（§12.4 貼上／拖放攔截）", () => {
  beforeEach(() => toastMock.mockClear());

  it("同時提供 paste 與 drop 兩個 handler", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    expect(typeof handlers.paste).toBe("function");
    expect(typeof handlers.drop).toBe("function");
  });

  it("貼上純 image 檔案 → 回傳 false、不 preventDefault、不 toast（規則③放行，交給 uploadFile 管線）", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = clipboardEvent(transfer({ files: [file("a.png", "image/png")], types: ["Files"] }));

    expect(handlers.paste(null, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("拖放混合／非 image 檔案 → 回傳 true、preventDefault、對應 toast（規則④）", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = dragEvent(
      transfer({ files: [file("a.png", "image/png"), file("b.pdf", "application/pdf")], types: ["Files"] }),
    );

    expect(handlers.drop(null, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:note.transferNonImage" });
  });

  it("貼上 text/html 裡的 data URL 圖片（從網頁複製圖片的常見形狀）→ 擋下", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = clipboardEvent(transfer({ html: '<img src="data:image/png;base64,iVBORw0KGgo=">', text: "" }));

    expect(handlers.paste(null, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("貼上 text/plain 裡的 data URL 圖片 → 擋下", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = clipboardEvent(transfer({ text: "data:image/gif;base64,R0lGOD" }));

    expect(handlers.paste(null, event)).toBe(true);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("拖放 text/html 裡的 data URL 圖片 → 擋下", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = dragEvent(transfer({ html: '<img src="data:image/png;base64,AAA">' }));

    expect(handlers.drop(null, event)).toBe(true);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("一般文字貼上 → 回傳 false、不 preventDefault、不 toast（照常落回 BlockNote）", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = clipboardEvent(transfer({ text: "hello world", html: "<p>hello world</p>" }));

    expect(handlers.paste(null, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("編輯器內部拖曳既有 block（沒有檔案也沒有 data URL）→ 回傳 false", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = dragEvent(transfer({ html: "<p>moved block</p>" }));

    expect(handlers.drop(null, event)).toBe(false);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("每次 toast 的文案都是當下的翻譯（語言切換後不會沿用舊字串）", () => {
    let lang = "en";
    const handlers = createMediaBlockingDOMEvents((key) => `${lang}:${key}`);
    const dataUrlEvent = () => clipboardEvent(transfer({ text: "data:image/png;base64,AAA" }));

    handlers.paste(null, dataUrlEvent());
    expect(toastMock).toHaveBeenLastCalledWith({ title: "en:note.transferDataUrl" });

    lang = "zh";
    handlers.paste(null, dataUrlEvent());
    expect(toastMock).toHaveBeenLastCalledWith({ title: "zh:note.transferDataUrl" });
  });
});

describe("buildNoteEditorOptions", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    toastMock.mockClear();
    doc = new Y.Doc();
  });

  afterEach(() => doc.destroy());

  const build = (language = "en", editorRef: EditorRef = { current: null }, noteId = "note-1") =>
    buildNoteEditorOptions({
      doc,
      provider: { awareness: null } as never,
      user: { id: "user-1", name: "Ann" },
      language,
      translate,
      editorRef,
      noteId,
    });

  it("共編 fragment 用 shared 的 YDOC_FRAGMENT（與 server 的 collab/store 同名）", () => {
    const options = build();
    expect(options.collaboration.fragment).toBe(doc.getXmlFragment(YDOC_FRAGMENT));
    // 寫死成別的名字會變成兩份互不相干的文件——這條斷言就是防那個。
    expect(options.collaboration.fragment).not.toBe(doc.getXmlFragment("default"));
  });

  it("schema 含 image block（Plan 3 Task 14 起恢復啟用）", () => {
    expect(Object.keys(build().schema.blockSpecs)).toContain("image");
  });

  it("uploadFile 選項有掛上去（Task 13，接 createUploadFile）", () => {
    expect(typeof build().uploadFile).toBe("function");
  });

  /**
   * `pasteHandler` 是 markdown 貼上修法（#27／#28）唯一通到使用者的那條線——沒有這條
   * 斷言的話，把 `buildNoteEditorOptions` 裡那一行刪掉，整套測試仍然全綠而修法靜默
   * 失效（審查實測指出的缺口）。這裡連行為一起釘：CRLF 的 markdown 要被接手。
   */
  it("resolveFileUrl 擋掉 Yjs 直寫進來的危險 scheme，但不動自家上傳的相對網址（issue #12）", async () => {
    // UI 的 Embed tab 早就擋過一次，但筆記內容是 Yjs 文件——有 editor 權限的協作者可以
    // 直接寫 block props 繞過整條 UI。BlockNote 對 image/video/audio 的預覽與工具列的
    // 「開啟／下載」按鈕都會先過 `resolveFileUrl`，這裡是所有 sink 之前的最後一道關卡。
    const resolveFileUrl = build().resolveFileUrl;
    expect(typeof resolveFileUrl).toBe("function");

    await expect(resolveFileUrl!("javascript:alert(1)")).resolves.toBe("about:blank");
    await expect(resolveFileUrl!("data:text/html;base64,PHNjcmlwdD4=")).resolves.toBe("about:blank");
    // 自家上傳的圖片是相對網址（`/api/uploads/<id>`）——擋掉它就等於擋掉所有上傳的圖。
    await expect(resolveFileUrl!("/api/uploads/u1")).resolves.toBe("/api/uploads/u1");
    await expect(resolveFileUrl!("https://example.com/a.png")).resolves.toBe("https://example.com/a.png");
  });

  it("pasteHandler 有掛上去，且真的會接手 markdown 貼上（#27／#28）", () => {
    const CRLF_MARKDOWN = "# 標題\r\n\r\n- 一\r\n- 二\r\n";
    const LF_MARKDOWN = "# 標題\n\n- 一\n- 二\n";
    const pasteHandler = build().pasteHandler;
    expect(typeof pasteHandler).toBe("function");

    const pasteMarkdown = vi.fn();
    const defaultPasteHandler = vi.fn(() => true);
    const resolved = { parent: { type: { spec: { code: false } } } };

    pasteHandler!({
      event: {
        clipboardData: {
          types: ["text/plain"],
          getData: (type: string) => (type === "text/plain" ? CRLF_MARKDOWN : ""),
        },
      } as never,
      editor: {
        pasteMarkdown,
        transact: (callback: (tr: never) => unknown) => callback({ selection: { $from: resolved, $to: resolved } } as never),
      } as never,
      defaultPasteHandler,
    } as never);

    expect(pasteMarkdown).toHaveBeenCalledWith(LF_MARKDOWN);
    expect(defaultPasteHandler).not.toHaveBeenCalled();
  });

  it("攔截掛在 editorProps.handleDOMEvents，**不是** handlePaste/handleDrop", () => {
    const editorProps = build()._tiptapOptions.editorProps;

    // 這條是 BlockNote 0.52 實測結論的護欄：BlockNote 自己的 handleDOMEvents.paste
    // 外掛一律先 preventDefault 並接管，handlePaste/handleDrop 永遠不會被呼叫到。
    // 有人「順手」改回那兩個 prop，這裡就會紅。
    expect(editorProps).not.toHaveProperty("handlePaste");
    expect(editorProps).not.toHaveProperty("handleDrop");
    expect(typeof editorProps.handleDOMEvents.paste).toBe("function");
    expect(typeof editorProps.handleDOMEvents.drop).toBe("function");
  });

  // spec 點名的假綠高危案例：早前這裡只驗過「有檔案就一律擋」，跟 §12.4 現行語意（純
  // image 檔要放行）完全脫節，紅了也測不出來。改成兩條，涵蓋放行與攔截各一個真實
  // File 形狀，確保掛在 `_tiptapOptions.editorProps.handleDOMEvents` 上的**同一個函式
  // 參照**真的接到了 `classifyMediaTransfer` 的規則。
  it("掛上去的 handler 真的會放行純 image 檔案貼上（端到端接線，不只是型別對）", () => {
    const event = clipboardEvent(transfer({ files: [file("a.png", "image/png")], types: ["Files"] }));
    expect(build()._tiptapOptions.editorProps.handleDOMEvents.paste(null, event)).toBe(false);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("掛上去的 handler 真的會擋非 image 檔案貼上（端到端接線，不只是型別對）", () => {
    const event = clipboardEvent(transfer({ files: [file("a.pdf", "application/pdf")], types: ["Files"] }));
    expect(build()._tiptapOptions.editorProps.handleDOMEvents.paste(null, event)).toBe(true);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:note.transferNonImage" });
  });

  it("語言以 zh 開頭 → 掛繁中字典；其餘 → undefined（BlockNote 預設即英文）", () => {
    expect(build("zh-TW").dictionary).toBe(blocknoteZhTW);
    expect(build("zh").dictionary).toBe(blocknoteZhTW);
    expect(build("en").dictionary).toBeUndefined();
    expect(build("en-US").dictionary).toBeUndefined();
  });

  it("使用者資訊帶進共編游標，顏色由 id 穩定決定", () => {
    const options = build();
    expect(options.collaboration.user).toEqual({ id: "user-1", name: "Ann", color: collabUserColor("user-1") });
    expect(collabUserColor("user-1")).toBe(collabUserColor("user-1"));
    expect(collabUserColor("user-1")).not.toBe(collabUserColor("user-2"));
  });
});

// ── `[[` 觸發偵測（handleTextInput，Task 3 §12.2 recipe）─────────────────────────
//
// **mount harness**：`BlockNoteEditor.create` 後必須 `editor.mount(掛在
// document.body 的元素)`，headless 下 `openSuggestionMenu` 會直接 early-return
// （`SuggestionMenu.ts`：`if (editor.headless) return;`），不 mount 這裡的斷言全部
// 都會是假綠。`test/setup.ts` 已墊好 `getBoundingClientRect` 的 shim，
// `SuggestionMenuView.update()` 算 decoration 位置時才不會炸。
//
// `handleTextInput` 直接從 `buildNoteEditorOptions` 回傳的 options 物件取出來呼叫
// ——不透過 `BlockNoteEditor.create` 之後的 `_tiptapEditor.options` 繞一手，因為那支
// 就是我們自己傳進去、真正會被 ProseMirror 呼叫的同一個函式參照，直接呼叫等價於
// 讓 ProseMirror 呼叫它，又不必依賴 tiptap 內部怎麼合併多個 editorProps 來源。
describe("buildNoteEditorOptions 的 [[ 觸發偵測（handleTextInput）", () => {
  let doc: Y.Doc;
  let editorRef: EditorRef;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 測試用編輯器，走 repo 慣例的 BlockNoteEditor<any,any,any>
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;
  // `view` 型別刻意寫 `unknown`（同 `createMediaBlockingDOMEvents` 的 house style）：
  // 測試不必為了型別把 prosemirror-view 拉成直接依賴。
  let handleTextInput: (view: unknown, from: number, to: number, text: string) => boolean | void;

  beforeEach(() => {
    doc = new Y.Doc();
    editorRef = { current: null };
    const options = buildNoteEditorOptions({
      doc,
      provider: { awareness: null } as never,
      user: { id: "user-1", name: "Ann" },
      language: "en",
      translate,
      editorRef,
      noteId: "note-1",
    });
    handleTextInput = options._tiptapOptions.editorProps.handleTextInput as typeof handleTextInput;

    editor = BlockNoteEditor.create(options);
    editorRef.current = editor;

    container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container);
  });

  afterEach(() => {
    editor.unmount();
    container.remove();
    doc.destroy();
  });

  /** 模擬「使用者剛按下第二個 `[`」：`from`/`to` 是目前游標位置，PM 尚未真的插入這個字元。 */
  function typeSecondBracket(): boolean | void {
    const view = editor._tiptapEditor.view;
    const from = editor.transact((tr) => tr.selection.from);
    return handleTextInput(view, from, from, "[");
  }

  it("[[ 句中觸發：句子中間打出第二個 [ → 吞掉輸入、開啟選單、文件維持『Hello [[』", () => {
    editor.insertInlineContent(["Hello ["]);

    const handled = typeSecondBracket();

    expect(handled).toBe(true);
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    expect(suggestionMenu.shown()).toBe(true);
    expect(suggestionMenu.store.state?.triggerCharacter).toBe("[[");
    expect(suggestionMenu.store.state?.query).toBe("");
    expect(editor.transact((tr) => tr.doc.textContent)).toBe("Hello [[");
  });

  it("block 開頭觸發：空白 block 只打了一個 [ → 一樣吞掉輸入、開啟選單、文件維持『[[』", () => {
    editor.insertInlineContent(["["]);

    const handled = typeSecondBracket();

    expect(handled).toBe(true);
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    expect(suggestionMenu.shown()).toBe(true);
    expect(editor.transact((tr) => tr.doc.textContent)).toBe("[[");
  });

  it("前一個字元不是 [（same-parent guard 的另一半）：不吞輸入、不開選單", () => {
    editor.insertInlineContent(["Hello"]);

    const handled = typeSecondBracket();

    expect(handled).toBe(false);
    expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(false);
    expect(editor.transact((tr) => tr.doc.textContent)).toBe("Hello");
  });
});

// ── uploadFile 真的接上 handleFileInsertion（Task 13）───────────────────────────
//
// `handleFileInsertion` 不是 `@blocknote/core` 的公開匯出，唯一「真的走它」的辦法是
// mount 編輯器後派發真的 `paste` DOM 事件，讓 BlockNote 自己的 paste 外掛
// （`pasteExtension.ts`，一律先跑我們的 `createMediaBlockingDOMEvents.paste`——純
// image 檔放行，回傳 false 落回 BlockNote）接手，呼叫到 `editor.uploadFile`。
//
// jsdom 30 沒有可建構的 `ClipboardEvent`/`DataTransfer`：用最小替身（`types`/`items`/
// `files`）掛在一個普通 `Event` 上派發，`handleFileInsertion` 只讀這三個欄位
// （`acceptedMIMETypes` 判斷走 `types`，實際取檔案走 `items[i].getAsFile()`），
// 不需要 `getData`（"Files" 分支不會呼叫它，見 `pasteExtension.ts` defaultPasteHandler）。
//
// 上傳失敗（4xx）的清除是 `setTimeout(…, 0)` 排的 macrotask，而
// `editor.updateBlock(insertedBlockId, …)`（把 url 寫回 block）是 `await
// editor.uploadFile(...)` resolve 後的**微任務續體**——都在我們自己這邊等待期間，用
// 一個真的 `setTimeout(resolve, 0)` 就能把兩者一起沖掉（微任務保證先跑完）。清除本身
// 是**另一個**排在後面的 macrotask，因此驗證「block 被清掉」要多等一輪。
describe("buildNoteEditorOptions 的 uploadFile 真接線（handleFileInsertion，Task 13）", () => {
  let doc: Y.Doc;
  let editorRef: EditorRef;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 測試用編輯器，走 repo 慣例的 BlockNoteEditor<any,any,any>
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;

  beforeEach(() => {
    toastMock.mockClear();
    doc = new Y.Doc();
    editorRef = { current: null };
    const options = buildNoteEditorOptions({
      doc,
      provider: { awareness: null } as never,
      user: { id: "user-1", name: "Ann" },
      language: "en",
      translate,
      editorRef,
      noteId: "note-1",
    });

    editor = BlockNoteEditor.create(options);
    editorRef.current = editor;

    container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container);

    // 讓游標所在的 block 已有內容——`handleFileInsertion` 的 `insertOrUpdateBlock` 對
    // 「空 block」是原地 `updateBlock`（覆蓋掉整個唯一的 block，很難斷言生命週期），
    // 對「非空 block」則是 `insertBlocks(...,"after")`，會多出一個全新的 block——後者
    // 才有獨立的插入／移除可以觀察，且不用管它的內部 id。
    editor.insertInlineContent(["hello"]);
  });

  afterEach(() => {
    editor.unmount();
    container.remove();
    doc.destroy();
    vi.unstubAllGlobals();
  });

  function fakeResponse({ ok, status, json }: { ok: boolean; status: number; json?: () => Promise<unknown> }): Response {
    return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
  }

  function pasteFile(file: File): void {
    // `getData` 一定要在——`createMediaBlockingDOMEvents` 掛的 handler（規則③放行前）
    // 先跑一手 `classifyMediaTransfer`，它會呼叫 `data.getData("text/html"/"text/plain")`
    // 找內嵌 data URL；沒有這個方法會直接炸掉整個事件派發（真實瀏覽器的 DataTransfer
    // 一律有這個方法，純圖片貼上時回空字串）。
    const clipboardData = {
      types: ["Files"],
      items: [{ type: file.type, getAsFile: () => file }],
      files: [file],
      getData: () => "",
    };
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    editor._tiptapEditor.view.dom.dispatchEvent(event);
  }

  const imageFile = () => new File([new Uint8Array([1])], "a.png", { type: "image/png" });

  async function flushMacrotask(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("成功：貼上圖片檔案真的觸發 uploadFile，block 拿到回傳的 url（Task 14 起 image 已進 schema，placeholder 真的是 image block）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u1", url: "/api/uploads/u1" }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const before = editor.document.length;

    pasteFile(imageFile());

    // placeholder block 是 `insertOrUpdateBlock` 同步插入的，不必等待任何非同步結果。
    expect(editor.document.length).toBe(before + 1);

    await flushMacrotask();

    const placeholder = editor.document[editor.document.length - 1];
    // `handleFileInsertion` 依 `editor.schema.blockSpecs` 逐一比對 `fileBlockAccept`
    // 挑 block 型別（見 `@blocknote/core` 原始碼）；image 恢復進 schema 後，image/png
    // 檔案會落在 image block（不再退回泛用的 file block）。
    expect(placeholder.type).toBe("image");
    expect((placeholder.props as Record<string, unknown>).url).toBe("/api/uploads/u1");
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("失敗（4xx）：toast 一則、placeholder block 在下一輪 macrotask 後才被移除（排序：updateBlock 先跑完，才輪到移除）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({
        ok: false,
        status: 415,
        json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const before = editor.document.length;

    pasteFile(imageFile());
    expect(editor.document.length).toBe(before + 1);

    await flushMacrotask();
    // 這一輪：uploadFile 的 promise 已 resolve（sentinel ""）、toast 已觸發、
    // `handleFileInsertion` 的 `editor.updateBlock(...)` 也已同步跑完——但清除排的是
    // *另一個*、更晚註冊的 macrotask，這裡還沒到它。
    expect(toastMock).toHaveBeenCalledWith({ title: "t:errors.unsupported_media_type" });
    expect(editor.document.length).toBe(before + 1);

    await flushMacrotask();

    expect(editor.document.length).toBe(before);
  });
});
