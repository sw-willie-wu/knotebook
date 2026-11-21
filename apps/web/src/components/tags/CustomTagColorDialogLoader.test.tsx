import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { CustomTagColorDialogLoader } from "./CustomTagColorDialogLoader";

const props = { tag: { id: "t1", name: "AWS", color: "blue" as const }, space: { kind: "personal" as const }, onOpenChange: () => {} };

beforeEach(async () => {
  await i18n.changeLanguage("en");
  dismissAllToasts();
});

afterEach(() => {
  vi.doUnmock("./CustomTagColorDialog");
});

describe("CustomTagColorDialogLoader", () => {
  it("shows the error toast when the chunk cannot be fetched, and a later open imports it again", async () => {
    vi.doMock("./CustomTagColorDialog", () => {
      throw new Error("Failed to fetch dynamically imported module");
    });
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <>
        <Toaster />
        <CustomTagColorDialogLoader {...props} open onOpenChange={onOpenChange} />
      </>,
    );
    expect(await screen.findByText("An unexpected error occurred.")).toBeTruthy();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    rerender(
      <>
        <Toaster />
        <CustomTagColorDialogLoader {...props} open={false} onOpenChange={onOpenChange} />
      </>,
    );
    await new Promise((r) => setTimeout(r, 50));
    vi.resetModules();
    vi.doMock("./CustomTagColorDialog", () => ({ default: () => <div role="dialog">Custom color</div> }));
    rerender(
      <>
        <Toaster />
        <CustomTagColorDialogLoader {...props} open onOpenChange={onOpenChange} />
      </>,
    );
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});
