import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteContext } from "@blocknote/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuthConfigDto } from "@knotebook/shared";
import { AUTH_CONFIG_QUERY_KEY } from "@/api/authConfig";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { createFilePanel } from "./FilePanel";

/**
 * Headless editor (not `.mount()`ed): `createFilePanel` only uses `getBlock`/`updateBlock`, pure document operations. Unlike `openSuggestionMenu` in
 * `wikilink/menu.test.tsx` (which needs mounting for the atom node NodeView rendering), no real DOM mount is needed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; any by repo convention (same as NoteEditor.test.ts)
function headlessEditor(): BlockNoteEditor<any, any, any> {
  return BlockNoteEditor.create({ schema: noteSchema }) as never;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
function insertBlock(editor: BlockNoteEditor<any, any, any>, type: string): string {
  const first = editor.document[0]!;
  return editor.insertBlocks([{ type } as never], first, "after")[0]!.id;
}

/** The panel's upload tab reads `useAuthConfig()`: the test config is pre-placed in the cache so the pre-check limit doesn't wait for a fetch. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
function renderPanel(editor: BlockNoteEditor<any, any, any>, noteId: string, blockId: string, config: Partial<AuthConfigDto> = {}) {
  const MyFilePanel = createFilePanel(noteId);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(AUTH_CONFIG_QUERY_KEY, config);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <BlockNoteContext.Provider value={{ editor }}>
        <MyFilePanel blockId={blockId} />
      </BlockNoteContext.Provider>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

/** `fetch` stub: `GET /api/auth/config` returns `config`, everything else (upload) goes to `upload`; returns `upload` so assertions count only upload endpoint calls. */
function stubFetch(upload: ReturnType<typeof vi.fn>, config: Partial<AuthConfigDto> | (() => Partial<AuthConfigDto>) = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) =>
      url === "/api/auth/config"
        ? Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(typeof config === "function" ? config() : config) }))
        : upload(url, init),
    ),
  );
  return upload;
}

