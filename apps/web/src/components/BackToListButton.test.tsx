import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { PhoneListContext } from "@/lib/phone-list";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { BackToListButton } from "./BackToListButton";

function renderButton(tier: LayoutTier, backToList = vi.fn()) {
  stubLayoutTier(tier);
  render(
    <PhoneListContext.Provider value={{ backToList }}>
      <BackToListButton />
    </PhoneListContext.Provider>,
  );
  return backToList;
}

describe("BackToListButton", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("手機：有「Back to notes」鈕，按下呼叫 backToList", () => {
    const backToList = renderButton("phone");
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    expect(backToList).toHaveBeenCalledTimes(1);
  });

  it("浮動段、固定段：不渲染", () => {
    renderButton("overlay");
    expect(screen.queryByRole("button", { name: "Back to notes" })).toBeNull();
  });

  it("固定段：不渲染", () => {
    renderButton("docked");
    expect(screen.queryByRole("button", { name: "Back to notes" })).toBeNull();
  });

  it("中文名稱", async () => {
    await i18n.changeLanguage("zh-TW");
    renderButton("phone");
    expect(screen.getByRole("button", { name: "返回筆記清單" })).toBeInTheDocument();
  });
});
