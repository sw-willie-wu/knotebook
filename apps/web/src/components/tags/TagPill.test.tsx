import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TagPill } from "./TagPill";
import { TagDot } from "./TagDot";

const tag = { id: "t1", name: "AWS", color: "blue" as const };

describe("TagPill", () => {
  it("shows the name with data-tag-color; a remove button labelled 'Remove tag <name>' only when onRemove is given", () => {
    const { container, rerender } = render(<TagPill tag={tag} />);
    expect(screen.getByText("AWS")).toBeTruthy();
    expect(container.querySelector('[data-tag-color="blue"]')).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();

    const onRemove = vi.fn();
    rerender(<TagPill tag={tag} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove tag AWS" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("disables the remove button when removeDisabled", () => {
    render(<TagPill tag={tag} onRemove={() => {}} removeDisabled />);
    expect((screen.getByRole("button", { name: "Remove tag AWS" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("TagPill size", () => {
  it("is 20px high with 8px side padding, fully rounded, 12px text, and shows the full name on hover", () => {
    const { container } = render(<TagPill tag={tag} />);
    const pill = container.querySelector('[data-tag-color="blue"]')!;
    for (const cls of ["h-5", "px-2", "rounded-full", "text-xs"]) expect(pill.classList.contains(cls), cls).toBe(true);
    expect(screen.getByText("AWS").getAttribute("title")).toBe("AWS");
  });

  it("widens the remove target to 24px on touch without changing its 16px look", () => {
    render(<TagPill tag={tag} onRemove={() => {}} />);
    const button = screen.getByRole("button", { name: "Remove tag AWS" });
    expect(button.classList.contains("size-4")).toBe(true);
    expect(button.className).toContain("pointer-coarse:after:-inset-1");
  });
});

describe("TagDot", () => {
  it("carries the color and is decorative", () => {
    const { container } = render(<TagDot color="red" />);
    const dot = container.firstElementChild!;
    expect(dot.getAttribute("data-tag-color")).toBe("red");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
  });
});
