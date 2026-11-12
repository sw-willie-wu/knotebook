import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { AGENT_PRESENCE_COLOR, avatarUrl } from "@knotebook/shared";
import { Avatar } from "./Avatar";

// #293：頭像三形（首字、圖與失敗退首字、AI）與外框。

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function root(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

describe("Avatar", () => {
  it("首字：aria-hidden、大寫首字、bg-muted／text-foreground、inline 尺寸", () => {
    const { container } = render(<Avatar name="ann" avatar={null} size={28} />);
    const el = root(container);
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(el).toHaveTextContent(/^A$/);
    expect(el).toHaveClass("bg-muted", "text-foreground");
    expect(el.style.width).toBe("28px");
    expect(el.style.height).toBe("28px");
  });

  it("圖：src 只經 avatarUrl；載入失敗退首字；換版本後重試", () => {
    const { container, rerender } = render(<Avatar name="ann" avatar={{ id: ID, v: 2 }} size={28} />);
    const img = container.querySelector("img")!;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe(avatarUrl(ID, 2));
    expect(img.getAttribute("alt")).toBe("");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(root(container)).toHaveTextContent(/^A$/);
    rerender(<Avatar name="ann" avatar={{ id: ID, v: 3 }} size={28} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(avatarUrl(ID, 3));
  });

  it("AI：Sparkles 圖示、沒有首字", () => {
    const { container } = render(<Avatar name="w" avatar={null} size={28} kind="agent" />);
    const el = root(container);
    expect(el.querySelector('svg[data-icon="sparkles"]')).not.toBeNull();
    expect(el.textContent).toBe("");
  });

  it("AI 圖示色：淺色＝AGENT_PRESENCE_COLOR、深色改用較亮的紫（class，不用 inline 色）", () => {
    const { container } = render(<Avatar name="w" avatar={null} size={28} kind="agent" />);
    const icon = root(container).querySelector<SVGElement>('svg[data-icon="sparkles"]')!;
    expect(icon).toHaveClass(`text-[${AGENT_PRESENCE_COLOR}]`, "dark:text-[#a78bfa]");
    // inline color 會蓋過 dark: class
    expect(icon.style.color).toBe("");
  });

  it("外框：ringColor 與 card 底色兩圈；offsetColor 換底色；不給 ringColor 就沒有 boxShadow", () => {
    const { container, rerender } = render(<Avatar name="ann" avatar={null} size={28} ringColor="hsl(10 65% 45%)" />);
    const shadow = root(container).style.boxShadow;
    expect(shadow).toContain("hsl(10 65% 45%)");
    expect(shadow).toContain("var(--color-card)");
    rerender(<Avatar name="ann" avatar={null} size={28} ringColor="hsl(10 65% 45%)" offsetColor="var(--color-popover)" />);
    expect(root(container).style.boxShadow).toContain("var(--color-popover)");
    expect(root(container).style.boxShadow).not.toContain("var(--color-card)");
    rerender(<Avatar name="ann" avatar={null} size={28} />);
    expect(root(container).style.boxShadow).toBe("");
  });

  it("名字以不可見字元開頭：首字取第一個看得見的字素", () => {
    const { container } = render(<Avatar name={`${String.fromCharCode(0x202e)}ann`} avatar={null} size={28} />);
    expect(root(container).textContent).toBe("A");
  });
});
