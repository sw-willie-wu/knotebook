import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { VersionDto } from "@knotebook/shared";
import { NARROW_QUERY, VersionsProvider, isOverlayOpen, useVersions, useVersionsController } from "./versions-context";

/** 可控的 matchMedia（jsdom 預設 stub 的 addEventListener 是 no-op——[[knotebook-ui-chrome]]）。 */
function installMatchMedia(initialNarrow: boolean) {
  let narrow = initialNarrow;
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === NARROW_QUERY ? narrow : false;
    },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      narrow = next;
      act(() => listeners.forEach((fn) => fn({ matches: next })));
    },
    restore() {
      window.matchMedia = original;
    },
  };
}

const V: VersionDto = { id: "v-1", seq: 1, kind: "manual", name: null, editors: [], baseSeq: null, createdAt: "2026-10-09T00:00:00.000Z" };

describe("versions-context", () => {
  let mm: ReturnType<typeof installMatchMedia>;
  beforeEach(() => {
    mm = installMatchMedia(false);
  });
  afterEach(() => mm.restore());

  it("沒有 provider → no-op 預設：enabled=false、所有動作不 throw", () => {
    const { result } = renderHook(() => useVersions());
    expect(result.current.enabled).toBe(false);
    expect(result.current.panelOpen).toBe(false);
    expect(() => {
      result.current.open();
      result.current.openSave();
      result.current.startPreview({ seq: 1, id: "x" });
    }).not.toThrow();
    expect(result.current.preview).toBeNull();
  });

  it("寬視窗 open() → mode=panel、panelOpen=true；窄視窗 → mode=sheet、panelOpen=false", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => result.current.open());
    expect(result.current.mode).toBe("panel");
    expect(result.current.panelOpen).toBe(true);
    act(() => result.current.close());
    mm.set(true);
    act(() => result.current.open());
    expect(result.current.mode).toBe("sheet");
    expect(result.current.panelOpen).toBe(false);
  });

  it("enabled=false → open／openSave／startPreview 都不生效", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: false }));
    act(() => {
      result.current.open();
      result.current.openSave();
      result.current.startPreview({ seq: 1, id: "x" });
    });
    expect(result.current.mode).toBeNull();
    expect(result.current.dialog).toBeNull();
    expect(result.current.preview).toBeNull();
  });

  it("previewSeq 由 preview 衍生；close() 不離開預覽（spec §8.1：預覽由橫幅 ✕ 關）", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => {
      result.current.open();
      result.current.startPreview({ seq: 3, id: "v-3" });
    });
    expect(result.current.previewSeq).toBe(3);
    act(() => result.current.close());
    expect(result.current.preview).toEqual({ seq: 3, id: "v-3" });
    act(() => result.current.stopPreview());
    expect(result.current.previewSeq).toBeNull();
  });

  it("openSave(then) → dialog={kind:'save', then}；closeDialog 清掉", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => result.current.openSave(V));
    expect(result.current.dialog).toEqual({ kind: "save", then: V });
    act(() => result.current.closeDialog());
    expect(result.current.dialog).toBeNull();
  });

  it("RF4：開著跨斷點（寬→窄）→ 整個關掉，預覽一併離開", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => {
      result.current.open();
      result.current.startPreview({ seq: 2, id: "v-2" });
    });
    mm.set(true);
    expect(result.current.mode).toBeNull();
    expect(result.current.preview).toBeNull();
  });

  it("RF4：窄→寬同樣關掉整頁", () => {
    mm.set(true);
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => result.current.open());
    expect(result.current.mode).toBe("sheet");
    mm.set(false);
    expect(result.current.mode).toBeNull();
  });

  it("換筆記（noteId 變）→ 狀態全部歸零", () => {
    const { result, rerender } = renderHook(({ id }: { id: string }) => useVersionsController({ noteId: id, enabled: true }), { initialProps: { id: "n1" } });
    act(() => {
      result.current.open();
      result.current.startPreview({ seq: 2, id: "v-2" });
      result.current.openSave();
    });
    rerender({ id: "n2" });
    expect(result.current.mode).toBeNull();
    expect(result.current.preview).toBeNull();
    expect(result.current.dialog).toBeNull();
  });

  it("enabled 翻 false（降級／終態）→ 面板、預覽、對話框都清掉；再翻回 true 也不會重現", () => {
    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useVersionsController({ noteId: "n1", enabled }), {
      initialProps: { enabled: true },
    });
    act(() => {
      result.current.open();
      result.current.startPreview({ seq: 2, id: "v-2" });
      result.current.openSave();
    });
    expect(result.current.mode).toBe("panel");
    expect(result.current.preview).toEqual({ seq: 2, id: "v-2" });
    expect(result.current.dialog).toEqual({ kind: "save" });
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(result.current.mode).toBeNull();
    expect(result.current.panelOpen).toBe(false);
    expect(result.current.preview).toBeNull();
    expect(result.current.dialog).toBeNull();
  });

  it("換筆記 → splitMode／compareRight／onlyChanges 重設為預設", () => {
    const { result, rerender } = renderHook(({ id }: { id: string }) => useVersionsController({ noteId: id, enabled: true }), { initialProps: { id: "n1" } });
    act(() => {
      result.current.setSplitMode("split");
      result.current.setCompareRight({ seq: 1, id: "v-1" });
      result.current.setOnlyChanges(true);
    });
    expect(result.current.splitMode).toBe("split");
    expect(result.current.compareRight).toEqual({ seq: 1, id: "v-1" });
    expect(result.current.onlyChanges).toBe(true);
    rerender({ id: "n2" });
    expect(result.current.splitMode).toBe("auto");
    expect(result.current.compareRight).toBe("current");
    expect(result.current.onlyChanges).toBe(false);
  });

  // ── rev 10：比較對象＝左右一對（spec §8.4【rev 10】） ─────────────────────────────
  it("rev 10：右邊預設 current；沒有 provider 的 no-op 也是 current", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    expect(result.current.compareRight).toBe("current");
    const { result: noop } = renderHook(() => useVersions());
    expect(noop.current.compareRight).toBe("current");
  });

  it("rev 10：startPreview 只換左邊，右邊選過的版保持（「面板選版本的時候如果右側有選成其他版的話不用跳回目前」）", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => result.current.startPreview({ seq: 3, id: "v-3" }));
    act(() => result.current.setCompareRight({ seq: 1, id: "v-1" }));
    act(() => result.current.startPreview({ seq: 2, id: "v-2" }));
    expect(result.current.preview).toEqual({ seq: 2, id: "v-2" });
    expect(result.current.compareRight).toEqual({ seq: 1, id: "v-1" });
  });

  it("rev 10：stopPreview → 右邊重設 current", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => result.current.startPreview({ seq: 3, id: "v-3" }));
    act(() => result.current.setCompareRight({ seq: 1, id: "v-1" }));
    act(() => result.current.stopPreview());
    expect(result.current.compareRight).toBe("current");
  });

  it("rev 10：enabled 翻 false → 右邊重設 current（翻回 true 也不重現）", () => {
    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useVersionsController({ noteId: "n1", enabled }), { initialProps: { enabled: true } });
    act(() => result.current.startPreview({ seq: 3, id: "v-3" }));
    act(() => result.current.setCompareRight({ seq: 1, id: "v-1" }));
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(result.current.compareRight).toBe("current");
  });

  it("rev 10 N-2：enabled=false 時 setCompareRight 不生效（翻回 true 仍是 current）", () => {
    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useVersionsController({ noteId: "n1", enabled }), { initialProps: { enabled: false } });
    act(() => result.current.setCompareRight({ seq: 1, id: "v-1" }));
    rerender({ enabled: true });
    expect(result.current.compareRight).toBe("current");
  });

  it("rev 10：跨斷點（預覽一併離開）→ 右邊重設 current", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => result.current.startPreview({ seq: 3, id: "v-3" }));
    act(() => result.current.setCompareRight({ seq: 1, id: "v-1" }));
    mm.set(true);
    expect(result.current.preview).toBeNull();
    expect(result.current.compareRight).toBe("current");
  });

  it("VersionsProvider 把 value 交給子孫", () => {
    function Probe() {
      return <span data-testid="probe">{String(useVersions().enabled)}</span>;
    }
    function Host({ children }: { children: ReactNode }) {
      const value = useVersionsController({ noteId: "n1", enabled: true });
      return <VersionsProvider value={value}>{children}</VersionsProvider>;
    }
    render(
      <Host>
        <Probe />
      </Host>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("true");
  });

  it("isOverlayOpen：dialog（非側欄抽屜）或 menu 在 DOM 才為真", () => {
    expect(isOverlayOpen()).toBe(false);
    const drawer = document.createElement("div");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("data-sidebar-drawer", "");
    document.body.append(drawer);
    expect(isOverlayOpen()).toBe(false);
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    expect(isOverlayOpen()).toBe(true);
    drawer.remove();
    menu.remove();
  });
});