function pngFile(name = "a.png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

const ONE_MIB = 1048576;

/** A File that "claims" `size` bytes without allocating that memory (same technique as `fileOfSize` in `uploads/upload-file.test.ts`). */
function pngFileOfSize(size: number): File {
  const f = pngFile();
  Object.defineProperty(f, "size", { value: size });
  return f;
}

function fakeResponse({ ok, status, json }: { ok: boolean; status: number; json?: () => Promise<unknown> }): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

describe("FilePanel (image block recovery + own Upload/Embed tabs)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  let editor: BlockNoteEditor<any, any, any>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    editor = headlessEditor();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("image block", () => {
    it("two tabs: Upload (open by default) and Embed", () => {
      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);

      expect(screen.getByRole("tablist")).toBeInTheDocument();
      const uploadTab = screen.getByRole("tab", { name: "Upload" });
      const embedTab = screen.getByRole("tab", { name: "Embed link" });
      expect(uploadTab).toHaveAttribute("aria-selected", "true");
      expect(embedTab).toHaveAttribute("aria-selected", "false");

      expect(screen.getByLabelText("Choose an image file to upload")).toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Paste a link…")).not.toBeInTheDocument();
    });

    it("switching to the Embed tab: Upload's file input disappears, replaced by the URL input", () => {
      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);

      fireEvent.click(screen.getByRole("tab", { name: "Embed link" }));

      expect(screen.queryByLabelText("Choose an image file to upload")).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText("Paste a link…")).toBeInTheDocument();
    });

    it("upload success: calls postUpload (really hits fetch), the block gets the returned url", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u1", url: "/api/uploads/u1" }) }));
      stubFetch(fetchMock);

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

    it("SVG upload (#389): file input accepts image/* and uploading an image/svg+xml file writes the returned url", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u-svg", url: "/api/uploads/u-svg" }) }));
      stubFetch(fetchMock);

      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByLabelText("Choose an image file to upload");
      expect(input).toHaveAttribute("accept", "image/*");
      const svgFile = new File(['<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'], "icon.svg", {
        type: "image/svg+xml",
      });
      fireEvent.change(input, { target: { files: [svgFile] } });

      await waitFor(() => {
        expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("/api/uploads/u-svg");
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("upload failure (known error code): the inline error shows the matching errors.<code> text, not the generic one; the block is untouched (not the editor.uploadFile path that would wrongly delete the block)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        fakeResponse({
          ok: false,
          status: 415,
          json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }),
        }),
      );
      stubFetch(fetchMock);

      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByLabelText("Choose an image file to upload");
      fireEvent.change(input, { target: { files: [pngFile()] } });

      await waitFor(() => {
        // The actual text of `errors.unsupported_media_type`, not the generic `note.filePanel.upload.error`:
        // a known error code must show a targeted message.
        expect(screen.getByRole("alert")).toHaveTextContent("That file type isn't supported.");
      });

      const block = editor.getBlock(blockId);
      expect(block).toBeDefined();
      expect((block!.props as Record<string, unknown>).url).toBe("");
    });

    it.each([
      ["by extension with no MIME type", new File(["x"], "logo.SVG", { type: "" })],
      ["by MIME type", new File(["x"], "logo", { type: "image/svg+xml" })],
    ])("an SVG refused as unsupported (%s) shows the SVG-specific text, not the generic file-type one", async (_label, svgFile) => {
      stubFetch(vi.fn().mockResolvedValue(fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) })));

      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);

      fireEvent.change(screen.getByLabelText("Choose an image file to upload"), { target: { files: [svgFile] } });

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent(/^This SVG can.t be used\. Check that it.s well-formed XML/);
      });
      expect(screen.getByRole("alert")).not.toHaveTextContent("That file type isn't supported.");
    });

    it("upload rejected by quota (with numbers): two inline lines, 'Storage is full' plus a usage sentence; block untouched", async () => {
      stubFetch(vi.fn().mockResolvedValue(fakeResponse({
        ok: false, status: 409,
        json: () => Promise.resolve({ error: { code: "storage_quota_exceeded", message: "x" }, storage: { incomingBytes: 3, usedBytes: 1572864, quotaBytes: 1048576 } }),
      })));
      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);
      fireEvent.change(screen.getByLabelText("Choose an image file to upload"), { target: { files: [pngFile()] } });
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Storage is full"));
      expect(screen.getByRole("alert")).toHaveTextContent("1.5 MB of 1 MB used. Ask a site admin for more space.");
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("");
    });

    it("upload rejected by quota (no numbers): inline generic sentence", async () => {
      stubFetch(vi.fn().mockResolvedValue(fakeResponse({
        ok: false, status: 409,
        json: () => Promise.resolve({ error: { code: "storage_quota_exceeded", message: "x" }, storage: { incomingBytes: null } }),
      })));
      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);
      fireEvent.change(screen.getByLabelText("Choose an image file to upload"), { target: { files: [pngFile()] } });
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Storage is full"));
      expect(screen.getByRole("alert")).toHaveTextContent("This space has no room for the file. Ask its owner or a site admin.");
    });

    it("upload failure (file exceeds config's maxUploadBytes, client pre-check rejects, upload endpoint not hit): shows errors.file_too_large, not the misleading generic 'try again'", async () => {
      const config = { maxUploadBytes: ONE_MIB };
      const uploadMock = stubFetch(vi.fn(), config);

      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId, config);

      const input = screen.getByLabelText("Choose an image file to upload");
      fireEvent.change(input, { target: { files: [pngFileOfSize(ONE_MIB * 1.5)] } });

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("That file is too large to upload.");
      });
      expect(uploadMock).not.toHaveBeenCalled();
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("");
    });

    it("config without maxUploadBytes: no pre-check, a large file is uploaded anyway", async () => {
      const uploadMock = stubFetch(
        vi.fn().mockResolvedValue(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u1", url: "/api/uploads/u1" }) })),
        {},
      );

      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId, {});

      fireEvent.change(screen.getByLabelText("Choose an image file to upload"), { target: { files: [pngFileOfSize(ONE_MIB * 1.5)] } });

      await waitFor(() => {
        expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("/api/uploads/u1");
      });
      expect(uploadMock).toHaveBeenCalledTimes(1);
    });

    it("limit changes without remount: after the config cache updates, the same panel's next file pick uses the new limit", async () => {
      let serverLimit = ONE_MIB; // the refetch on mount also reads the server's current value, so the cache isn't overwritten back to the old one
      const uploadMock = stubFetch(
        vi.fn().mockResolvedValue(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u1", url: "/api/uploads/u1" }) })),
        () => ({ maxUploadBytes: serverLimit }),
      );
      const blockId = insertBlock(editor, "image");
      const { queryClient } = renderPanel(editor, "note-1", blockId, { maxUploadBytes: ONE_MIB });
      const input = screen.getByLabelText("Choose an image file to upload");

      fireEvent.change(input, { target: { files: [pngFileOfSize(ONE_MIB * 1.5)] } });
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("That file is too large to upload."));
      expect(uploadMock).not.toHaveBeenCalled();

      serverLimit = ONE_MIB * 2;
      await act(async () => {
        queryClient.setQueryData(AUTH_CONFIG_QUERY_KEY, { maxUploadBytes: serverLimit });
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      fireEvent.change(input, { target: { files: [pngFileOfSize(ONE_MIB * 1.5)] } });
      await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    });

    it("upload failure (not ApiFail, e.g. a network-level exception): falls back to the generic text", async () => {
      stubFetch(vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

      const blockId = insertBlock(editor, "image");
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByLabelText("Choose an image file to upload");
      fireEvent.change(input, { target: { files: [pngFile()] } });

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("Couldn't upload the file. Please try again.");
      });
    });

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

  describe.each(["audio", "video", "file"])("%s block (Embed only, no Upload tab)", (type) => {
    it("no tab bar, no file input, straight to the URL input", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);

      expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Choose an image file to upload")).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText("Paste a link…")).toBeInTheDocument();
    });

    it("Embed: enter a URL and press Enter -> block writes back url/name", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "https://example.com/clip.mp4" } });
      fireEvent.keyDown(input, { key: "Enter" });

      const props = editor.getBlock(blockId)!.props as Record<string, unknown>;
      expect(props.url).toBe("https://example.com/clip.mp4");
      expect(props.name).toBe("clip.mp4");
    });

    it("Embed: clicking the button also submits (no need for Enter)", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "https://example.com/clip.mp4" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("https://example.com/clip.mp4");
    });

    it("blank URL: button disabled, Enter doesn't submit", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);

      expect(screen.getByRole("button", { name: "Embed" })).toBeDisabled();

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.keyDown(input, { key: "Enter" });

      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("");
    });

    // URL scheme allowlist for the Embed tab (security).
    it("javascript: pseudo URL -> rejected with an inline error, props.url not written", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid http:// or https:// link.");
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("");
    });

    it("no scheme (new URL fails to parse) -> rejected with an inline error, no scheme auto-prepended", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "example.com/a.png" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid http:// or https:// link.");
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("");
    });

    it("https:// -> accepted (no error)", () => {
      const blockId = insertBlock(editor, type);
      renderPanel(editor, "note-1", blockId);

      const input = screen.getByPlaceholderText("Paste a link…");
      fireEvent.change(input, { target: { value: "https://example.com/clip.mp4" } });
      fireEvent.click(screen.getByRole("button", { name: "Embed" }));

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect((editor.getBlock(blockId)!.props as Record<string, unknown>).url).toBe("https://example.com/clip.mp4");
    });

    it("http:// -> accepted (no error)", () => {
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
