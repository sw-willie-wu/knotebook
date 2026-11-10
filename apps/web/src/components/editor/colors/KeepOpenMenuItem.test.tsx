import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useComponentsContext } from "@blocknote/react";
import { resetCustomColorsForTest } from "@/lib/custom-colors";
import { resetRecentColorsForTest } from "@/lib/recent-colors";
import { createTestEditor } from "@/test/ai-host";
import { menuNode, openHostMenu, renderColorMenuHost, settle } from "@/test/color-menu-host";
import { KeepOpenMenuItem } from "./KeepOpenMenuItem";

beforeEach(() => {
  localStorage.clear();
  resetRecentColorsForTest();
});
afterEach(() => {
  resetCustomColorsForTest();
});

function PlainItem({ onClick }: { onClick: () => void }) {
  const Components = useComponentsContext()!;
  return (
    <Components.Generic.Menu.Item data-test="plain" onClick={onClick}>
      plain
    </Components.Generic.Menu.Item>
  );
}

describe("KeepOpenMenuItem", () => {
  it("KO1 點了不關選單，onClick 收到帶 detail 的事件；一般項目點了選單會關", async () => {
    const editor = createTestEditor([{ id: "p1", type: "paragraph", content: "x" }]);
    const keep = vi.fn();
    const plain = vi.fn();
    renderColorMenuHost(
      editor,
      <>
        <KeepOpenMenuItem data-test="keep" onClick={keep}>
          keep
        </KeepOpenMenuItem>
        <PlainItem onClick={plain} />
      </>,
    );
    await openHostMenu();

    const item = screen.getByText("keep").closest("button")!;
    fireEvent.click(item);
    expect(screen.getByTestId("host-trigger")).toHaveAttribute("aria-expanded", "true");
    await settle();
    expect(menuNode()).not.toBeNull();
    expect(keep).toHaveBeenCalledTimes(1);
    expect(keep.mock.calls[0]![0]).toHaveProperty("detail");

    fireEvent.click(item, { detail: 0 });
    expect(keep).toHaveBeenCalledTimes(2);
    expect(keep.mock.calls[1]![0].detail).toBe(0);
    expect(screen.getByTestId("host-trigger")).toHaveAttribute("aria-expanded", "true");
    await settle();
    expect(menuNode()).not.toBeNull();

    fireEvent.click(screen.getByText("plain").closest("button")!);
    expect(plain).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("host-trigger")).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(menuNode()).toBeNull());
  });
});
