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
    const badge = screen.getByText("Not loaded — offline");
    expect(badge).toBeInTheDocument();
    // 警示色（destructive），不是預設灰。
    expect(badge.className).toContain("text-destructive");
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

  it("connected 且 viewer → 顯示角色與唯讀標記（既有行為不被離線邏輯影響）", () => {
    renderBadge({ phase: "connected", role: "viewer" }, true);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });
});
