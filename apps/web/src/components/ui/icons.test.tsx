import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Users } from "./icons";

describe("icons", () => {
  it("Users 帶 data-icon=\"users\"（ShareDialog 測試靠它斷觸發鈕圖示）且吃 className", () => {
    const { container } = render(<Users className="h-4 w-4" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-icon", "users");
    expect(svg).toHaveClass("h-4", "w-4");
  });
});
