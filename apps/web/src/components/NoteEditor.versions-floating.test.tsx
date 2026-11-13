import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import i18n from "@/i18n";
import { VersionsProvider, useVersions, useVersionsController } from "@/lib/versions-context";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { vid, vtarget } from "@/test/version-fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { ThemeProvider } from "@/theme";
import { NoteEditor } from "./NoteEditor";

// 讓面板 render 時拋錯，走錯誤外框（`VERSIONS_ERROR_FRAME.panel`）。
const crash = vi.hoisted(() => ({ on: false }));
vi.mock("@/components/versions/VersionsLazy", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/versions/VersionsLazy")>();
  return {
    ...original,
    VersionsPanel: (props: React.ComponentProps<typeof original.VersionsPanel>) => {
      if (crash.on) throw new Error("boom");
      return original.VersionsPanel(props);
    },
  };
});

const NOTE = "note-1";
const LIST_URL = `/api/notes/${NOTE}/versions?limit=50`;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") return Promise.resolve(json({ actions: [] }));
      if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(json([]));
      if (url === LIST_URL) {
        return Promise.resolve(
          json({
            versions: [{ id: vid(1), seq: 1, kind: "manual", name: null, editors: [], baseSeq: null, base: null, createdAt: "2026-10-09T01:00:00.000Z" }],
            current: { baseSeq: null, base: null, dirty: false, nextSeq: 2, autoEnabled: true },
            nextBefore: null,
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/** 探針：目前的版本狀態，加上開面板、進預覽、離開預覽的外部按鈕。 */
function Controls() {
  const v = useVersions();
  return (
    <div>
      <span data-testid="state">{JSON.stringify({ mode: v.mode, preview: v.preview?.seq ?? null })}</span>
      <button type="button" onClick={v.open}>host-open</button>
      <button type="button" onClick={() => v.startPreview(vtarget(1))}>host-preview</button>
      <button type="button" onClick={v.stopPreview}>host-stop-preview</button>
      <button type="button" onClick={() => v.openSave()}>host-save</button>
      <button type="button" data-testid="outside">outside</button>
    </div>
  );
}

function Host({ doc }: { doc: Y.Doc }) {
  const versions = useVersionsController({ noteId: NOTE, enabled: true });
  return (
    <VersionsProvider value={versions}>
      <Controls />
      <NoteEditor
        doc={doc}
        provider={{ awareness: null } as never}
        editable
        user={{ id: "u1", name: "Ann" }}
        noteId={NOTE}
        headerSlot={<div data-testid="header-marker">header</div>}
        previewSlot={versions.preview !== null ? <div data-testid="preview-marker">preview</div> : undefined}
      />
    </VersionsProvider>
  );
}

const state = () => JSON.parse(screen.getByTestId("state").textContent!) as { mode: string | null; preview: number | null };

async function renderAt(tier: LayoutTier) {
  const tierHandle = stubLayoutTier(tier);
  const doc = new Y.Doc();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Host doc={doc} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  const editor = await screen.findByTestId("note-editor");
  const row = editor.parentElement!.parentElement!.parentElement!.parentElement!;
  return { ...tierHandle, doc, row, ...utils };
}

async function openPanel() {
  fireEvent.click(screen.getByText("host-open"));
  return screen.findByTestId("versions-panel");
}

describe("NoteEditor 版本面板：浮動與固定", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    stubFetch();
    crash.on = false;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("列容器是定位基準；面板同時帶浮動（absolute、z-20、陰影、上緣讓出頁首）與固定（xl:relative）兩段 class", async () => {
    const { row, doc } = await renderAt("overlay");
    expect(row).toHaveClass("relative", "flex", "h-full", "gap-3");
    const panel = await openPanel();
    // 面板包在 `display: contents` 的 slot 裡（不產生盒子），定位基準仍是列容器。
    const slot = panel.parentElement!;
    expect(slot).toHaveAttribute("data-versions-panel-slot");
    expect(slot).toHaveClass("contents");
    expect(slot.parentElement).toBe(row);
    expect(panel).toHaveClass("absolute", "right-0", "bottom-0", "z-20", "shadow-lg", "top-[var(--note-header-h,0px)]");
    expect(panel).toHaveClass("xl:relative", "xl:inset-auto", "xl:shadow-none", "xl:w-[var(--versions-panel-width)]");
    expect(panel).toHaveClass("w-[min(var(--versions-panel-width),calc(100%_-_3rem))]");
    expect(panel).not.toHaveClass("fixed");
    doc.destroy();
  });

  it("--note-header-h：列容器量頁首外包層的高度（ResizeObserver 回報 57 -> 57px）", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly cb: (entries: unknown[], observer: unknown) => void) {}
        observe(target: Element) {
          if (target.hasAttribute("data-note-header-slot")) this.cb([{ target, contentRect: { height: 57 } }], this);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const { row, doc } = await renderAt("overlay");
    await waitFor(() => expect(row.style.getPropertyValue("--note-header-h")).toBe("57px"));
    expect(screen.getByTestId("header-marker").parentElement).toHaveAttribute("data-note-header-slot");
    doc.destroy();
  });

  it("跨 1280（浮動 <-> 固定）：面板留著，同一個 DOM 節點、狀態不變", async () => {
    const { setLayoutTier, doc } = await renderAt("overlay");
    const panel = await openPanel();
    expect(state().mode).toBe("panel");
    act(() => setLayoutTier("docked"));
    expect(state().mode).toBe("panel");
    expect(screen.getByTestId("versions-panel")).toBe(panel);
    act(() => setLayoutTier("overlay"));
    expect(state().mode).toBe("panel");
    expect(screen.getByTestId("versions-panel")).toBe(panel);
    doc.destroy();
  });

  it("預覽區：面板開著時右側讓出面板寬度（只在 xl 以下），面板關掉就不讓", async () => {
    const { doc } = await renderAt("overlay");
    await openPanel();
    fireEvent.click(screen.getByText("host-preview"));
    const slot = await screen.findByTestId("preview-slot");
    expect(slot).toHaveClass("max-xl:mr-[min(var(--versions-panel-width),calc(100%_-_3rem))]");
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
    // 關面板連預覽一起走；只剩面板關著的預覽（例如固定段以外的其他入口）不可能存在，這裡直接再開預覽驗證沒有面板時不讓。
    fireEvent.click(screen.getByText("host-preview"));
    expect(screen.queryByTestId("versions-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-slot")).not.toHaveClass("max-xl:mr-[min(var(--versions-panel-width),calc(100%_-_3rem))]");
    doc.destroy();
  });

  it("跨 640（浮動 -> 手機）：面板與預覽都關", async () => {
    const { setLayoutTier, doc } = await renderAt("overlay");
    await openPanel();
    fireEvent.click(screen.getByText("host-preview"));
    expect(state()).toEqual({ mode: "panel", preview: 1 });
    act(() => setLayoutTier("phone"));
    expect(state()).toEqual({ mode: null, preview: null });
    expect(screen.queryByTestId("versions-panel")).not.toBeInTheDocument();
    doc.destroy();
  });

  describe("點筆記區收起（只在浮動段、且只開清單時）", () => {
    it("只開清單（沒有預覽）：點筆記內文、頁首、面板外的按鈕 -> 面板關", async () => {
      const { doc } = await renderAt("overlay");
      await openPanel();
      fireEvent.pointerDown(await screen.findByTestId("note-editor"));
      expect(state().mode).toBeNull();
      expect(screen.queryByTestId("versions-panel")).not.toBeInTheDocument();
      await openPanel();
      fireEvent.pointerDown(screen.getByTestId("header-marker"));
      expect(state().mode).toBeNull();
      doc.destroy();
    });

    it("只開清單：點面板內 -> 不關", async () => {
      const { doc } = await renderAt("overlay");
      const panel = await openPanel();
      fireEvent.pointerDown(within(panel).getByRole("heading", { name: "Version history" }));
      fireEvent.pointerDown(panel);
      expect(state().mode).toBe("panel");
      expect(screen.getByTestId("versions-panel")).toBe(panel);
      doc.destroy();
    });

    it("差異檢視中（preview 非 null）：點筆記內文 -> 面板仍在；面板的 ✕ 才關", async () => {
      const { doc } = await renderAt("overlay");
      await openPanel();
      fireEvent.click(screen.getByText("host-preview"));
      fireEvent.pointerDown(await screen.findByTestId("note-editor"));
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state()).toEqual({ mode: "panel", preview: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
      expect(state()).toEqual({ mode: null, preview: null });
      doc.destroy();
    });

    it("從差異檢視回到清單（stopPreview）後再點筆記區 -> 關", async () => {
      const { doc } = await renderAt("overlay");
      await openPanel();
      fireEvent.click(screen.getByText("host-preview"));
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state().mode).toBe("panel");
      fireEvent.click(screen.getByText("host-stop-preview"));
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state().mode).toBeNull();
      doc.destroy();
    });

    it("面板載入失敗的錯誤外框：在「Try again」上按下不算外點，重試按得到", async () => {
      crash.on = true;
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { doc } = await renderAt("overlay");
      fireEvent.click(screen.getByText("host-open"));
      const retry = await screen.findByRole("button", { name: "Try again" });
      fireEvent.pointerDown(retry);
      expect(state().mode).toBe("panel");
      expect(screen.getByRole("button", { name: "Try again" })).toBe(retry);
      doc.destroy();
    });

    it("只開清單：在面板列 ⋯ 選單的項目上按下 -> 不關", async () => {
      const { doc } = await renderAt("overlay");
      const panel = await openPanel();
      const triggers = await within(panel).findAllByRole("button", { name: /more|actions|options/i });
      fireEvent.pointerDown(triggers[0], { button: 0, ctrlKey: false, pointerType: "mouse" });
      const item = within(await screen.findByRole("menu")).getAllByRole("menuitem")[0];
      fireEvent.pointerDown(item);
      expect(state().mode).toBe("panel");
      doc.destroy();
    });

    it.each([
      ["選單（role=menu）", { role: "menu" }],
      ["popper 浮層", { "data-radix-popper-content-wrapper": "" }],
      ["對話框（role=dialog）", { role: "dialog" }],
    ])("只開清單：在%s裡按下 -> 不關；移除之後在外面按下才關", async (_name, attrs) => {
      const { doc } = await renderAt("overlay");
      await openPanel();
      const portal = document.createElement("div");
      for (const [k, v] of Object.entries(attrs)) portal.setAttribute(k, v);
      const inner = document.createElement("button");
      portal.append(inner);
      document.body.append(portal);
      try {
        fireEvent.pointerDown(inner);
        expect(state().mode).toBe("panel");
      } finally {
        portal.remove();
      }
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state().mode).toBeNull();
      doc.destroy();
    });

    it("只開清單：版本對話框開著（狀態在、節點尚未掛上）時，在外面按下 -> 不關", async () => {
      const { doc } = await renderAt("overlay");
      await openPanel();
      fireEvent.click(screen.getByText("host-save"));
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state().mode).toBe("panel");
      doc.destroy();
    });

    it("只開清單：側欄抽屜開著時，點它的遮罩（在 role=dialog 之外）-> 面板留在原位；抽屜關掉後點外面才關", async () => {
      const { doc } = await renderAt("overlay");
      await openPanel();
      const drawer = document.createElement("div");
      drawer.setAttribute("role", "dialog");
      drawer.setAttribute("data-sidebar-drawer", "");
      const overlayEl = document.createElement("div");
      document.body.append(overlayEl, drawer);
      try {
        fireEvent.pointerDown(overlayEl);
        expect(state().mode).toBe("panel");
      } finally {
        overlayEl.remove();
        drawer.remove();
      }
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state().mode).toBeNull();
      doc.destroy();
    });

    it("固定段（>= 1280）：只開清單、差異檢視中，點筆記區都不關", async () => {
      const { doc } = await renderAt("docked");
      await openPanel();
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state().mode).toBe("panel");
      fireEvent.click(screen.getByText("host-preview"));
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state()).toEqual({ mode: "panel", preview: 1 });
      doc.destroy();
    });

    it("跨斷點跟著換：浮動只開清單時點外面會關，換到固定段之後同樣的點擊不關", async () => {
      const { setLayoutTier, doc } = await renderAt("overlay");
      await openPanel();
      act(() => setLayoutTier("docked"));
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state().mode).toBe("panel");
      doc.destroy();
    });
  });

  describe("面板內按 Esc", () => {
    it("浮動段：關面板（連預覽），焦點回到歷史泡泡", async () => {
      const { doc } = await renderAt("overlay");
      await openPanel();
      fireEvent.click(screen.getByText("host-preview"));
      const closeButton = screen.getByRole("button", { name: "Close version history" });
      closeButton.focus();
      fireEvent.keyDown(closeButton, { key: "Escape" });
      expect(state()).toEqual({ mode: null, preview: null });
      const bubble = await screen.findByTestId("versions-bubble");
      expect(document.activeElement).toBe(bubble);
      doc.destroy();
    });

    it("固定段：同一個動作面板不關", async () => {
      const { doc } = await renderAt("docked");
      await openPanel();
      const closeButton = screen.getByRole("button", { name: "Close version history" });
      closeButton.focus();
      fireEvent.keyDown(closeButton, { key: "Escape" });
      expect(state().mode).toBe("panel");
      doc.destroy();
    });

    it("浮動段：差異檢視中，焦點在列容器內、面板外（頁首）按 Esc -> 面板不關", async () => {
      const { doc } = await renderAt("overlay");
      await openPanel();
      fireEvent.click(screen.getByText("host-preview"));
      fireEvent.keyDown(screen.getByTestId("header-marker"), { key: "Escape" });
      expect(state()).toEqual({ mode: "panel", preview: 1 });
      doc.destroy();
    });

    it("浮動段：面板載入失敗的錯誤外框裡按 Esc -> 照常關", async () => {
      crash.on = true;
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { doc } = await renderAt("overlay");
      fireEvent.click(screen.getByText("host-open"));
      const retry = await screen.findByRole("button", { name: "Try again" });
      fireEvent.keyDown(retry, { key: "Escape" });
      expect(state().mode).toBeNull();
      doc.destroy();
    });
  });
});
