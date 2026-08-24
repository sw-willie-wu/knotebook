import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { CollabState } from "@/collab/connection";
import i18n from "@/i18n";
import { ConnectionBadge, OFFLINE_WARN_MS } from "./ConnectionBadge";

function renderBadge(state: CollabState, synced?: boolean) {
  return render(<ConnectionBadge state={state} synced={synced} />);
}

describe("ConnectionBadge（issue #48：離線可見性）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("connected：顯示「Connected」、不因時間升級", () => {
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

    rerender(<ConnectionBadge state={{ phase: "connected", role: "owner" }} synced={true} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
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
