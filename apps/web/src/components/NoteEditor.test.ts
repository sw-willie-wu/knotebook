import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { blocknoteZhTW } from "@/i18n/blocknote-zh-TW";

// toast 換成 spy：這裡要斷言的是「有沒有提示使用者」，不必把 Radix 整套渲染起來。
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));

const { buildNoteEditorOptions, collabUserColor, createMediaBlockingDOMEvents } = await import("./NoteEditor");

/** jsdom 沒有可建構的 DataTransfer，做一個最小替身。 */
function transfer(options: { files?: number; html?: string; text?: string }): DataTransfer {
  const map: Record<string, string> = {};
  if (options.html !== undefined) map["text/html"] = options.html;
  if (options.text !== undefined) map["text/plain"] = options.text;
  return {
    files: { length: options.files ?? 0 } as unknown as FileList,
    getData: (type: string) => map[type] ?? "",
  } as unknown as DataTransfer;
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

describe("createMediaBlockingDOMEvents（§11.1 貼上／拖放攔截）", () => {
  beforeEach(() => toastMock.mockClear());

  it("同時提供 paste 與 drop 兩個 handler", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    expect(typeof handlers.paste).toBe("function");
    expect(typeof handlers.drop).toBe("function");
  });

  it("貼上檔案 → 回傳 true、preventDefault、toast", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = clipboardEvent(transfer({ files: 1 }));

    expect(handlers.paste(null, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:note.imageUnsupported" });
  });

  it("拖放檔案 → 回傳 true、preventDefault、toast", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = dragEvent(transfer({ files: 1 }));

    expect(handlers.drop(null, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:note.imageUnsupported" });
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

    handlers.paste(null, clipboardEvent(transfer({ files: 1 })));
    expect(toastMock).toHaveBeenLastCalledWith({ title: "en:note.imageUnsupported" });

    lang = "zh";
    handlers.paste(null, clipboardEvent(transfer({ files: 1 })));
    expect(toastMock).toHaveBeenLastCalledWith({ title: "zh:note.imageUnsupported" });
  });
});

describe("buildNoteEditorOptions", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    toastMock.mockClear();
    doc = new Y.Doc();
  });

  afterEach(() => doc.destroy());

  const build = (language = "en") =>
    buildNoteEditorOptions({
      doc,
      provider: { awareness: null } as never,
      user: { id: "user-1", name: "Ann" },
      language,
      translate,
    });

  it("共編 fragment 用 shared 的 YDOC_FRAGMENT（與 server 的 collab/store 同名）", () => {
    const options = build();
    expect(options.collaboration.fragment).toBe(doc.getXmlFragment(YDOC_FRAGMENT));
    // 寫死成別的名字會變成兩份互不相干的文件——這條斷言就是防那個。
    expect(options.collaboration.fragment).not.toBe(doc.getXmlFragment("default"));
  });

  it("schema 不含 image block（§11.1 第一道防線）", () => {
    expect(Object.keys(build().schema.blockSpecs)).not.toContain("image");
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

  it("掛上去的 handler 真的會擋檔案貼上（端到端接線，不只是型別對）", () => {
    const event = clipboardEvent(transfer({ files: 1 }));
    expect(build()._tiptapOptions.editorProps.handleDOMEvents.paste(null, event)).toBe(true);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:note.imageUnsupported" });
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
