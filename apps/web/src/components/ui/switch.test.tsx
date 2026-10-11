import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Switch } from "./switch";

/** #247 §4.9（W25）：全站 switch 細版 26×14、滑塊 10、開啟位移 12；`tone="destructive"` 開啟態紅。 */
describe("Switch 尺寸與 tone（#247 §4.9）", () => {
  it("軌道 h-3.5 w-[26px]、不再帶舊的 h-4 w-7", () => {
    render(<Switch aria-label="s" />);
    const track = screen.getByRole("switch", { name: "s" });
    expect(track).toHaveClass("h-3.5", "w-[26px]");
    expect(track).not.toHaveClass("h-4");
    expect(track).not.toHaveClass("w-7");
  });

  it("滑塊 h-2.5 w-2.5、開啟位移 translate-x-3、關閉 translate-x-0.5", () => {
    render(<Switch aria-label="s" />);
    const thumb = screen.getByRole("switch", { name: "s" }).firstElementChild!;
    expect(thumb).toHaveClass("h-2.5", "w-2.5", "data-[state=checked]:translate-x-3", "data-[state=unchecked]:translate-x-0.5");
    expect(thumb).not.toHaveClass("data-[state=checked]:translate-x-3.5");
  });

  it('tone="destructive"：開啟態 bg-destructive，且 twMerge 蓋掉 bg-brand', () => {
    render(<Switch aria-label="s" tone="destructive" />);
    const track = screen.getByRole("switch", { name: "s" });
    expect(track).toHaveClass("data-[state=checked]:bg-destructive");
    expect(track).not.toHaveClass("data-[state=checked]:bg-brand");
  });

  it("預設 tone：開啟態 bg-brand、不帶 bg-destructive", () => {
    render(<Switch aria-label="s" />);
    const track = screen.getByRole("switch", { name: "s" });
    expect(track).toHaveClass("data-[state=checked]:bg-brand");
    expect(track).not.toHaveClass("data-[state=checked]:bg-destructive");
  });
});
