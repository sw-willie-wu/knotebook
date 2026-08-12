import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteContext } from "@blocknote/react";
import { MAX_UPLOAD_BYTES } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { createFilePanel } from "./FilePanel";

/**
 * headless 編輯器（不 `.mount()`）：`createFilePanel` 只用到 `getBlock`/`updateBlock`
 * ——純文件操作，跟 `wikilink/menu.test.tsx` 需要 mount 才能用的 `openSuggestionMenu`
 * （atom node NodeView 渲染）不是同一類，不需要真的掛進 DOM。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 NoteEditor.test.ts）
function headlessEditor(): BlockNoteEditor<any, any, any> {
  return BlockNoteEditor.create({ schema: noteSchema }) as never;
}

/** 在文件裡插入一個指定型別的 block，回傳它的 id。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
function insertBlock(editor: BlockNoteEditor<any, any, any>, type: string): string {
  const first = editor.document[0]!;
  return editor.insertBlocks([{ type } as never], first, "after")[0]!.id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
function renderPanel(editor: BlockNoteEditor<any, any, any>, noteId: string, blockId: string) {
  const MyFilePanel = createFilePanel(noteId);
  return render(
    <BlockNoteContext.Provider value={{ editor }}>
      <MyFilePanel blockId={blockId} />
    </BlockNoteContext.Provider>,
  );
}

function pngFile(name = "a.png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

/** 建一個「聲稱」超過 `MAX_UPLOAD_BYTES` 的 File——不真的配置那麼多記憶體（同
 * `upload-file.test.ts` 的 `oversizedFile` 手法）。 */
function oversizedPngFile(): File {
  const f = pngFile();
  Object.defineProperty(f, "size", { value: MAX_UPLOAD_BYTES + 1 });
  return f;
}

function fakeResponse({ ok, status, json }: { ok: boolean; status: number; json?: () => Promise<unknown> }): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

