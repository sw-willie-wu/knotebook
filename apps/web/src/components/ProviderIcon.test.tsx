import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProviderIconDto } from "@knotebook/shared";
import { ProviderIcon } from "./ProviderIcon";

// GitLab／Google 是 lazy 載入：等 svg 出現（資料落地）才斷言內容。
const svgOf = (c: HTMLElement) => waitFor(() => { const e = c.querySelector("svg"); expect(e).not.toBeNull(); return e!; });

const URL_V1 = "/api/auth/providers/11111111-1111-4111-8111-111111111111/icon?v=1";
const URL_V2 = "/api/auth/providers/11111111-1111-4111-8111-111111111111/icon?v=2";

describe("ProviderIcon（spec §6.1、§8.2 W1）", () => {
  // ⚠ 必須是本檔第一個渲染 gitlab 的案：React.lazy 解析後會快取，之後的 render 不再經過 fallback。
  it("lazy 載入中：同尺寸 aria-hidden 空白佔位、按鈕可及名稱不變；載入完成後換成真圖示", async () => {
    const { container } = render(
      <button type="button">
        <ProviderIcon icon={{ type: "builtin", name: "gitlab" }} />
        Sign in with X
      </button>,
    );
    // render 同步回來時 lazy chunk 尚未解析：此刻必是佔位。
    const ph = container.querySelector("[data-provider-icon-loading]")!;
    expect(ph).toHaveAttribute("aria-hidden", "true");
    expect(ph).toHaveClass("h-4", "w-4", "shrink-0");
    expect(ph.textContent).toBe("");
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in with X" })).toBeInTheDocument();
    await svgOf(container);
    expect(container.querySelector("[data-provider-icon-loading]")).toBeNull();
    expect(container.querySelector("svg")).toHaveAttribute("data-provider-icon", "gitlab");
    expect(screen.getByRole("button", { name: "Sign in with X" })).toBeInTheDocument();
  });

  it("builtin 三名各渲染對應 SVG：data-provider-icon、aria-hidden、focusable=false、16px、沒有任何文字內容", async () => {
    for (const name of ["gitlab", "google", "generic"] as const) {
      const { container, unmount } = render(<ProviderIcon icon={{ type: "builtin", name }} />);
      const svg = await svgOf(container);
      expect(svg, name).toHaveAttribute("data-provider-icon", name);
      expect(svg, name).toHaveAttribute("aria-hidden", "true");
      expect(svg, name).toHaveAttribute("focusable", "false");
      expect(svg, name).toHaveClass("h-4", "w-4", "shrink-0");
      expect(container.textContent, name).toBe("");
      expect(container.querySelector("title, text, desc"), name).toBeNull();
      unmount();
    }
  });

  it("三個內建圖示是不同的圖形；GitLab 三色全在、Google 漸層官方色在、通用圖示用 currentColor", async () => {
    const html = async (name: "gitlab" | "google" | "generic") => {
      const { container } = render(<ProviderIcon icon={{ type: "builtin", name }} />);
      await svgOf(container);
      return container.innerHTML;
    };
    const gitlab = await html("gitlab");
    const google = await html("google");
    const generic = await html("generic");
    expect(new Set([gitlab, google, generic]).size).toBe(3);
    for (const c of ["#E24329", "#FC6D26", "#FCA326"]) expect(gitlab, c).toContain(c);
    for (const c of ["#3186FF", "#FF4641", "#FF5B8B"]) expect(google, c).toContain(c);
    expect(generic).toContain('stroke="currentColor"');
    expect(generic).not.toMatch(/fill="#/);
  });

  it("Google 圖示沒有按鈕外框／底板（官方包的方框與 #747775 外框線已刪）", async () => {
    const { container } = render(<ProviderIcon icon={{ type: "builtin", name: "google" }} />);
    await svgOf(container);
    expect(container.querySelector("rect")).toBeNull();
    expect(container.innerHTML).not.toContain("#747775");
    expect(container.innerHTML).not.toMatch(/fill="white"/);
    expect(container.querySelector("svg")).toHaveAttribute("viewBox", "10 10 20 20");
  });

  it("同一頁兩個 Google 圖示：id 不重複，且各自的 url(#…) 都指向自己 svg 內的 id", async () => {
    const { container } = render(
      <div>
        <ProviderIcon icon={{ type: "builtin", name: "google" }} />
        <ProviderIcon icon={{ type: "builtin", name: "google" }} />
      </div>,
    );
    await waitFor(() => expect(container.querySelectorAll("svg")).toHaveLength(2));
    const svgs = Array.from(container.querySelectorAll("svg"));
    const ids = svgs.map((svg) => Array.from(svg.querySelectorAll("[id]")).map((e) => e.id));
    expect(ids[0]!.length).toBeGreaterThanOrEqual(9);
    expect(new Set([...ids[0]!, ...ids[1]!]).size).toBe(ids[0]!.length + ids[1]!.length);
    svgs.forEach((svg, i) => {
      const refs = Array.from(svg.innerHTML.matchAll(/url\(#([^)]+)\)/g)).map((m) => m[1]!);
      expect(refs.length).toBeGreaterThanOrEqual(9);
      for (const r of refs) expect(ids[i], r).toContain(r);
    });
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
