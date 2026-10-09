import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { VersionsLazyBoundary } from "./VersionsLazyBoundary";

function Boom(): never {
  throw new TypeError("Failed to fetch dynamically imported module: /assets/VersionsLazy-abc.js");
}

describe("VersionsLazyBoundary（起草裁定 23）", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("chunk 載入失敗：用 versions 自己的額度 reload 一次，NotePage 的額度旗標不動", async () => {
    await i18n.changeLanguage("en");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    render(
      <VersionsLazyBoundary noteId="n1" reload={reload}>
        <Boom />
      </VersionsLazyBoundary>,
    );
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem("knotebook:chunk-reload:versions")).not.toBeNull();
    expect(sessionStorage.getItem("knotebook:chunk-reload:notepage")).toBeNull();
  });

  it("同一個 session 第二次失敗：不再 reload，就地顯示 inline 錯誤（不包 AppShell）", async () => {
    await i18n.changeLanguage("en");
    vi.spyOn(console, "error").mockImplementation(() => {});
    sessionStorage.setItem("knotebook:chunk-reload:versions", "1");
    const reload = vi.fn();
    const { container } = render(
      <VersionsLazyBoundary noteId="n1" reload={reload}>
        <Boom />
      </VersionsLazyBoundary>,
    );
    await waitFor(() => expect(container.textContent?.length ?? 0).toBeGreaterThan(0));
    expect(reload).not.toHaveBeenCalled();
    expect(container.querySelector("main")).toBeNull();
  });

  it("M-5（gate r2）：非 chunk 的 render 錯誤 → 顯示版本歷史自己的文案（不是 app.noteCrash 的「筆記崩潰」），且錯誤畫面包在呼叫端給的外框 class 裡；正常態沒有那層外框", async () => {
    await i18n.changeLanguage("en");
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Crash(): never {
      throw new Error("render bug");
    }
    const { container, unmount } = render(
      <VersionsLazyBoundary noteId="n1" reload={vi.fn()} errorClassName="kb-test-frame">
        <Crash />
      </VersionsLazyBoundary>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Version history couldn't be shown.");
    expect(alert).not.toHaveTextContent(i18n.t("app.noteCrash"));
    expect(alert.closest(".kb-test-frame")).not.toBeNull();
    unmount();
    const ok = render(
      <VersionsLazyBoundary noteId="n1" errorClassName="kb-test-frame">
        <span>fine</span>
      </VersionsLazyBoundary>,
    );
    expect(await ok.findByText("fine")).toBeInTheDocument();
    expect(ok.container.querySelector(".kb-test-frame")).toBeNull();
    expect(container).toBeDefined();
  });

  it("成功載入：Suspense 內的 beacon 清掉 versions 的旗標", async () => {
    sessionStorage.setItem("knotebook:chunk-reload:versions", "1");
    render(
      <VersionsLazyBoundary noteId="n1">
        <span>ok</span>
      </VersionsLazyBoundary>,
    );
    expect(await screen.findByText("ok")).toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem("knotebook:chunk-reload:versions")).toBeNull());
  });
});
