import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { SidebarLazyBoundary } from "./SidebarLazyBoundary";

// 錯誤訊息照 Chromium 的裸動態 import 失敗措辭（ErrorBoundary.tsx 的 CHUNK_ERROR_PATTERNS）。
function Boom(): never {
  throw new TypeError("Failed to fetch dynamically imported module: http://localhost/assets/SelectLazy-abc.js");
}

const SELECT_FLAG = "knotebook:chunk-reload:select";
const TRASH_FLAG = "knotebook:chunk-reload:trash";
const FOLDER_FLAG = "knotebook:chunk-reload:folder";

describe("SidebarLazyBoundary", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    sessionStorage.clear();
    reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("LB1 chunk=\"select\" 第一次失敗：用 select 自己的額度重載一次，trash 的額度不動", async () => {
    render(
      <SidebarLazyBoundary chunk="select" fallback={null}>
        <Boom />
      </SidebarLazyBoundary>,
    );
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(SELECT_FLAG)).not.toBeNull();
    expect(sessionStorage.getItem(TRASH_FLAG)).toBeNull();
  });

  it("LB2 select 的額度已用過：不重載，原位顯示錯誤＋重試，errorClassName 套在外框", async () => {
    sessionStorage.setItem(SELECT_FLAG, "1");
    render(
      <SidebarLazyBoundary chunk="select" fallback={null} errorClassName="kb-test-frame">
        <Boom />
      </SidebarLazyBoundary>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("app.chunkLoadError"));
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(alert.parentElement?.className).toBe("kb-test-frame");
    expect(reload).not.toHaveBeenCalled();
  });

  it("LB4 chunk=\"folder\" 第一次失敗：用 folder 自己的額度重載一次，select／trash 的額度不動", async () => {
    render(
      <SidebarLazyBoundary chunk="folder" fallback={null}>
        <Boom />
      </SidebarLazyBoundary>,
    );
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(FOLDER_FLAG)).not.toBeNull();
    expect(sessionStorage.getItem(SELECT_FLAG)).toBeNull();
    expect(sessionStorage.getItem(TRASH_FLAG)).toBeNull();
  });

  it("LB3 chunk=\"select\" 載入成功：清掉 select 自己的額度，trash 的額度不動", async () => {
    sessionStorage.setItem(SELECT_FLAG, "1");
    sessionStorage.setItem(TRASH_FLAG, "1");
    render(
      <SidebarLazyBoundary chunk="select" fallback={null}>
        <p>ok</p>
      </SidebarLazyBoundary>,
    );
    expect(await screen.findByText("ok")).toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem(SELECT_FLAG)).toBeNull());
    expect(sessionStorage.getItem(TRASH_FLAG)).toBe("1");
  });
});
