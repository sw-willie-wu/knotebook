import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { EMPTY_YDOC_UPDATE_B64 } from "@knotebook/shared";
import i18n from "@/i18n";
import { BLOCKED_MEDIA_URL } from "@/lib/media-url";
import { ThemeProvider } from "@/theme";

const capturedOptions: { current: Record<string, unknown> | null } = { current: null };
const capturedViewProps: { current: Record<string, unknown> | null } = { current: null };
const mockYdocBytesToBlocks = vi.fn();

vi.mock("@blocknote/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@blocknote/react")>();
  return {
    ...actual,
    useCreateBlockNote: (options: Record<string, unknown>) => {
      capturedOptions.current = options;
      return { __mockEditor: true };
    },
  };
});

vi.mock("@blocknote/mantine", () => ({
  BlockNoteView: (props: Record<string, unknown>) => {
    capturedViewProps.current = props;
    return <div data-testid={String(props["data-testid"] ?? "bn-view")} data-editable={String(props.editable)} />;
  },
}));

vi.mock("@/lib/version-snapshot", () => ({
  ydocBytesToBlocks: (bytes: Uint8Array) => mockYdocBytesToBlocks(bytes),
}));

import { TrashPreviewEditor } from "./TrashPreviewEditor";
import { loadFilePreview } from "@/components/file-preview/file-preview-chunk";

function renderEditor(noteId: string, ydoc: string) {
  return render(
    <ThemeProvider>
      <TrashPreviewEditor noteId={noteId} ydoc={ydoc} />
    </ThemeProvider>,
  );
}

describe("TrashPreviewEditor", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    capturedOptions.current = null;
    capturedViewProps.current = null;
    mockYdocBytesToBlocks.mockReset();
  });

  it("renders read-only BlockNoteView without collab and rewrites upload URLs to the trash preview endpoint", async () => {
    const blocks = [{ type: "paragraph", content: [{ type: "text", text: "Hello from trash", styles: {} }], children: [] }];
    mockYdocBytesToBlocks.mockReturnValue(blocks);

    renderEditor("n-42", EMPTY_YDOC_UPDATE_B64);

    const view = screen.getByTestId("trash-preview-editor");
    expect(view).toHaveAttribute("data-editable", "false");
    expect(capturedViewProps.current?.editable).toBe(false);
    expect(capturedOptions.current?.collaboration).toBeUndefined();
    expect(capturedOptions.current?.initialContent).toBe(blocks);

    const resolveFileUrl = capturedOptions.current?.resolveFileUrl as (url: string) => Promise<string>;
    expect(await resolveFileUrl("/api/uploads/u-1")).toBe("/api/trash/n-42/uploads/u-1");
    expect(await resolveFileUrl("javascript:alert(1)")).toBe(BLOCKED_MEDIA_URL);
  });

  it("a file block's text name on the trash preview URL opens the file preview modal", async () => {
    await loadFilePreview();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("alpha,1", { status: 206, headers: { "content-type": "text/plain; charset=utf-8", "content-range": "bytes 0-6/7" } }))),
    );
    try {
      mockYdocBytesToBlocks.mockReturnValue([{ type: "file", props: { url: "/api/uploads/u-1", name: "data.csv" }, children: [] }]);
      renderEditor("n-42", EMPTY_YDOC_UPDATE_B64);
      // BlockNoteView is mocked: draw the name link the real file block renders, with the URL resolveFileUrl gives.
      const href = await (capturedOptions.current?.resolveFileUrl as (url: string) => Promise<string>)("/api/uploads/u-1");
      screen.getByTestId("trash-preview-editor").innerHTML =
        `<div class="bn-block-content" data-content-type="file"><div class="bn-file-name"><a href="${href}" target="_blank" rel="noopener">data.csv</a></div></div>`;
      const link = screen.getByRole("link", { name: "data.csv" });
      expect(link).toHaveAttribute("href", "/api/trash/n-42/uploads/u-1");
      expect(fireEvent.click(link, { button: 0 })).toBe(false);
      const dialog = await screen.findByRole("dialog", { name: "data.csv" });
      expect(await within(dialog).findByText("alpha,1")).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows empty notice when decoded blocks have no content (no BlockNote mounted)", () => {
    mockYdocBytesToBlocks.mockReturnValue([{ type: "paragraph", content: [], children: [] }]);

    renderEditor("n-42", EMPTY_YDOC_UPDATE_B64);

    expect(screen.getByText("This note has no content.", { exact: true })).toBeInTheDocument();
    expect(screen.queryByTestId("trash-preview-editor")).toBeNull();
  });

  it("shows alert when ydoc fails to decode without throwing", () => {
    mockYdocBytesToBlocks.mockImplementation(() => {
      throw new Error("corrupt");
    });

    renderEditor("n-42", "!!!not-base64!!!");

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't display this note's content.");
    expect(screen.queryByTestId("trash-preview-editor")).toBeNull();
  });
});
