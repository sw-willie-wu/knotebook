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
  group: null,
};

const AT = "2026-02-03T04:05:06.000Z";
const fmt = (iso: string) => new Date(iso).toLocaleDateString(i18n.language);
const full = (iso: string) => new Date(iso).toLocaleString(i18n.language);

describe("LastEditedLabel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("lastEdited 為 null 時不渲染任何節點", () => {
    const { container } = render(<LastEditedLabel note={{ ...NOTE, lastEdited: null }} onOpenEdits={vi.fn()} />);
    expect(screen.queryByTestId("last-edited")).toBeNull();
    // 分隔線與標籤同一個 null 條件：不能只剩一條孤線。
    expect(container.firstChild).toBeNull();
  });

  it("人形：前綴 + handle · 日期，不是按鈕；title 是含 who 的完整字串（lastEditedAt）", () => {
    render(
      <LastEditedLabel
        note={{ ...NOTE, lastEdited: { at: AT, byHandle: "willie", agentLabel: null } }}
        onOpenEdits={vi.fn()}
      />,
    );
    const el = screen.getByTestId("last-edited");
    expect(el.textContent).toBe(`Last edited by willie · ${fmt(AT)}`);
    expect(el.tagName).not.toBe("BUTTON");
    expect(el.getAttribute("title")).toBe(i18n.t("note.lastEditedAt", { who: "willie", when: full(AT) }));
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
    expect(btn.textContent).toBe(`Last edited by willie (claude) · ${fmt(AT)}`);
    // AI 形是唯一可按的那一種，tooltip 比人形的 lastEditedAt 多一句「點一下看改了什麼」，
    // 說明按下去會發生什麼（見上一案）。
    expect(btn.getAttribute("title")).toBe(i18n.t("note.lastEditedTitle", { who: "willie (claude)", when: full(AT) }));
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

  // class 斷言，不是行為斷言：jsdom 沒有 CSS、沒有版面，這裡只釘 class 字串。
  it("分隔線與可縮（class 斷言，jsdom 無 CSS、無版面）：兩形皆然", () => {
    const { rerender } = render(
      <LastEditedLabel
        note={{ ...NOTE, lastEdited: { at: AT, byHandle: "willie", agentLabel: null } }}
        onOpenEdits={vi.fn()}
      />,
    );
    for (const agentLabel of [null, "claude"]) {
      rerender(
        <LastEditedLabel
          note={{ ...NOTE, lastEdited: { at: AT, byHandle: "willie", agentLabel } }}
          onOpenEdits={vi.fn()}
        />,
      );
      const label = screen.getByTestId("last-edited");
      const sep = label.previousElementSibling;
      expect(sep).not.toBeNull();
      expect(sep).toHaveAttribute("aria-hidden", "true");
      expect(sep).toHaveClass("h-4", "w-px", "bg-border", "max-md:hidden");
      expect(label).toHaveClass("min-w-0", "truncate");
      expect(label).not.toHaveClass("shrink-0");
    }
  });

  it("帳號已刪（byHandle 為空字串）：who 代入「a deleted account」", () => {
    render(
      <LastEditedLabel
        note={{ ...NOTE, lastEdited: { at: AT, byHandle: "", agentLabel: null } }}
        onOpenEdits={vi.fn()}
      />,
    );
    expect(screen.getByTestId("last-edited").textContent).toBe(`Last edited by a deleted account · ${fmt(AT)}`);
  });
});
