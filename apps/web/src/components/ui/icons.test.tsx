import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Columns2, History, ListFilter, Rows3, Users } from "./icons";

describe("icons", () => {
  it("Users 帶 data-icon=\"users\"（ShareDialog 測試靠它斷觸發鈕圖示）且吃 className", () => {
    const { container } = render(<Users className="h-4 w-4" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-icon", "users");
    expect(svg).toHaveClass("h-4", "w-4");
  });
  it("History 帶 data-icon=\"history\" 且吃 className", () => {
    const { container } = render(<History className="h-5 w-5" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-icon", "history");
    expect(svg).toHaveClass("h-5", "w-5");
  });
  it.each([
    ["columns-2", Columns2],
    ["rows-3", Rows3],
    ["list-filter", ListFilter],
  ] as const)("預覽橫幅模式鈕的圖示 %s：帶 data-icon、預設 aria-hidden、吃 className", (name, Icon) => {
    const { container } = render(<Icon className="h-4 w-4" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-icon", name);
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("h-4", "w-4");
  });
});
