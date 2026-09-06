/**
 * #138 Task 4：頁首的「最後編輯」標籤。
 *
 * ⚠ 時間一律用**既有的絕對日期格式**（`ApiTokensSection.tsx` 的 `formatDate` 同款
 * `toLocaleDateString(i18n.language)`）——repo 裡沒有任何 `Intl.RelativeTimeFormat`
 * 或相對時間 helper。斷言比對**完整格式化字串**而不是前綴：只比前綴的話，實作者
 * 臨時發明一套沒被審過的格式也照樣綠。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { LastEditedLabel } from "./LastEditedLabel";

const NOTE: NoteDto = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "My Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
};

const AT = "2026-02-03T04:05:06.000Z";
const fmt = (iso: string) => new Date(iso).toLocaleDateString(i18n.language);
const full = (iso: string) => new Date(iso).toLocaleString(i18n.language);

describe("LastEditedLabel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("lastEdited 為 null 時不渲染任何節點", () => {
    render(<LastEditedLabel note={{ ...NOTE, lastEdited: null }} onOpenEdits={vi.fn()} />);
    expect(screen.queryByTestId("last-edited")).toBeNull();
  });

  it("人形：handle · 日期，不是按鈕；title 是完整日期時間", () => {
    render(
      <LastEditedLabel
        note={{ ...NOTE, lastEdited: { at: AT, byHandle: "willie", agentLabel: null } }}
        onOpenEdits={vi.fn()}
      />,
    );
    const el = screen.getByTestId("last-edited");
    expect(el.textContent).toBe(`willie · ${fmt(AT)}`);
    expect(el.tagName).not.toBe("BUTTON");
    expect(el.getAttribute("title")).toBe(full(AT));
  });

  it("AI 形：handle (label) · 日期，是按鈕，按下呼叫 onOpenEdits", () => {
    const open = vi.fn();
    render(
      <LastEditedLabel
        note={{ ...NOTE, lastEdited: { at: AT, byHandle: "willie", agentLabel: "claude" } }}
        onOpenEdits={open}
      />,
    );
    const btn = screen.getByRole("button", { name: /willie \(claude\)/ });
    expect(btn.textContent).toBe(`willie (claude) · ${fmt(AT)}`);
    // AI 形是唯一可按的那一種，tooltip 要說明按下去會發生什麼（人形沒有這個需求，
    // 它的 title 就是純粹的完整時間，見上一案）。
    expect(btn.getAttribute("title")).toBe(i18n.t("note.lastEditedTitle", { when: full(AT) }));
    fireEvent.click(btn);
    expect(open).toHaveBeenCalledTimes(1);
  });

  // review r1 minor-2：窄視窗要跟同一個 header 裡的 ConnectionBadge 一致——
  // max-md:sr-only（螢幕閱讀器讀得到、視覺隱藏），不是 hidden（display:none 整個
  // 從無障礙樹消失）；斷點也是 md，不是 sm。兩形（人形 span、AI 形 button）都要守。
  it("窄視窗：max-md:sr-only（非 hidden），兩形都要守", () => {
    const { rerender } = render(
      <LastEditedLabel
        note={{ ...NOTE, lastEdited: { at: AT, byHandle: "willie", agentLabel: null } }}
        onOpenEdits={vi.fn()}
      />,
    );
    const humanEl = screen.getByTestId("last-edited");
    expect(humanEl).toHaveClass("max-md:sr-only");
    expect(humanEl.className).not.toContain("hidden");
    expect(humanEl.className).not.toContain("sm:inline");

    rerender(
      <LastEditedLabel
        note={{ ...NOTE, lastEdited: { at: AT, byHandle: "willie", agentLabel: "claude" } }}
        onOpenEdits={vi.fn()}
      />,
    );
    const aiEl = screen.getByTestId("last-edited");
    expect(aiEl).toHaveClass("max-md:sr-only");
    expect(aiEl.className).not.toContain("hidden");
    expect(aiEl.className).not.toContain("sm:inline");
  });
});
