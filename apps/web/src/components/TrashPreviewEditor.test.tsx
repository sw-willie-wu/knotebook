import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
