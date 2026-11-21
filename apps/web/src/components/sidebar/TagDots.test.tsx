import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { NoteTagDto } from "@knotebook/shared";
import { TagDots } from "./TagDots";

const tags: NoteTagDto[] = [
  { id: "a", name: "Alpha", color: "blue" },
  { id: "b", name: "Beta", color: "red" },
  { id: "c", name: "Gamma", color: "green" },
  { id: "d", name: "Delta", color: "purple" },
  { id: "e", name: "Epsilon", color: "#12ab34" },
];

describe("TagDots", () => {
  it("renders nothing without tags", () => {
    const { container } = render(<TagDots tags={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("draws at most three dots, in tag order, with no count", () => {
    const { container } = render(<TagDots tags={tags} />);
    const colors = Array.from(container.querySelectorAll("[data-tag-color]")).map((el) => el.getAttribute("data-tag-color"));
    expect(colors).toEqual(["blue", "red", "green"]);
    expect(container.textContent).toBe("");
  });

  it("exposes every name, also past the third, as the accessible name and the hover title", () => {
    render(<TagDots tags={tags} />);
    const dots = screen.getByRole("img", { name: "Tags: Alpha, Beta, Gamma, Delta, Epsilon" });
    expect(dots).toHaveAttribute("title", "Tags: Alpha, Beta, Gamma, Delta, Epsilon");
  });

  it("keeps the custom color as the dot variable and cuts every dot but the last", () => {
    const { container } = render(<TagDots tags={[tags[0]!, tags[4]!]} />);
    const dots = Array.from(container.querySelectorAll<HTMLElement>("[data-tag-color]"));
    expect(dots[1]!.style.getPropertyValue("--tag-dot")).toBe("#12ab34");
    expect(dots[0]!.className).toContain("mask-image");
    expect(dots[1]!.className).not.toContain("mask-image");
  });
});
