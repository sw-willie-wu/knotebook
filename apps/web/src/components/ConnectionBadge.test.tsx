import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { CollabState } from "@/collab/connection";
import i18n from "@/i18n";
import { ConnectionBadge, OFFLINE_WARN_MS } from "./ConnectionBadge";

function renderBadge(state: CollabState, synced: boolean, canEdit = true) {
  return render(<ConnectionBadge state={state} synced={synced} canEdit={canEdit} />);
}

describe("ConnectionBadge（issue #48：離線可見性）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("OFFLINE_WARN_MS 是幾秒級的門檻（CHANGELOG／docs 對外承諾「a few seconds」）", () => {
    // 其餘測試都用 OFFLINE_WARN_MS 自己推進 timer，是自我參照——改成 60_000 也會全綠。
    // 這一條把「幾秒」這個對使用者的契約釘成字面。
    expect(OFFLINE_WARN_MS).toBeGreaterThanOrEqual(1_000);
    expect(OFFLINE_WARN_MS).toBeLessThanOrEqual(5_000);
  });

  it("connected + synced：顯示「Connected」、不因時間升級", () => {
    renderBadge({ phase: "connected", role: "owner" }, true);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS * 2));
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("短暫的 connecting（未過門檻）不閃警示——只顯示「Connecting…」", () => {
    renderBadge({ phase: "connecting" }, false);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS - 100));
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    expect(screen.queryByText(/offline|Not loaded/i)).not.toBeInTheDocument();
  });

  it("connected 但還沒 synced（server 載入慢／卡住）→ 超過門檻也升級，不停在「已連線」", () => {
    // #48 的反向形狀：onAuthenticated 就進 connected，但 synced 要再一個 round trip。
    // 只看 phase 的話這一格永遠不升級，使用者卡在「已連線」配一篇空白唯讀筆記。
    renderBadge({ phase: "connected", role: "owner" }, false);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByText("Not loaded — offline")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("從未同步 + 離線超過門檻 → 升級成「尚未載入」警示", () => {
    renderBadge({ phase: "connecting" }, false);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByText("Not loaded — offline")).toBeInTheDocument();
    // D.2：警示色訊號現在集中在狀態點上（phase 文字本身統一無色，見
    // ConnectionBadge.tsx 檔頭）——斷言狀態點（`role=status` 底下唯一的
    // `aria-hidden` 節點）帶 `bg-destructive`，不是預設的灰。
    const dot = screen.getByRole("status").querySelector('[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(dot!.className).toContain("bg-destructive");
  });

  it("曾同步 + 離線超過門檻 → 升級成「離線編輯中」（可編輯，只是還沒同步回去）", () => {
    renderBadge({ phase: "reconnecting-once" }, true);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByText("Editing offline — changes not synced yet")).toBeInTheDocument();
  });

  it("升級之後回到 connected → 立刻收回警示（不必等門檻）", () => {
    const { rerender } = renderBadge({ phase: "connecting" }, true);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByText("Editing offline — changes not synced yet")).toBeInTheDocument();

    rerender(<ConnectionBadge state={{ phase: "connected", role: "owner" }} synced={true} canEdit={true} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
  });

  it("升級後回到 connected，再次離線要重新從頭計時（reset 守衛）", () => {
    const { rerender } = renderBadge({ phase: "connecting" }, true);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByText("Editing offline — changes not synced yet")).toBeInTheDocument();

    // 回到 connected：立刻收回。
    rerender(<ConnectionBadge state={{ phase: "connected", role: "owner" }} synced={true} canEdit={true} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();

    // 再次離線：門檻之前**不得**立刻又顯示警示（否則就是沒重新計時）。
    rerender(<ConnectionBadge state={{ phase: "reconnecting-once" }} synced={true} canEdit={true} />);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS - 100));
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
    // 補滿門檻才升級。
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByText("Editing offline — changes not synced yet")).toBeInTheDocument();
  });

  it("viewer 曾同步後斷線 → 顯示中性「離線」，不是「離線編輯中」（他不能編輯、也沒有變更）", () => {
    // 對 viewer 說「變更尚未同步」是假話。離線相位拿不到 role，所以由呼叫端傳 canEdit。
    renderBadge({ phase: "reconnecting-once" }, true, false);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.queryByText(/Editing offline/)).not.toBeInTheDocument();
  });

  it("可編輯角色曾同步後斷線 → 「離線編輯中」（跟 viewer 那條對照）", () => {
    renderBadge({ phase: "reconnecting-once" }, true, true);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByText("Editing offline — changes not synced yet")).toBeInTheDocument();
  });

  it("終態（kicked）不算離線、不排升級 timer——維持撤權樣式", () => {
    renderBadge({ phase: "kicked" }, true);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS * 2));
    expect(screen.getByText("Access revoked")).toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
  });

  it.each(["owner", "editor"] as const)("#335 connected＋synced 的 %s：整個徽章只有「Connected」，不帶角色、不帶唯讀", (role) => {
    renderBadge({ phase: "connected", role }, true);
    expect(screen.getByRole("status")).toHaveTextContent(/^Connected$/);
    expect(screen.queryByText(/Owner|Editor|Viewer|Read-only/)).not.toBeInTheDocument();
  });

  it("#335 connected＋synced 的 viewer：整個徽章只有「Read-only」，不寫「Connected」「Viewer」，點仍是綠的", () => {
    renderBadge({ phase: "connected", role: "viewer" }, true, false);
    expect(screen.getByRole("status")).toHaveTextContent(/^Read-only$/);
    expect(screen.queryByText(/Connected|Viewer/)).not.toBeInTheDocument();
    const dot = screen.getByRole("status").querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(dot.className).not.toContain("bg-destructive");
    expect(dot.style.backgroundColor).toBe("oklch(0.8 0.17 152)");
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS * 2));
    expect(screen.getByRole("status")).toHaveTextContent(/^Read-only$/);
  });

  it("#335 viewer 斷線警示照舊：離線 → 「Offline」（紅點），沒有「Read-only」", () => {
    renderBadge({ phase: "reconnecting-once" }, true, false);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByRole("status")).toHaveTextContent(/^Offline$/);
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
  });

  it("#335 viewer connected 但未 synced：直接顯示「Read-only」；過門檻升級成「尚未載入」", () => {
    renderBadge({ phase: "connected", role: "viewer" }, false, false);
    expect(screen.getByRole("status")).toHaveTextContent(/^Read-only$/);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByRole("status")).toHaveTextContent(/^Not loaded — offline$/);
  });

  it("#335 其餘文案照舊：connecting／reconnecting／kicked／deleted／outdated", () => {
    const cases: Array<[CollabState, string]> = [
      [{ phase: "connecting" }, "Connecting…"],
      [{ phase: "reconnecting-once" }, "Reconnecting…"],
      [{ phase: "kicked" }, "Access revoked"],
      [{ phase: "deleted" }, "Note deleted"],
      [{ phase: "outdated" }, "Reload required"],
    ];
    for (const [state, text] of cases) {
      const { unmount } = renderBadge(state, true);
      expect(screen.getByRole("status")).toHaveTextContent(new RegExp(`^${text}$`));
      unmount();
    }
  });

  it("#115：文字 span 為 max-md:sr-only（窄視窗只留色點，但 aria-live 仍讀得到）；viewer 的「Read-only」也是", () => {
    // 用 sr-only 而不是 hidden：容器是 role=status aria-live=polite，display:none
    // 會讓窄視窗的螢幕閱讀器收不到撤權/降級/離線通知。
    const owner = renderBadge({ phase: "connected", role: "owner" }, true);
    expect(screen.getByText("Connected")).toHaveClass("max-md:sr-only");
    expect(screen.getByText("Connected").className).not.toContain("max-md:hidden");
    owner.unmount();
    renderBadge({ phase: "connected", role: "viewer" }, true, false);
    expect(screen.getByText("Read-only")).toHaveClass("max-md:sr-only");
    expect(screen.getByText("Read-only").className).not.toContain("max-md:hidden");
  });

  it("#269 outdated：中性「Reload required」、超過門檻也不升級成離線警示", () => {
    vi.useFakeTimers();
    renderBadge({ phase: "outdated" }, true);
    act(() => {
      vi.advanceTimersByTime(OFFLINE_WARN_MS + 1_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Reload required");
    expect(screen.getByRole("status")).not.toHaveTextContent("Editing offline");
    vi.useRealTimers();
  });
});
