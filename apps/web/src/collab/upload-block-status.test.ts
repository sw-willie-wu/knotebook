import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { ApiFail } from "@/api/client";
import i18n from "@/i18n";
import { safeMediaUrl } from "@/lib/media-url";
import { putUpload, removeUpload, resetUploadQueueForTest, type UploadItem } from "@/uploads/upload-queue-store";

const runner = vi.hoisted(() => ({ retryUpload: vi.fn(() => Promise.resolve()) }));
vi.mock("@/uploads/upload-runner", () => runner);

const { noteSchema } = await import("./schema");
const { bindUploadNote } = await import("./upload-block-status");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;

const MB = 1024 * 1024;
const mounted: Array<{ editor: AnyEditor; el: HTMLElement }> = [];

function mount(blocks: unknown[], opts: { noteId?: string; resolveFileUrl?: (url: string) => Promise<string>; uploadFile?: (file: File) => Promise<string> } = {}) {
  const editor = BlockNoteEditor.create({
    schema: noteSchema,
    initialContent: blocks as never,
    resolveFileUrl: opts.resolveFileUrl,
    uploadFile: opts.uploadFile,
  }) as AnyEditor;
  if (opts.noteId !== undefined) bindUploadNote(editor, opts.noteId);
  const el = document.createElement("div");
  document.body.append(el);
  editor.mount(el);
  mounted.push({ editor, el });
  return { editor, el };
}

