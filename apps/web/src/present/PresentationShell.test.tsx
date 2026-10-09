import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, type InitialEntry } from "react-router";
import i18n from "@/i18n";
import { installFakeFullscreen, type FakeFullscreen } from "@/test/fake-fullscreen";
import { enterPresentationFullscreen } from "./fullscreen";
import { isPresentingSearch } from "./present-url";
import { PresentationShell, usePresentationShell, type PresentationShellContextValue, type PresentationShellStatus } from "./PresentationShell";

// navigate 計次：包住真的 useNavigate（NotePage.test.tsx 的 navSpy 同手法）。
const nav = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("react-router", async (importOriginal) => {
  const mod = await importOriginal<typeof import("react-router")>();
  return {
    ...mod,
    useNavigate: () => {
      const real = mod.useNavigate();
      return ((...args: Parameters<typeof real>) => {
        nav.fn(...args);
        return real(...args);
      }) as typeof real;
    },
  };
});

const probe = vi.hoisted(() => ({ ctx: null as PresentationShellContextValue | null, alsoListen: false }));

/** 子樹替身：拿 context；`alsoListen` 時自己也聽 Esc（模擬 reveal 的 keyboard[27] 與外殼監聽同 tick 觸發）。 */
function Child() {
  const ctx = usePresentationShell();
  useEffect(() => {
    probe.ctx = ctx;
    if (!probe.alsoListen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") ctx.onEsc();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ctx]);
  return <div data-testid="shell-child" />;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{`${location.pathname}${location.search}${location.hash}|${JSON.stringify(location.state ?? null)}`}</div>;
}

function Page({ status, errorMessage, title }: { status: PresentationShellStatus; errorMessage?: string; title: string }) {
  const location = useLocation();
  if (!isPresentingSearch(location.search)) return <div>note page</div>;
  return (
    <PresentationShell title={title} status={status} errorMessage={errorMessage}>
      <Child />
    </PresentationShell>
  );
}

function renderShell(
  entries: InitialEntry[],
  { status = "ready", errorMessage, title = "My Note" }: { status?: PresentationShellStatus; errorMessage?: string; title?: string } = {},
) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <LocationProbe />
      <Routes>
        <Route path="/n/:handle/:slug" element={<Page status={status} errorMessage={errorMessage} title={title} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const loc = () => screen.getByTestId("loc").textContent;
const pressEsc = () => fireEvent.keyDown(document, { key: "Escape" });

describe("PresentationShell（spec §6.1、§6.3-4、§6.6、§6.7）", () => {
  let fake: FakeFullscreen | null = null;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    nav.fn.mockClear();
    probe.ctx = null;
    probe.alsoListen = false;
    window.history.replaceState(null, "", "/n/tester/my-note?present");
  });

  afterEach(async () => {
    await fake?.uninstall();
    fake = null;
    vi.useRealTimers();
  });

  it("未就緒時按 Esc、沒有旗標 → replace 掉 present 與 hash", async () => {
    renderShell(["/n/tester/my-note?present#/x"]);
    pressEsc();
    await waitFor(() => expect(loc()).toBe("/n/tester/my-note|null"));
    expect(nav.fn).toHaveBeenCalledTimes(1);
    expect(nav.fn).toHaveBeenCalledWith({ pathname: "/n/tester/my-note", search: "", hash: "" }, { replace: true });
  });

  it("有進入旗標 → navigate(-1)，回到進入前那筆", async () => {
    renderShell(["/n/tester/my-note", { pathname: "/n/tester/my-note", search: "?present", state: { knotebookPresentPushed: true } }]);
    pressEsc();
    await waitFor(() => expect(loc()).toBe("/n/tester/my-note|null"));
    expect(nav.fn).toHaveBeenCalledWith(-1);
  });

  it("同一 tick 外殼監聽與 reveal 的 keyboard[27] 都觸發 → navigate 恰一次（離開冪等）", async () => {
    probe.alsoListen = true;
    renderShell(["/n/tester/my-note?present"]);
    await waitFor(() => expect(probe.ctx).not.toBeNull());
    pressEsc();
    await waitFor(() => expect(loc()).toBe("/n/tester/my-note|null"));
    expect(nav.fn).toHaveBeenCalledTimes(1);
  });

  it("onRevealReady(true) 之後外殼不再聽 Esc；由 onEsc（reveal 的 keyboard[27]）離開，恰一次", async () => {
    renderShell(["/n/tester/my-note?present"]);
    await waitFor(() => expect(probe.ctx).not.toBeNull());
    act(() => probe.ctx!.onRevealReady(true));
    pressEsc();
    expect(nav.fn).not.toHaveBeenCalled();
    act(() => probe.ctx!.onEsc());
    await waitFor(() => expect(loc()).toBe("/n/tester/my-note|null"));
    expect(nav.fn).toHaveBeenCalledTimes(1);
  });

  it("× 連點兩下 → navigate 恰一次", async () => {
    renderShell(["/n/tester/my-note?present"]);
    const close = screen.getByRole("button", { name: "Exit presentation" });
    fireEvent.click(close);
    fireEvent.click(close);
    await waitFor(() => expect(loc()).toBe("/n/tester/my-note|null"));
    expect(nav.fn).toHaveBeenCalledTimes(1);
  });

  it("全螢幕中 Esc 不離開；退出後 300 ms 內忽略；超過才離開（§6.6-1）", async () => {
    fake = installFakeFullscreen();
    renderShell(["/n/tester/my-note?present"]);
    enterPresentationFullscreen();
    await fake.grantEventFirst();
    pressEsc();
    expect(nav.fn).not.toHaveBeenCalled();
    await fake.userExit(); // 瀏覽器吃掉第一下 Esc、退全螢幕
    fake.advance(299);
    pressEsc();
    expect(nav.fn).not.toHaveBeenCalled();
    fake.advance(2);
    pressEsc();
    await waitFor(() => expect(nav.fn).toHaveBeenCalledTimes(1));
  });

  it("全螢幕中按 ×：退出我們要的全螢幕並離開（exitFullscreen 早於 navigate）", async () => {
    fake = installFakeFullscreen();
    renderShell(["/n/tester/my-note?present"]);
    enterPresentationFullscreen();
    await fake.grantEventFirst();
    fireEvent.click(screen.getByRole("button", { name: "Exit presentation" }));
    expect(fake.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(nav.fn).toHaveBeenCalledTimes(1);
    expect(fake.exitFullscreen.mock.invocationCallOrder[0]).toBeLessThan(nav.fn.mock.invocationCallOrder[0]);
  });

  it("onFatal → 顯示 t(messageKey)、子樹卸載；之後按一次 Esc → navigate 恰一次", async () => {
    renderShell(["/n/tester/my-note?present"]);
    await waitFor(() => expect(probe.ctx).not.toBeNull());
    act(() => probe.ctx!.onFatal("present.configRefused"));
    expect(screen.getByRole("alert")).toHaveTextContent("Presentation settings were unexpected, so playback stopped");
    expect(screen.queryByTestId("shell-child")).toBeNull();
    pressEsc();
    await waitFor(() => expect(nav.fn).toHaveBeenCalledTimes(1));
  });

  it("status=loading → app.loading、沒有子樹、× 在；status=error → errorMessage、× 在", () => {
    const { unmount } = renderShell(["/n/tester/my-note?present"], { status: "loading" });
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByTestId("shell-child")).toBeNull();
    expect(screen.getByRole("button", { name: "Exit presentation" })).toBeInTheDocument();
    unmount();
    renderShell(["/n/tester/my-note?present"], { status: "error", errorMessage: "Boom" });
    expect(screen.getByRole("alert")).toHaveTextContent("Boom");
    expect(screen.getByRole("button", { name: "Exit presentation" })).toBeInTheDocument();
  });

  it("掛上後焦點在 dialog 根；可及名稱＝present.dialogLabel（空標題用 note.titlePlaceholder）", () => {
    const { unmount } = renderShell(["/n/tester/my-note?present"]);
    const dialog = screen.getByRole("dialog", { name: "My Note — presentation" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.activeElement).toBe(dialog);
    unmount();
    renderShell(["/n/tester/my-note?present"], { title: "  " });
    expect(screen.getByRole("dialog", { name: "Untitled — presentation" })).toBeInTheDocument();
  });

  it("正規化（§6.4-1、F14）：?present&hash=true#/x → ?present#/x，state 原樣保留", async () => {
    renderShell([{ pathname: "/n/tester/my-note", search: "?present&hash=true", hash: "#/x", state: { knotebookPresentPushed: true } }]);
    await waitFor(() => expect(loc()).toBe('/n/tester/my-note?present#/x|{"knotebookPresentPushed":true}'));
    expect(nav.fn).toHaveBeenCalledWith(
      { pathname: "/n/tester/my-note", search: "?present", hash: "#/x" },
      { replace: true, state: { knotebookPresentPushed: true } },
    );
  });

  it("全螢幕鈕：fullscreenEnabled 為 false 時不渲染", () => {
    fake = installFakeFullscreen({ enabled: false });
    renderShell(["/n/tester/my-note?present"]);
    expect(screen.queryByRole("button", { name: "Full screen" })).toBeNull();
  });

  it("全螢幕鈕：mousedown 不搶焦點、點擊後焦點回根；圖示／標籤隨全螢幕狀態換（§6.7）", async () => {
    fake = installFakeFullscreen();
    renderShell(["/n/tester/my-note?present"]);
    const button = screen.getByRole("button", { name: "Full screen" });
    expect(fireEvent.mouseDown(button)).toBe(false); // defaultPrevented
    button.focus(); // 鍵盤路徑：Tab 到按鈕再 Enter（jsdom 的 click 不移動焦點，先手動聚焦才量得到「還給根」，r1-p2 MINOR 6）
    fireEvent.click(button);
    expect(fake.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    await act(async () => fake!.grantEventFirst());
    fireEvent.click(screen.getByRole("button", { name: "Exit full screen" }));
    expect(fake.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("toggleFullscreen：fullscreenEnabled 為 false → 不請求（F 不作用）", async () => {
    fake = installFakeFullscreen({ enabled: false });
    renderShell(["/n/tester/my-note?present"]);
    await waitFor(() => expect(probe.ctx).not.toBeNull());
    act(() => probe.ctx!.toggleFullscreen());
    expect(fake.requestFullscreen).not.toHaveBeenCalled();
  });

  it("卸載型呼叫點：網址仍含 present 時卸載不退全螢幕；不含才退（§6.5）", async () => {
    fake = installFakeFullscreen();
    const first = renderShell(["/n/tester/my-note?present"]);
    enterPresentationFullscreen();
    await fake.grantEventFirst();
    first.unmount(); // window.location 仍是 ?present（beforeEach）
    expect(fake.exitFullscreen).not.toHaveBeenCalled();
    renderShell(["/n/tester/my-note?present"]).unmount();
    expect(fake.exitFullscreen).not.toHaveBeenCalled();
    window.history.replaceState(null, "", "/n/tester/my-note");
    renderShell(["/n/tester/my-note?present"]).unmount();
    expect(fake.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("工具列閒置 2 s 淡出、滑鼠移動浮現（§6.7）", () => {
    vi.useFakeTimers();
    renderShell(["/n/tester/my-note?present"]);
    const toolbar = screen.getByRole("button", { name: "Exit presentation" }).parentElement!;
    // classList 比對（className 恆含 hover:opacity-100／focus-within:opacity-100，toContain 是空斷言，r1-p2 MINOR 5）
    expect(toolbar.classList.contains("opacity-100")).toBe(true);
    act(() => vi.advanceTimersByTime(2000));
    expect(toolbar.classList.contains("opacity-0")).toBe(true);
    fireEvent.mouseMove(screen.getByRole("dialog"));
    expect(toolbar.classList.contains("opacity-100")).toBe(true);
    expect(toolbar.classList.contains("opacity-0")).toBe(false);
  });
});
