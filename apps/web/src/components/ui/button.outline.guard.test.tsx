import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "./button";

/**
 * #247 §4.8：outline hover／按下要填色（全站）。jsdom 不跑 CSS，這裡守的是 class token 沒被拿掉
 * （比照 switch.guard.test.tsx 的寫法）；真實顏色由 Part 3 的 e2e 截圖抽查。
 */
describe("Button outline 變體（#247 §4.8）", () => {
  it("hover 填 brand-deep 白字、無框；按下再深一階（color-mix 85% 黑）", () => {
    render(<Button variant="outline">x</Button>);
    const b = screen.getByRole("button", { name: "x" });
    expect(b).toHaveClass(
      "hover:bg-brand-deep",
      "hover:text-brand-fg",
      "hover:border-transparent",
      "active:[background:color-mix(in_oklch,var(--brand-deep)_85%,black)]",
    );
    expect(b).not.toHaveClass("hover:bg-accent");
  });

  it("ghost 的 hover 維持中性 bg-accent（列內三顆不閃）", () => {
    render(<Button variant="ghost">g</Button>);
    expect(screen.getByRole("button", { name: "g" })).toHaveClass("hover:bg-accent");
  });
});
