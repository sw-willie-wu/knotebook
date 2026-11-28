import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { stubLayoutTier } from "@/test/layout-tier";
import { putUpload, removeUpload, resetUploadQueueForTest } from "@/uploads/upload-queue-store";
import { UploadIndicator } from "./UploadIndicator";

// The list's chunk never arrives, so the panel stays open without anything in it to hold focus.
vi.mock("@/components/uploads/UploadsLazy", () => new Promise(() => {}));

beforeEach(async () => {
  await i18n.changeLanguage("en");
  stubLayoutTier("docked");
});

afterEach(() => {
  act(() => resetUploadQueueForTest());
  vi.unstubAllGlobals();
});

describe("UploadIndicator while its panel is still loading", () => {
  it("the queue emptying leaves focus where the person put it, not on the bell", async () => {
    putUpload({ id: "a", noteId: "n", blockId: "b", fileName: "clip.mp4", size: 100, loaded: 10, expectedUrl: "", status: "uploading" });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <div>
            <UploadIndicator placement="topBar" />
            <button type="button">bell</button>
          </div>
          <input aria-label="Note title" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const pill = document.querySelector<HTMLElement>("[data-upload-indicator]")!;
    fireEvent.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "true");
    const input = screen.getByRole("textbox", { name: "Note title" });
    input.focus();

    act(() => removeUpload("a"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.activeElement).toBe(input);
  });
});
