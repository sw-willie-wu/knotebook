import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Pill } from "./Pill";

describe("Pill（#247：權限 pill，只列有的）", () => {
  it("預設 tone：中性外框、帶 data-pill", () => {
    render(<Pill>Read</Pill>);
    const pill = screen.getByText("Read");
    expect(pill).toHaveAttribute("data-pill");
    expect(pill).toHaveClass("border-border");
    expect(pill).not.toHaveClass("text-destructive");
  });

  it('tone="destructive"：淡紅底紅字（token 的「搬移」）', () => {
    render(<Pill tone="destructive">Move</Pill>);
    expect(screen.getByText("Move")).toHaveClass("bg-destructive/10", "text-destructive");
  });
});
