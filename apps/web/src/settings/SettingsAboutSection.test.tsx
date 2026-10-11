import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import pkg from "../../package.json";
import { SettingsAboutSection } from "./SettingsAboutSection";
import { DOCS_URL, LICENSE_URL, REPO_URL } from "./about-links";

describe("SettingsAboutSection（#247 §5.6）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("版本＝apps/web/package.json 的 version（經 vite define 注入的 __APP_VERSION__）", () => {
    render(<SettingsAboutSection />);
    expect(__APP_VERSION__).toBe(pkg.version);
    expect(screen.getByText(`v${pkg.version}`)).toBeInTheDocument();
  });

  it("三個連結都由 REPO_URL 組出、另開分頁", () => {
    render(<SettingsAboutSection />);
    expect(REPO_URL).toBe("https://github.com/sw-willie-wu/knotebook");
    expect(screen.getByRole("link", { name: "github.com/sw-willie-wu/knotebook" })).toHaveAttribute("href", REPO_URL);
    expect(screen.getByRole("link", { name: "docs/ folder" })).toHaveAttribute("href", DOCS_URL);
    expect(screen.getByRole("link", { name: "LICENSE" })).toHaveAttribute("href", LICENSE_URL);
    expect(DOCS_URL).toBe(`${REPO_URL}/tree/main/docs`);
    expect(LICENSE_URL).toBe(`${REPO_URL}/blob/main/LICENSE`);
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer");
    }
  });

  it("不打任何網路請求（沒有「檢查更新」）", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<SettingsAboutSection />);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});