describe("FilePanel（Task 14：image block 恢復＋自家 Upload/Embed tab）", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  let editor: BlockNoteEditor<any, any, any>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    editor = headlessEditor();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("image block", () => {
    it("兩個 tab：Upload（預設開啟）與 Embed", () => {
      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);

      expect(screen.getByRole("tablist")).toBeInTheDocument();
      const uploadTab = screen.getByRole("tab", { name: "Upload" });
      const embedTab = screen.getByRole("tab", { name: "Embed link" });
      expect(uploadTab).toHaveAttribute("aria-selected", "true");
      expect(embedTab).toHaveAttribute("aria-selected", "false");

      // Upload tab 預設開啟：檔案輸入在畫面上，Embed 的網址輸入不在。
      expect(screen.getByLabelText("Choose an image file to upload")).toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Paste a link…")).not.toBeInTheDocument();
    });

    it("切到 Embed tab：Upload 的檔案輸入消失，換成網址輸入", () => {
      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);

      fireEvent.click(screen.getByRole("tab", { name: "Embed link" }));

      expect(screen.queryByLabelText("Choose an image file to upload")).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText("Paste a link…")).toBeInTheDocument();
    });

    it("上傳成功：呼叫 postUpload（真的打 fetch），block 拿到回傳的 url", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u1", url: "/api/uploads/u1" }) }));
      vi.stubGlobal("fetch", fetchMock);

      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByLabelText("Choose an image file to upload");
      fireEvent.change(input, { target: { files: [pngFile()] } });

      await waitFor(() => {
        expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("/api/uploads/u1");
      });
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/notes/note-1/uploads`,
        expect.objectContaining({ method: "POST" }),
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("上傳失敗（已知錯誤碼）：行內錯誤顯示對應 errors.<code> 文案，不是通用文案；block 完全不動（不是 editor.uploadFile 那條會誤刪 block 的路徑）", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        fakeResponse({
          ok: false,
          status: 415,
          json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }),
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByLabelText("Choose an image file to upload");
      fireEvent.change(input, { target: { files: [pngFile()] } });

      await waitFor(() => {
        // 審查修復（Important 2）：`errors.unsupported_media_type` 的實際文案，
        // 不是通用的 `note.filePanel.upload.error`——已知錯誤碼要顯示對症下藥的訊息。
        expect(screen.getByRole("alert")).toHaveTextContent("That file type isn't supported.");
      });

      // block 還在、props 沒被動過（沒有 url 寫入，也沒有被移除）。
      const block = editor.getBlock(blockId);
      expect(block).toBeDefined();
      expect((block!.props as Record<string, unknown>).url).toBe("");
    });

    it("上傳失敗（檔案過大，client 前驗 reject，不打 fetch）：顯示 errors.file_too_large，不是誤導的通用「請再試一次」", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByLabelText("Choose an image file to upload");
      fireEvent.change(input, { target: { files: [oversizedPngFile()] } });

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("That file is too large to upload.");
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("");
    });

    it("上傳失敗（非 ApiFail，例如網路層例外）：落回通用文案", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
      );

      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByLabelText("Choose an image file to upload");
      fireEvent.change(input, { target: { files: [pngFile()] } });

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("Couldn't upload the file. Please try again.");
      });
    });

    // review fix round 1（L-3）：image block 的 EmbedTab 是同一個元件，但只有透過
    // 「切到 Embed tab」才會渲染網址輸入——scheme 白名單邏輯本身在 audio/video/file
    // 三案已覆蓋，這裡補 image block 這條進入路徑本身的覆蓋面（純覆蓋面，不是新邏輯）。
    it("Embed tab：javascript: 偽 URL → 拒收＋行內錯誤，props.url 未寫入", () => {
      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);
      fireEvent.click(screen.getByRole("tab", { name: "Embed link" }));

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid http:// or https:// link.");
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("");
    });

    it("Embed tab：https:// → 通過（不觸發錯誤）", () => {
      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);
      fireEvent.click(screen.getByRole("tab", { name: "Embed link" }));

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "https://example.com/a.png" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("https://example.com/a.png");
    });
  });

  describe.each(["audio", "video", "file"])("%s block（只有 Embed，沒有 Upload tab）", (type) => {
    it("沒有分頁列、沒有檔案輸入，直接是網址輸入", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);

      expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Choose an image file to upload")).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText("Paste a link…")).toBeInTheDocument();
    });

    it("Embed：輸入網址、按 Enter → block 寫回 url/name", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "https://example.com/clip.mp4" } });
      fireEvent.keyDown(input, { key: "Enter" });

      const props = editor.getBlock(blockId)!.props as Record<string, unknown>;
      expect(props.url).toBe("https://example.com/clip.mp4");
      expect(props.name).toBe("clip.mp4");
    });

    it("Embed：點按鈕也能提交（不必靠 Enter）", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "https://example.com/clip.mp4" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("https://example.com/clip.mp4");
    });

    it("空白網址：按鈕停用，Enter 不提交", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);

      expect(screen.getByRole("button", { name: "Embed" })).toBeDisabled();

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.keyDown(input, { key: "Enter" });

      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("");
    });

    // 安全 backlog ④（spec §13.2/§13.5）：Embed tab 的 URL scheme 白名單。
    it("javascript: 偽 URL → 拒收＋行內錯誤，props.url 未寫入", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid http:// or https:// link.");
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("");
    });

    it("無 scheme（new URL 解析失敗）→ 拒收＋行內錯誤，不自動補 scheme", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "example.com/a.png" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid http:// or https:// link.");
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("");
    });

    it("https:// → 通過（不觸發錯誤）", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "https://example.com/clip.mp4" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("https://example.com/clip.mp4");
    });

    it("http:// → 通過（不觸發錯誤）", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "http://example.com/clip.mp4" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("http://example.com/clip.mp4");
    });
  });
});
