import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import i18n from "@/i18n";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { stubLayoutTier } from "@/test/layout-tier";
import { loadFilePreview } from "./file-preview-chunk";
import { FilePreviewLayer } from "./FilePreviewLayer";

const TEXT = "text/plain; charset=utf-8";

/** The shape `upload-block-status.ts` renders for a file block's name (checked against a real editor in its own test). */
function fileBlock(name: string, href: string): HTMLDivElement {
  const content = document.createElement("div");
  content.className = "bn-block-content";
  content.dataset.contentType = "file";
  const nameEl = document.createElement("div");
  nameEl.className = "bn-file-name";
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = name;
  nameEl.append(a);
  content.append(nameEl);
  return content;
}

function setup(name: string, href = "/api/uploads/u1") {
  const container = document.createElement("div");
  const block = fileBlock(name, href);
  container.append(block);
  document.body.append(container);
  render(<FilePreviewLayer container={container} />);
  return { container, link: block.querySelector("a")! };
}

function textResponse(body: string, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(body, { status: 206, headers: { "content-type": TEXT, "content-range": `bytes 0-${Math.max(body.length - 1, 0)}/${body.length}`, ...headers } })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** fireEvent returns false when a listener called preventDefault, i.e. the browser would not have followed the link. */
function click(link: HTMLElement, init: MouseEventInit = {}): boolean {
  return fireEvent.click(link, { button: 0, ...init });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  await loadFilePreview();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("which clicks open the preview", () => {
  it.each(["notes.txt", "data.csv", "readme.md", "payload.json", "server.log"])("%s: a plain click opens the text in the modal instead of following the link", async (name) => {
    const fetchMock = textResponse("alpha,1");
    const { link } = setup(name);
    expect(click(link)).toBe(false);
    const dialog = await screen.findByRole("dialog", { name });
    expect(await within(dialog).findByText("alpha,1")).toBeInstanceOf(HTMLPreElement);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("spec.pdf: a frame of the upload URL with a title and no sandbox; nothing is fetched by script", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { link } = setup("spec.pdf", "/api/public/notes/TOKEN/uploads/u1");
    expect(click(link)).toBe(false);
    const dialog = await screen.findByRole("dialog", { name: "spec.pdf" });
    const frame = dialog.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("/api/public/notes/TOKEN/uploads/u1");
    expect(frame.title).toBe("spec.pdf preview");
    expect(frame.hasAttribute("sandbox")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["middle button", { button: 1 }],
  ] as const)("%s click keeps the browser's default", async (_label, init) => {
    const { link } = setup("data.csv");
    expect(click(link, init)).toBe(true);
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["Office file", "report.docx", "/api/uploads/u1"],
    ["text type outside the keep list", "build.ps1", "/api/uploads/u1"],
    ["another site's PDF", "spec.pdf", "https://files.example/spec.pdf"],
    ["an Embed-tab URL on this origin that is not an upload", "spec.pdf", "/files/spec.pdf"],
  ])("%s: unchanged", async (_label, name, href) => {
    const { link } = setup(name, href);
    expect(click(link)).toBe(true);
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a text link to an upload (not a file block's name) is left alone", async () => {
    const container = document.createElement("div");
    container.innerHTML = '<p><a href="/api/uploads/u1" target="_blank">data.csv</a></p>';
    document.body.append(container);
    render(<FilePreviewLayer container={container} />);
    expect(click(container.querySelector("a")!)).toBe(true);
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a layer nested in another one's container opens one modal, not two", async () => {
    textResponse("alpha,1");
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    const block = fileBlock("data.csv", "/api/uploads/u1");
    inner.append(block);
    outer.append(inner);
    document.body.append(outer);
    render(
      <>
        <FilePreviewLayer container={outer} />
        <FilePreviewLayer container={inner} />
      </>,
    );
    click(block.querySelector("a")!);
    await screen.findByRole("dialog");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("phone layout: a PDF keeps opening in a new tab; text still uses the modal", async () => {
    stubLayoutTier("phone");
    textResponse("alpha,1");
    const { container, link } = setup("spec.pdf");
    expect(click(link)).toBe(true);
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();

    const csv = fileBlock("data.csv", "/api/uploads/u2");
    container.append(csv);
    expect(click(csv.querySelector("a")!)).toBe(false);
    expect(await screen.findByRole("dialog", { name: "data.csv" })).toBeInTheDocument();
  });
});

describe("mount points", () => {
  // DiffEditor and the trash preview have behavioural tests (VersionPreview.test.tsx, TrashPreviewEditor.test.tsx); the note and public pages render too much to mount here.
  it.each([
    ["src/components/NoteEditor.tsx", "<FilePreviewLayer container={columnEl} />"],
    ["src/pages/PublicNotePage.tsx", "<FilePreviewLayer container={columnEl} />"],
    ["src/components/versions/VersionPreview.tsx", "<FilePreviewLayer container={box} />"],
    ["src/components/TrashPreviewEditor.tsx", "<FilePreviewLayer container={box} />"],
  ])("%s mounts the layer on the element that holds its editor", (path, tag) => {
    expect(readFileSync(join(process.cwd(), path), "utf8")).toContain(tag);
  });
});

describe("text", () => {
  it("is rendered as text: an HTML-looking file shows its tags literally", async () => {
    const html = '<b>bold</b><img src=x onerror="alert(1)"><script>alert(2)</script>';
    textResponse(html);
    const { link } = setup("page.md");
    click(link);
    const dialog = await screen.findByRole("dialog");
    const pre = await waitFor(() => {
      const el = dialog.querySelector("pre");
      if (!el?.textContent) throw new Error("not loaded");
      return el;
    });
    expect(pre.textContent).toBe(html);
    expect(pre.children).toHaveLength(0);
    expect(dialog.querySelector("b, img, script")).toBeNull();
  });

  it("wraps long lines inside a scrollable body", async () => {
    textResponse("x".repeat(500));
    const { link } = setup("data.csv");
    click(link);
    const pre = await within(await screen.findByRole("dialog")).findByText("x".repeat(500));
    expect(pre.className).toContain("whitespace-pre-wrap");
    expect(pre.className).toContain("[overflow-wrap:anywhere]");
    expect(pre.className).toContain("font-mono");
  });

  it("shows a loading state until the text arrives", async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (resolve = r))));
    const { link } = setup("data.csv");
    click(link);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Loading…")).toBeInTheDocument();
    await act(async () => resolve(new Response("alpha,1", { status: 206, headers: { "content-type": TEXT, "content-range": "bytes 0-6/7" } })));
    expect(await within(dialog).findByText("alpha,1")).toBeInTheDocument();
    expect(within(dialog).queryByText("Loading…")).toBeNull();
  });

  it("larger than 1 MiB: a one-line notice above the text, with the open and download actions", async () => {
    textResponse("alpha,1", { "content-range": `bytes 0-1048575/${2 * 1024 * 1024}` });
    const { link } = setup("big.log");
    click(link);
    const dialog = await screen.findByRole("dialog");
    const notice = await within(dialog).findByText("Only the first 1 MB is shown.");
    const row = notice.closest("[data-file-preview-notice]") as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).getByRole("link", { name: "Open in new tab" })).toHaveAttribute("href", "/api/uploads/u1");
    expect(within(row).getByRole("link", { name: "Download" })).toHaveAttribute("download");
    const pre = dialog.querySelector("pre")!;
    expect(row.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("within 1 MiB: no notice", async () => {
    textResponse("alpha,1");
    const { link } = setup("data.csv");
    click(link);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("alpha,1");
    expect(within(dialog).queryByText("Only the first 1 MB is shown.")).toBeNull();
  });

  it.each([
    ["404", () => Promise.resolve(new Response(null, { status: 404 }))],
    ["403", () => Promise.resolve(new Response(null, { status: 403 }))],
    ["a non-text type", () => Promise.resolve(new Response("%PDF", { status: 206, headers: { "content-type": "application/pdf", "content-range": "bytes 0-3/4" } }))],
    ["a network error", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("error (%s): a short message with the open and download actions", async (_label, impl) => {
    vi.stubGlobal("fetch", vi.fn(impl));
    const { link } = setup("data.csv");
    click(link);
    const dialog = await screen.findByRole("dialog");
    const message = await within(dialog).findByText("This file can't be shown here.");
    const row = message.closest("[data-file-preview-notice]") as HTMLElement;
    expect(within(row).getByRole("link", { name: "Open in new tab" })).toHaveAttribute("target", "_blank");
    expect(within(row).getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/uploads/u1");
    expect(dialog.querySelector("pre")).toBeNull();
  });
});

describe("the modal", () => {
  it("header: the file name, Open in new tab (a real new-tab link) and Download (the served name: no value on download)", async () => {
    textResponse("alpha,1");
    const { link } = setup("data.csv");
    click(link);
    const dialog = await screen.findByRole("dialog", { name: "data.csv" });
    const header = dialog.querySelector("[data-file-preview-header]") as HTMLElement;
    expect(within(header).getByText("data.csv")).toBeInTheDocument();
    const open = within(header).getByRole("link", { name: "Open in new tab" });
    expect(open).toHaveAttribute("href", "/api/uploads/u1");
    expect(open).toHaveAttribute("target", "_blank");
    expect(open.getAttribute("rel")).toContain("noopener");
    const download = within(header).getByRole("link", { name: "Download" });
    expect(download).toHaveAttribute("href", "/api/uploads/u1");
    expect(download.getAttribute("download")).toBe("");
  });

  it("focus starts on the close button", async () => {
    textResponse("alpha,1");
    const { link } = setup("data.csv");
    click(link);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus());
  });

  it.each([
    ["Esc", (dialog: HTMLElement) => fireEvent.keyDown(dialog, { key: "Escape" })],
    ["the close button", (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))],
    [
      "a press and click on the backdrop",
      () => {
        const backdrop = document.querySelector<HTMLElement>(".kb-sheet-overlay")!;
        fireEvent.pointerDown(backdrop, { button: 0 });
        // The press alone must not close: the close waits for the click, so no click lands on the page underneath.
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        fireEvent.click(backdrop, { button: 0 });
      },
    ],
  ])("%s closes it and focus returns to the link", async (_label, close) => {
    textResponse("alpha,1");
    const { link } = setup("data.csv");
    link.focus();
    click(link);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("alpha,1");
    close(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(link).toHaveFocus());
  });

  it("a click inside the panel does not close it", async () => {
    textResponse("alpha,1");
    const { link } = setup("data.csv");
    click(link);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByText("alpha,1"));
    fireEvent.click(dialog.querySelector("[data-file-preview-header]")!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  // The press starts in the panel, so Radix sees no outside press and the click that follows a drag lands on a common ancestor.
  it("a text selection dragged from the text and released on the backdrop does not close it", async () => {
    textResponse("alpha,1");
    const { link } = setup("data.csv");
    click(link);
    const dialog = await screen.findByRole("dialog");
    const pre = await within(dialog).findByText("alpha,1");
    fireEvent.pointerDown(pre, { clientX: 300, clientY: 200 });
    fireEvent.pointerUp(document.body, { clientX: 20, clientY: 20 });
    fireEvent.click(document.body, { clientX: 20, clientY: 20 });
    await act(async () => {});
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("a press on the page's scrollbar (the document element) does not close it", async () => {
    textResponse("alpha,1");
    const { link } = setup("data.csv");
    click(link);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("alpha,1");
    fireEvent.pointerDown(document.documentElement);
    fireEvent.click(document.documentElement);
    await act(async () => {});
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("on the note page it is not Radix-modal: no body scroll lock (the image lightbox's reason: restyling long notes)", async () => {
    textResponse("alpha,1");
    const { link } = setup("data.csv");
    click(link);
    await screen.findByRole("dialog");
    expect(document.body).not.toHaveAttribute("data-scroll-locked");
  });

  it("Tab stays inside: from the last control it wraps to the first", async () => {
    textResponse("alpha,1");
    const { link } = setup("data.csv");
    click(link);
    const dialog = await screen.findByRole("dialog");
    const closeButton = within(dialog).getByRole("button", { name: "Close" });
    await waitFor(() => expect(closeButton).toHaveFocus());
    await within(dialog).findByText("alpha,1");
    const body = dialog.querySelector<HTMLElement>("[data-file-preview-body]")!;
    body.focus();
    fireEvent.keyDown(body, { key: "Tab" });
    expect(within(dialog).getAllByRole("link", { name: "Open in new tab" })[0]).toHaveFocus();
  });

  it("the page behind is hidden from assistive technology while it is open", async () => {
    textResponse("alpha,1");
    const { container, link } = setup("data.csv");
    click(link);
    await screen.findByRole("dialog");
    await waitFor(() => expect(container).toHaveAttribute("aria-hidden", "true"));
  });

  it("inside another dialog: opens on top, Esc and clicks inside close only the preview", async () => {
    textResponse("alpha,1");
    const onOuterChange = vi.fn();
    function Outer() {
      const [box, setBox] = useState<HTMLDivElement | null>(null);
      return (
        <Dialog open onOpenChange={onOuterChange}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Compare</DialogTitle>
            <div
              ref={(el) => {
                if (el && el.childElementCount === 0) el.append(fileBlock("data.csv", "/api/uploads/u1"));
                setBox(el);
              }}
            />
            <FilePreviewLayer container={box} />
          </DialogContent>
        </Dialog>
      );
    }
    render(<Outer />);
    const outer = await screen.findByRole("dialog", { name: "Compare" });
    const link = within(outer).getByRole("link", { name: "data.csv" });
    expect(click(link)).toBe(false);
    expect(document.body).toHaveAttribute("data-scroll-locked", "1");
    const preview = await screen.findByRole("dialog", { name: "data.csv" });
    // Modal inside another modal: its own scroll lock on top, so its text body can still scroll.
    await waitFor(() => expect(document.body).toHaveAttribute("data-scroll-locked", "2"));
    const text = await within(preview).findByText("alpha,1");
    fireEvent.pointerDown(text);
    fireEvent.mouseDown(text);
    fireEvent.focusIn(within(preview).getByRole("button", { name: "Close" }));
    fireEvent.click(text);
    expect(onOuterChange).not.toHaveBeenCalled();
    fireEvent.keyDown(preview, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "data.csv" })).toBeNull());
    expect(onOuterChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Compare" })).toBeInTheDocument();
    // Its own lock released, the outer one kept; focus back on the link inside the outer dialog.
    await waitFor(() => expect(document.body).toHaveAttribute("data-scroll-locked", "1"));
    await waitFor(() => expect(link).toHaveFocus());
  });
});
