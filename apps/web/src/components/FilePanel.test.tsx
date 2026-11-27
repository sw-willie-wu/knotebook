import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BlockNoteEditor, FilePanelExtension } from "@blocknote/core";
import { BlockNoteContext } from "@blocknote/react";
import i18n from "@/i18n";
import { FakeXhr, installFakeXhr } from "@/test/fake-xhr";
import type { PrecheckCtx } from "@/uploads/precheck";

// The write waits on the note's connection; the panel's part ends once the upload is queued.
vi.mock("@/collab/note-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/collab/note-connection")>()),
  acquireNoteConnection: () => ({
    doc: null,
    provider: {},
    getState: () => ({ phase: "connecting" }),
    isSynced: () => false,
    subscribe: () => () => {},
    whenWritable: () => new Promise(() => {}),
    release: () => {},
  }),
}));

const { noteSchema } = await import("@/collab/schema");
const { createFilePanel } = await import("./FilePanel");
const { resetUploadRunnerForTest } = await import("@/uploads/upload-runner");
const store = await import("@/uploads/upload-queue-store");

/**
 * Headless editor (not `.mount()`ed): the panel only uses `getBlock`/`updateBlock`/`schema`, pure document operations.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; any by repo convention (same as NoteEditor.test.ts)
function headlessEditor(): BlockNoteEditor<any, any, any> {
  return BlockNoteEditor.create({ schema: noteSchema }) as never;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
function insertBlock(editor: BlockNoteEditor<any, any, any>, type: string, props: Record<string, unknown> = {}): string {
  const first = editor.document[0]!;
  return editor.insertBlocks([{ type, props } as never], first, "after")[0]!.id;
}

const MIB = 1_048_576;
const ctxValue = (over: Partial<PrecheckCtx> = {}): PrecheckCtx => ({ maxUploadBytes: 10 * MIB, maxMediaUploadBytes: 100 * MIB, roomBytes: null, ...over });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
function renderPanel(editor: BlockNoteEditor<any, any, any>, noteId: string, blockId: string, precheckCtx: () => Promise<PrecheckCtx> = () => Promise.resolve(ctxValue())) {
  const MyFilePanel = createFilePanel(noteId, precheckCtx);
  return render(
    <BlockNoteContext.Provider value={{ editor }}>
      <MyFilePanel blockId={blockId} />
    </BlockNoteContext.Provider>,
  );
}

/** A File that "claims" `size` bytes without allocating that memory. */
function fileOf(name: string, type: string, size = 3): File {
  const f = new File([new Uint8Array([1, 2, 3])], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

const INPUT_LABELS: Record<string, string> = {
  image: "Choose an image file to upload",
  audio: "Choose an audio file to upload",
  video: "Choose a video file to upload",
  file: "Choose a document or text file to upload",
};

describe("FilePanel (own Upload/Embed tabs for image, audio, video and file blocks)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  let editor: BlockNoteEditor<any, any, any>;

  beforeEach(async () => {
    installFakeXhr();
    await i18n.changeLanguage("en");
    editor = headlessEditor();
  });

  afterEach(() => {
    resetUploadRunnerForTest();
    store.resetUploadQueueForTest();
    vi.unstubAllGlobals();
  });

  describe.each(["image", "audio", "video", "file"])("%s block", (type) => {
    it("two tabs, Upload open by default, with the label for this block type", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);

      expect(screen.getByRole("tab", { name: "Upload" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tab", { name: "Embed link" })).toHaveAttribute("aria-selected", "false");
      expect(screen.getByLabelText(INPUT_LABELS[type]!)).toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Paste a link…")).not.toBeInTheDocument();
    });

    it("switching to Embed replaces the file input with the URL input", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);
      fireEvent.click(screen.getByRole("tab", { name: "Embed link" }));
      expect(screen.queryByLabelText(INPUT_LABELS[type]!)).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText("Paste a link…")).toBeInTheDocument();
    });
  });

  it("the file input's accept follows the block type", () => {
    const accepts = ["image", "audio", "video", "file"].map((type) => {
      const view = renderPanel(editor, "note-1", insertBlock(editor, type));
      const accept = screen.getByLabelText(INPUT_LABELS[type]!).getAttribute("accept")!.split(",");
      view.unmount();
      return accept;
    });
    const [image, audio, video, file] = accepts as [string[], string[], string[], string[]];
    expect(image).toEqual(["image/*"]);
    expect(audio).toEqual(expect.arrayContaining(["audio/mpeg", ".mp3", ".m4a", ".ogg", ".wav", ".flac"]));
    expect(audio.some((a) => a.startsWith("video/"))).toBe(false);
    expect(video).toEqual(expect.arrayContaining(["video/mp4", ".mp4", ".webm", ".mov"]));
    expect(file).toEqual(expect.arrayContaining(["application/pdf", ".pdf", ".docx", ".odt", "text/csv", ".csv", ".txt", ".md"]));
    expect(file.some((a) => /^(audio|video|image)\//.test(a))).toBe(false);
  });

  it("picking a file queues the upload for this block, expecting its current URL, and closes the panel", async () => {
    const blockId = insertBlock(editor, "file");
    editor.getExtension(FilePanelExtension)!.showMenu(blockId);
    renderPanel(editor, "note-1", blockId);

    fireEvent.change(screen.getByLabelText(INPUT_LABELS.file!), { target: { files: [fileOf("quote.pdf", "application/pdf")] } });

    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    expect(FakeXhr.instances[0]!.url).toBe("/api/notes/note-1/uploads");
    expect(store.getUploadItems()).toMatchObject([{ noteId: "note-1", blockId, expectedUrl: "", fileName: "quote.pdf", status: "uploading" }]);
    await waitFor(() => expect(editor.getExtension(FilePanelExtension)!.store.state).toBeUndefined());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("replacing a block's file: the upload expects the URL the block has now", async () => {
    const blockId = insertBlock(editor, "video", { url: "/api/uploads/old", name: "old.mp4" });
    renderPanel(editor, "note-1", blockId);
    fireEvent.change(screen.getByLabelText(INPUT_LABELS.video!), { target: { files: [fileOf("new.mp4", "video/mp4")] } });
    await waitFor(() => expect(store.getUploadItems()).toMatchObject([{ blockId, expectedUrl: "/api/uploads/old" }]));
  });

  it("the expected URL is read once the check has passed: a file written into the block during the check is the one replaced", async () => {
    const blockId = insertBlock(editor, "file", { url: "/api/uploads/old", name: "old.pdf" });
    let answer!: (ctx: PrecheckCtx) => void;
    renderPanel(editor, "note-1", blockId, () => new Promise((resolve) => (answer = resolve)));
    fireEvent.change(screen.getByLabelText(INPUT_LABELS.file!), { target: { files: [fileOf("new.pdf", "application/pdf")] } });
    await waitFor(() => expect(answer).toBeDefined());
    editor.updateBlock(blockId, { props: { url: "/api/uploads/meanwhile" } } as never);
    answer(ctxValue());
    await waitFor(() => expect(store.getUploadItems()).toMatchObject([{ blockId, expectedUrl: "/api/uploads/meanwhile" }]));
  });

  it.each([
    ["video", fileOf("all-day.mp4", "video/mp4", 300 * MIB), ctxValue(), "This file is 300 MB; the limit for this type is 100 MB."],
    ["file", fileOf("quote.pdf", "application/pdf", 5 * MIB), ctxValue({ roomBytes: 2 * MIB }), "This file is 5 MB; this space has 2 MB left."],
    ["file", fileOf("blank.txt", "text/plain", 0), ctxValue(), "This file is empty."],
    ["file", fileOf("bundle.zip", "application/zip", MIB), ctxValue(), "This file type isn't supported. You can upload images, audio, video, PDFs, Office documents and text files."],
  ])("%s block: a pre-check refusal shows inline only; nothing is sent, nothing queued, the block is untouched", async (type, file, ctx, message) => {
    const blockId = insertBlock(editor, type);
    renderPanel(editor, "note-1", blockId, () => Promise.resolve(ctx));
    fireEvent.change(screen.getByLabelText(INPUT_LABELS[type]!), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
    expect(FakeXhr.instances).toHaveLength(0);
    expect(store.getUploadItems()).toEqual([]);
    expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("");
  });

  it("the getter is asked at each pick: a later answer with more room lets the same panel send", async () => {
    let room = 2 * MIB;
    const blockId = insertBlock(editor, "file");
    renderPanel(editor, "note-1", blockId, () => Promise.resolve(ctxValue({ roomBytes: room })));
    const input = screen.getByLabelText(INPUT_LABELS.file!);

    fireEvent.change(input, { target: { files: [fileOf("quote.pdf", "application/pdf", 5 * MIB)] } });
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(FakeXhr.instances).toHaveLength(0);

    room = 50 * MIB;
    fireEvent.change(input, { target: { files: [fileOf("quote.pdf", "application/pdf", 5 * MIB)] } });
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("someone who can't see the usage (room unknown): the file is sent and the server decides", async () => {
    const blockId = insertBlock(editor, "file");
    renderPanel(editor, "note-1", blockId, () => Promise.resolve(ctxValue({ roomBytes: undefined })));
    fireEvent.change(screen.getByLabelText(INPUT_LABELS.file!), { target: { files: [fileOf("quote.pdf", "application/pdf", 9 * MIB)] } });
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
  });

  it("no object URL is made for the picked file", async () => {
    const spy = vi.fn(() => "blob:x");
    Object.defineProperty(URL, "createObjectURL", { value: spy, configurable: true, writable: true });
    try {
      renderPanel(editor, "note-1", insertBlock(editor, "image"));
      fireEvent.change(screen.getByLabelText(INPUT_LABELS.image!), { target: { files: [fileOf("a.png", "image/png")] } });
      await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      delete (URL as { createObjectURL?: unknown }).createObjectURL;
    }
  });

  describe("image block Embed tab", () => {
    // The image block's EmbedTab is the same component but only renders the URL input after "switching to Embed tab";
    // the scheme allowlist logic itself is covered by the audio/video/file cases, this adds coverage of the image block's entry path (coverage only, no new logic).
    it("Embed tab: javascript: pseudo URL -> rejected with an inline error, props.url not written", () => {
      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);
      fireEvent.click(screen.getByRole("tab", { name: "Embed link" }));

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid http:// or https:// link.");
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("");
    });

    it("Embed tab: https:// -> accepted (no error)", () => {
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

  describe.each(["audio", "video", "file"])("%s block Embed tab", (type) => {
    function renderEmbed(blockId: string) {
      renderPanel(editor, "note-1", blockId);
      fireEvent.click(screen.getByRole("tab", { name: "Embed link" }));
    }

    it("Embed: enter a URL and press Enter -> block writes back url/name", () => {
      const blockId = insertBlock(editor, type);
      renderEmbed(blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "https://example.com/clip.mp4" } });
      fireEvent.keyDown(input, { key: "Enter" });

      const props = editor.getBlock(blockId)!.props as Record<string, unknown>;
      expect(props.url).toBe("https://example.com/clip.mp4");
      expect(props.name).toBe("clip.mp4");
    });

    it("Embed: clicking the button also submits (no need for Enter)", () => {
      const blockId = insertBlock(editor, type);
      renderEmbed(blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "https://example.com/clip.mp4" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("https://example.com/clip.mp4");
    });

    it("blank URL: button disabled, Enter doesn't submit", () => {
      const blockId = insertBlock(editor, type);
      renderEmbed(blockId);

      expect(screen.getByRole("button", { name: "Embed" })).toBeDisabled();

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.keyDown(input, { key: "Enter" });

      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("");
    });

    // URL scheme allowlist for the Embed tab (security).
    it("javascript: pseudo URL -> rejected with an inline error, props.url not written", () => {
      const blockId = insertBlock(editor, type);
      renderEmbed(blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid http:// or https:// link.");
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("");
    });

    it("no scheme (new URL fails to parse) -> rejected with an inline error, no scheme auto-prepended", () => {
      const blockId = insertBlock(editor, type);
      renderEmbed(blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "example.com/a.png" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid http:// or https:// link.");
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("");
    });

    it("https:// -> accepted (no error)", () => {
      const blockId = insertBlock(editor, type);
      renderEmbed(blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "https://example.com/clip.mp4" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("https://example.com/clip.mp4");
    });

    it("http:// -> accepted (no error)", () => {
      const blockId = insertBlock(editor, type);
      renderEmbed(blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "http://example.com/clip.mp4" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("http://example.com/clip.mp4");
    });
  });
});
