import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { OutdatedClientBanner } from "./OutdatedClientBanner";

describe("#269 OutdatedClientBanner", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
  });
  it("role=alert、文案逐字（spec §5.2）、重新整理鈕呼叫 onReload", () => {
    const onReload = vi.fn();
    render(<OutdatedClientBanner onReload={onReload} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Knotebook 已更新，請重新整理頁面後繼續編輯。這個分頁尚未同步的變更在重新整理後不會保留。",
    );
    fireEvent.click(screen.getByRole("button", { name: "重新整理" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