const blockEl = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-id="${id}"] .bn-block-content`)!;
const statusOf = (el: HTMLElement, id: string) => blockEl(el, id).querySelector<HTMLElement>(".kn-upload-status")!;
const addButtonOf = (el: HTMLElement, id: string) => blockEl(el, id).querySelector<HTMLElement>(".bn-add-file-button");

function item(over: Partial<UploadItem> = {}): UploadItem {
  return {
    id: "upload-1",
    noteId: "note-1",
    blockId: "b1",
    fileName: "clip.mp4",
    size: 240 * MB,
    loaded: 110 * MB,
    expectedUrl: "",
    status: "uploading",
    ...over,
  };
}

const videoBlock = (url = "") => ({ id: "b1", type: "video", props: { url } });

beforeEach(async () => {
  await i18n.changeLanguage("en");
  resetUploadQueueForTest();
  runner.retryUpload.mockClear();
});

afterEach(() => {
  for (const m of mounted.splice(0)) {
    m.editor.unmount();
    m.el.remove();
  }
  resetUploadQueueForTest();
  vi.useRealTimers();
});

describe("upload state on the block (queue item for this note and block)", () => {
  it("uploading: file name, percent with sent and total size, a progress bar; the add-file button is hidden", () => {
    const { el } = mount([videoBlock()], { noteId: "note-1" });
    putUpload(item());
    const status = statusOf(el, "b1");
    expect(status.style.display).toBe("");
    expect(status.dataset.uploadState).toBe("uploading");
    expect(status.textContent).toContain("clip.mp4");
    expect(status.textContent).toContain("45% · 110 MB / 240 MB");
    const bar = status.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("45");
    expect(bar.getAttribute("aria-label")).toBe("Uploading clip.mp4");
    expect(addButtonOf(el, "b1")!.style.display).toBe("none");
  });

  it("progress updates in place as the queue item changes", () => {
    const { el } = mount([videoBlock()], { noteId: "note-1" });
    putUpload(item());
    const status = statusOf(el, "b1");
    putUpload(item({ loaded: 180 * MB }));
    expect(statusOf(el, "b1")).toBe(status);
    expect(status.textContent).toContain("75% · 180 MB / 240 MB");
  });

  it("writing: full bar and the saving line", () => {
    const { el } = mount([videoBlock()], { noteId: "note-1" });
    putUpload(item({ status: "writing" }));
    const status = statusOf(el, "b1");
    expect(status.textContent).toContain("100% · 240 MB / 240 MB");
    expect(status.textContent).toContain("Saving to the note…");
  });

  it("pre-check refusal: the reason in red with the formatted sizes, and no Retry", () => {
    const { el } = mount([{ id: "b1", type: "file", props: {} }], { noteId: "note-1" });
    putUpload(item({ fileName: "quote.pdf", status: "failed", precheck: { ok: false, reason: "noRoom", roomBytes: 180 * MB } }));
    const status = statusOf(el, "b1");
    expect(status.querySelector(".text-destructive")!.textContent).toBe("This file is 240 MB; this space has 180 MB left.");
    expect(status.querySelector("button")).toBeNull();
    // A refused file can be swapped for another one from the block.
    expect(addButtonOf(el, "b1")!.style.display).toBe("");
  });

  it("interrupted: the reason, an enabled Retry that runs the runner's retry, and the starts-over hint", async () => {
    const { el } = mount([videoBlock()], { noteId: "note-1" });
    putUpload(item({ status: "failed", error: new ApiFail(0, "upload_interrupted", "x") }));
    const status = statusOf(el, "b1");
    expect(status.querySelector(".text-destructive")!.textContent).toBe("The upload was interrupted. Check your connection and try again.");
    const retry = status.querySelector("button")!;
    expect(retry.disabled).toBe(false);
    expect(retry.textContent).toBe("Retry");
    expect(retry.getAttribute("aria-label")).toBe("Retry clip.mp4");
    expect(status.textContent).toContain("(the upload starts again from the beginning)");
    retry.click();
    await vi.waitFor(() => expect(runner.retryUpload).toHaveBeenCalledWith("upload-1"));
  });

  it("interrupted after the server stored the file (the write timed out): Retry without the starts-over hint", () => {
    const { el } = mount([videoBlock()], { noteId: "note-1" });
    putUpload(item({ status: "failed", error: new ApiFail(0, "upload_interrupted", "x"), stored: true }));
    const status = statusOf(el, "b1");
    expect(status.querySelector("button")!.textContent).toBe("Retry");
    expect(status.textContent).not.toContain("starts again");
  });

  it("a server answer no retry would change (415) shows the reason without Retry; an SVG gets its own text", () => {
    const { el } = mount([{ id: "b1", type: "image", props: {} }], { noteId: "note-1" });
    putUpload(item({ fileName: "logo.png", status: "failed", error: new ApiFail(415, "unsupported_media_type", "x") }));
    expect(statusOf(el, "b1").querySelector(".text-destructive")!.textContent).toBe("That file type isn't supported.");
    expect(statusOf(el, "b1").querySelector("button")).toBeNull();
    putUpload(item({ fileName: "logo.svg", status: "failed", error: new ApiFail(415, "unsupported_media_type", "x") }));
    expect(statusOf(el, "b1").querySelector(".text-destructive")!.textContent).toMatch(/^This SVG can.t be used\./);
  });

  it("a storage-full refusal adds who to ask under the reason; other codes add nothing", () => {
    const { el } = mount([videoBlock()], { noteId: "note-1" });
    const full = new ApiFail(409, "storage_quota_exceeded", "x");
    full.storage = { usedBytes: 1_572_864, quotaBytes: 1_048_576, incomingBytes: 1 };
    putUpload(item({ status: "failed", error: full }));
    const hint = statusOf(el, "b1").querySelector(".text-destructive")!.nextElementSibling!;
    expect(hint.textContent).toBe("1.5 MB of 1 MB used. Ask a site admin for more space.");
    putUpload(item({ status: "failed", error: new ApiFail(409, "storage_quota_exceeded", "x") }));
    expect(statusOf(el, "b1").querySelector(".text-destructive")!.nextElementSibling!.textContent).toBe("This space has no room for the file. Ask its owner or a site admin.");
    putUpload(item({ status: "failed", error: new ApiFail(0, "upload_interrupted", "x") }));
    expect(statusOf(el, "b1").textContent).not.toContain("Ask");
  });

  it("429 with a wait: Retry is disabled with a countdown, then enabled", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { el } = mount([videoBlock()], { noteId: "note-1" });
    putUpload(item({ status: "failed", error: new ApiFail(429, "rate_limited", "x"), retryAt: 1_000_000 + 2_300 }));
    const button = () => statusOf(el, "b1").querySelector("button")!;
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe("Retry in 3 s");
    vi.advanceTimersByTime(300);
    expect(button().textContent).toBe("Retry in 2 s");
    vi.advanceTimersByTime(2_000);
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe("Retry");
  });

  it("while a retry is checking the account, size and room: Checking…, disabled", () => {
    const { el } = mount([videoBlock()], { noteId: "note-1" });
    putUpload(item({ status: "failed", error: new ApiFail(0, "upload_interrupted", "x"), retrying: true }));
    const button = statusOf(el, "b1").querySelector("button")!;
    expect(button.textContent).toBe("Checking…");
    expect(button.disabled).toBe(true);
  });

  it("matches the note too: a copied note keeps block ids, so another note's item with the same block id shows nothing", () => {
    const other = mount([videoBlock()], { noteId: "note-2" });
    const unbound = mount([videoBlock()]);
    putUpload(item());
    expect(statusOf(other.el, "b1").style.display).toBe("none");
    expect(statusOf(unbound.el, "b1").style.display).toBe("none");
    expect(addButtonOf(other.el, "b1")!.style.display).toBe("");
  });

  it("a replace upload on a block that already has a file: the state shows and the file stays", () => {
    const { el } = mount([{ id: "b1", type: "file", props: { url: "/api/uploads/old", name: "old.pdf" } }], { noteId: "note-1" });
    putUpload(item({ fileName: "new.pdf", expectedUrl: "/api/uploads/old" }));
    expect(statusOf(el, "b1").textContent).toContain("new.pdf");
    expect(blockEl(el, "b1").querySelector(".bn-file-name")!.textContent).toBe("old.pdf");
  });

  it("the item leaving the queue (written, dismissed) or losing its place hides the state and brings the add-file button back", () => {
    const { el } = mount([videoBlock()], { noteId: "note-1" });
    putUpload(item());
    putUpload(item({ status: "unplaced" }));
    expect(statusOf(el, "b1").style.display).toBe("none");
    putUpload(item({ status: "failed", error: new ApiFail(0, "upload_interrupted", "x") }));
    removeUpload("upload-1");
    expect(statusOf(el, "b1").style.display).toBe("none");
    expect(statusOf(el, "b1").childElementCount).toBe(0);
    expect(addButtonOf(el, "b1")!.style.display).toBe("");
  });

  it("starting an upload through the editor doesn't swap the add-file button for BlockNote's fixed Loading line", async () => {
    let finish!: (url: string) => void;
    const { editor, el } = mount([videoBlock()], { noteId: "note-1", uploadFile: () => new Promise<string>((resolve) => (finish = resolve)) });
    const pending = editor.uploadFile!(new File(["x"], "clip.mp4", { type: "video/mp4" }), "b1");
    expect(blockEl(el, "b1").textContent).not.toContain("Loading");
    expect(addButtonOf(el, "b1")).not.toBeNull();
    finish("");
    await pending;
  });

  it("HTML export renders no upload state (it has no teardown to end a subscription)", async () => {
    const { editor } = mount([videoBlock()], { noteId: "note-1" });
    putUpload(item());
    expect(await editor.blocksToFullHTML(editor.document)).not.toContain("kn-upload-status");
  });
});

describe("file block name links to the file", () => {
  const fileBlock = (url: string) => ({ id: "f1", type: "file", props: { url, name: "report.pdf" } });
  const resolveFileUrl = (url: string) => Promise.resolve(safeMediaUrl(url));

  it("opens the resolved URL in a new tab, with no download attribute (the server names the download)", async () => {
    const { el } = mount([fileBlock("/api/uploads/u1")], { resolveFileUrl });
    const link = await vi.waitFor(() => {
      const a = blockEl(el, "f1").querySelector<HTMLAnchorElement>(".bn-file-name a");
      if (!a) throw new Error("not linked yet");
      return a;
    });
    expect(link.getAttribute("href")).toBe("/api/uploads/u1");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener");
    expect(link.hasAttribute("download")).toBe(false);
    expect(link.textContent).toBe("report.pdf");
  });

  it.each(["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4="])("%s is not linked", async (url) => {
    const { el } = mount([fileBlock(url)], { resolveFileUrl });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(blockEl(el, "f1").querySelector("a")).toBeNull();
    expect(blockEl(el, "f1").querySelector(".bn-file-name")!.textContent).toBe("report.pdf");
  });

  it("audio and video blocks keep their player and get no name link", async () => {
    const { el } = mount([{ id: "a1", type: "audio", props: { url: "/api/uploads/a1", name: "talk.m4a" } }], { resolveFileUrl });
    await vi.waitFor(() => expect(blockEl(el, "a1").querySelector("audio")!.getAttribute("src")).toBe("/api/uploads/a1"));
    expect(blockEl(el, "a1").querySelector("a")).toBeNull();
  });
});

describe("no object URLs", () => {
  it("rendering uploads, players and file links creates no blob: URL", async () => {
    const spy = vi.fn(() => "blob:x");
    const original = URL.createObjectURL;
    URL.createObjectURL = spy;
    try {
      const { el } = mount(
        [
          { id: "f1", type: "file", props: { url: "/api/uploads/u1", name: "a.pdf" } },
          { id: "v1", type: "video", props: { url: "/api/uploads/v1" } },
          videoBlock(),
        ],
        { noteId: "note-1", resolveFileUrl: (url) => Promise.resolve(safeMediaUrl(url)) },
      );
      putUpload(item());
      await vi.waitFor(() => expect(blockEl(el, "f1").querySelector("a")).not.toBeNull());
      expect(spy).not.toHaveBeenCalled();
      expect(el.innerHTML).not.toContain("blob:");
    } finally {
      URL.createObjectURL = original;
    }
  });
});
