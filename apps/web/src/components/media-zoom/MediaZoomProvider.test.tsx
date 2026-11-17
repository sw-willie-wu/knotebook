import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { useMediaZoom, type MediaZoomApi, type ZoomOrigin, type ZoomSource } from "./context";
import { MediaZoomProvider } from "./MediaZoomProvider";
import { loadMediaLightbox } from "./lightbox-chunk";

const SOURCE: ZoomSource = {
  kind: "image",
  src: "/uploads/bob.png",
  alt: "bob.png",
  caption: "",
  naturalWidth: 400,
  naturalHeight: 300,
};

let api: MediaZoomApi | null | undefined;

function Probe() {
  api = useMediaZoom();
  return <span data-testid="state">{api === null ? "none" : String(api.isOpen)}</span>;
}

/** 頁面上（React 之外）的放大鈕與圖，讓測試可以任意把它們拿掉。 */
function pageElements({ focusableWrap = true }: { focusableWrap?: boolean } = {}) {
  const wrap = document.createElement("div");
  if (focusableWrap) wrap.tabIndex = 0;
  const media = document.createElement("img");
  wrap.append(media);
  const button = document.createElement("button");
  button.textContent = "zoom";
  document.body.append(wrap, button);
  return { wrap, media, button };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  api = undefined;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

async function openWith(origin: ZoomOrigin) {
  render(
    <MediaZoomProvider>
      <Probe />
    </MediaZoomProvider>,
  );
  if (origin.button) origin.button.focus();
  act(() => api!.open(SOURCE, origin));
  const dialog = await screen.findByRole("dialog");
  return dialog;
}

describe("MediaZoomProvider", () => {
  it("Provider 外 useMediaZoom() 回 null", () => {
    render(<Probe />);
    expect(api).toBeNull();
    expect(screen.getByTestId("state")).toHaveTextContent("none");
  });

  it("open() 後放大畫面出現（lazy 載得到），isOpen 為 true", async () => {
    const { media, button } = pageElements();
    await openWith({ button, media });
    expect(screen.getByRole("dialog", { name: "bob.png" })).toBeInTheDocument();
    expect(api!.isOpen).toBe(true);
    expect(screen.getByTestId("state")).toHaveTextContent("true");
  });

  it("chunk 已載好（例如預取過）：打開當下直接渲染放大畫面，不經外殼", async () => {
    const { media, button } = pageElements();
    await loadMediaLightbox();
    render(
      <MediaZoomProvider>
        <Probe />
      </MediaZoomProvider>,
    );
    act(() => api!.open(SOURCE, { button, media }));
    expect(screen.getByRole("dialog", { name: "bob.png" })).toBeInTheDocument();
    expect(document.querySelector("[data-zoom-fallback]")).toBeNull();
  });

  it("Esc 關閉：放大畫面消失、isOpen 為 false、焦點回放大鈕", async () => {
    const { media, button } = pageElements();
    const dialog = await openWith({ button, media });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api!.isOpen).toBe(false);
    expect(screen.getByTestId("state")).toHaveTextContent("false");
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("放大鈕已不在頁面上：焦點回圖最近的可聚焦祖先", async () => {
    const { wrap, media, button } = pageElements();
    const dialog = await openWith({ button, media });
    button.remove();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(wrap));
  });

  it("沒有放大鈕、圖也沒有可聚焦祖先：關閉不丟例外，焦點落在 body", async () => {
    const { media } = pageElements({ focusableWrap: false });
    const dialog = await openWith({ button: null, media });
    expect(() => fireEvent.keyDown(dialog, { key: "Escape" })).not.toThrow();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(document.body));
  });
});
