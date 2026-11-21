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

  it("widens the remove target to 24px on touch without changing its 14px look", () => {
    render(<TagPill tag={tag} onRemove={() => {}} />);
    const button = screen.getByRole("button", { name: "Remove tag AWS" });
    expect(button.classList.contains("size-3.5")).toBe(true);
    expect(button.className).toContain("pointer-coarse:after:-inset-[5px]");
  });
});

describe("TagPill remove badge and pointer", () => {
  it("keeps the padding symmetric and floats the remove button over the top-right corner", () => {
    const { container } = render(<TagPill tag={tag} onRemove={() => {}} />);
    const pill = container.querySelector('[data-tag-color="blue"]')!;
    expect(pill.classList.contains("relative")).toBe(true);
    expect(pill.classList.contains("px-2")).toBe(true);
    const button = screen.getByRole("button", { name: "Remove tag AWS" });
    for (const cls of ["absolute", "-right-1.5", "-top-0.5", "size-3.5", "cursor-pointer", "bg-popover", "border"]) expect(button.classList.contains(cls), cls).toBe(true);
    expect(button.className).not.toContain("-me-1");
  });

  it("shows a pointer on the menu button and none on a read-only name", () => {
    const { rerender } = render(<TagPill tag={tag} wrapLabel={(label) => label} />);
    expect(screen.getByText("AWS").closest("button")!.classList.contains("cursor-pointer")).toBe(true);
    rerender(<TagPill tag={tag} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("AWS").closest('[data-tag-color="blue"]')!.className).not.toContain("cursor-pointer");
  });

  it("removes without activating the menu button", () => {
    const onRemove = vi.fn();
    const onLabelClick = vi.fn();
    render(<TagPill tag={tag} onRemove={onRemove} wrapLabel={(label) => <span onClick={onLabelClick}>{label}</span>} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove tag AWS" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onLabelClick).not.toHaveBeenCalled();
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
