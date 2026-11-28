import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("./FilePreviewDialog", () => {
  throw new Error("chunk failed to load");
});

const { FilePreviewLayer } = await import("./FilePreviewLayer");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the preview chunk fails to load", () => {
  it("the file opens in a new tab as it did before, and no modal or error appears on the page", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const container = document.createElement("div");
    container.innerHTML =
      '<div class="bn-block-content" data-content-type="file"><div class="bn-file-name"><a href="/api/uploads/u1" target="_blank" rel="noopener">data.csv</a></div></div>';
    document.body.append(container);
    render(<FilePreviewLayer container={container} />);
    fireEvent.click(container.querySelector("a")!, { button: 0 });
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("/api/uploads/u1", "_blank", "noopener"));
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.textContent).toBe("data.csv");
  });
});
