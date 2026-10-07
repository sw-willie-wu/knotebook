import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ProviderIconDto } from "@knotebook/shared";
import { ProviderIcon } from "./ProviderIcon";

const URL_V1 = "/api/auth/providers/11111111-1111-4111-8111-111111111111/icon?v=1";
const URL_V2 = "/api/auth/providers/11111111-1111-4111-8111-111111111111/icon?v=2";

describe("ProviderIcon（spec §6.1、§8.2 W1）", () => {
  it("builtin 三名各渲染對應 SVG：data-provider-icon、aria-hidden、focusable=false、16px、沒有任何文字內容", () => {
    for (const name of ["gitlab", "google", "generic"] as const) {
      const { container, unmount } = render(<ProviderIcon icon={{ type: "builtin", name }} />);
      const svg = container.querySelector("svg");
      expect(svg, name).toHaveAttribute("data-provider-icon", name);
      expect(svg, name).toHaveAttribute("aria-hidden", "true");
      expect(svg, name).toHaveAttribute("focusable", "false");
      expect(svg, name).toHaveClass("h-4", "w-4", "shrink-0");
      expect(container.textContent, name).toBe("");
      expect(container.querySelector("title, text, desc"), name).toBeNull();
      unmount();
    }
  });

  it("三個內建圖示是不同的圖形；GitLab／Google 用官方配色、通用圖示用 currentColor", () => {
    const html = (name: "gitlab" | "google" | "generic") => render(<ProviderIcon icon={{ type: "builtin", name }} />).container.innerHTML;
    const [gitlab, google, generic] = [html("gitlab"), html("google"), html("generic")];
    expect(new Set([gitlab, google, generic]).size).toBe(3);
    expect(gitlab).toContain("#E24329");
    expect(google).toContain("#4285F4");
    expect(google).toContain("#34A853");
    expect(generic).toContain('stroke="currentColor"');
    expect(generic).not.toMatch(/fill="#/);
  });

  it("upload → <img alt=\"\" aria-hidden> src＝url、object-contain、不可拖曳", () => {
    const { container } = render(<ProviderIcon icon={{ type: "upload", url: URL_V1 }} className="mr-1" />);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("src", URL_V1);
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("aria-hidden", "true");
    expect(img).toHaveAttribute("data-provider-icon", "upload");
    expect(img).toHaveAttribute("draggable", "false");
    expect(img).toHaveClass("h-4", "w-4", "shrink-0", "object-contain", "mr-1");
  });

  it("upload 載入失敗 → 改為通用圖示（不留破圖）", () => {
    const { container } = render(<ProviderIcon icon={{ type: "upload", url: URL_V1 }} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toHaveAttribute("data-provider-icon", "generic");
  });

  it("RF4：失敗後 DTO 換成新網址（換圖、?v= 遞增）→ 重新顯示 <img>；回到已失敗的網址 → 仍是通用圖示", () => {
    const { container, rerender } = render(<ProviderIcon icon={{ type: "upload", url: URL_V1 }} />);
    fireEvent.error(container.querySelector("img")!);
    rerender(<ProviderIcon icon={{ type: "upload", url: URL_V2 }} />);
    expect(container.querySelector("img")).toHaveAttribute("src", URL_V2);
    rerender(<ProviderIcon icon={{ type: "upload", url: URL_V1 }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toHaveAttribute("data-provider-icon", "generic");
  });

  it("null（不顯示）與 undefined（少欄位的舊 fixture）都不渲染任何節點", () => {
    for (const icon of [null, undefined] as Array<ProviderIconDto | undefined>) {
      const { container, unmount } = render(<ProviderIcon icon={icon} />);
      expect(container.firstChild, String(icon)).toBeNull();
      unmount();
    }
  });

  it("放進按鈕不改可及名稱（四種形都一樣）", () => {
    const icons: ProviderIconDto[] = [{ type: "builtin", name: "gitlab" }, { type: "builtin", name: "google" }, { type: "builtin", name: "generic" }, { type: "upload", url: URL_V1 }];
    for (const icon of icons) {
      const { unmount } = render(
        <button type="button">
          <ProviderIcon icon={icon} />
          Sign in with X
        </button>,
      );
      expect(screen.getByRole("button", { name: "Sign in with X" })).toBeInTheDocument();
      unmount();
    }
  });
});
