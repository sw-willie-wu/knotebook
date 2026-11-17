import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import type { ZoomSource } from "./context";
import { LightboxFallback } from "./LightboxFallback";

const SOURCE: ZoomSource = { kind: "image", src: "/uploads/bob.png", alt: "bob.png", caption: "", naturalWidth: 400, naturalHeight: 200 };

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

describe("LightboxFallback", () => {
  it("一渲染就有對話框、依原尺寸比例的灰塊與關閉鈕，焦點在關閉鈕", () => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1024);
    const { container } = render(<LightboxFallback source={SOURCE} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "bob.png" })).toBeInTheDocument();
    // 掛在 body 下（portal），不在 render 的容器裡；比例與「符合視窗」算法一致（jsdom 視窗 1024×768：400×200 不放大）。
    expect(container.querySelector("[data-zoom-fallback]")).toBeNull();
    const skeleton = document.body.querySelector<HTMLElement>("[data-zoom-skeleton]")!;
    expect(skeleton.style.aspectRatio).toBe("400 / 200");
    expect(skeleton.style.width).toBe("400px");
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("沒有原尺寸時退回中性方塊", () => {
    render(<LightboxFallback source={{ ...SOURCE, naturalWidth: 0, naturalHeight: 0 }} onClose={() => {}} />);
    expect(document.body.querySelector<HTMLElement>("[data-zoom-skeleton]")!.style.aspectRatio).toBe("");
  });

  it("Esc、關閉鈕、點背景都關", () => {
    const onClose = vi.fn();
    render(<LightboxFallback source={SOURCE} onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("Tab 不離開關閉鈕", () => {
    render(<LightboxFallback source={SOURCE} onClose={() => {}} />);
    const close = screen.getByRole("button", { name: "Close" });
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
  });
});
