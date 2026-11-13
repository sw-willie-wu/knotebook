import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { avatarUrl, type VersionEditorDto } from "@knotebook/shared";
import { EditorAvatars } from "./EditorAvatars";

const ID_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ID_B = "1f8fad5b-d9cb-469f-a165-70867728950e";

const ed = (handle: string, over: Partial<VersionEditorDto> = {}): VersionEditorDto => ({ handle, agentLabel: null, avatar: null, ...over });

function group(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}
/** 圓形頭像本體（不含「+N」）。 */
function circles(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>("[data-editor-avatar]"));
}

describe("EditorAvatars", () => {
  it("1 人：一個頭像、沒有 +N；整塊 aria-hidden", () => {
    const { container } = render(<EditorAvatars editors={[ed("alice")]} />);
    expect(group(container)).toHaveAttribute("aria-hidden", "true");
    expect(circles(group(container))).toHaveLength(1);
    expect(group(container).textContent).toBe("A");
  });

  it("3 人：三個頭像、沒有 +N；順序同輸入", () => {
    const { container } = render(<EditorAvatars editors={[ed("alice"), ed("bob"), ed("carol")]} />);
    const els = circles(group(container));
    expect(els.map((e) => e.textContent)).toEqual(["A", "B", "C"]);
    expect(group(container).textContent).toBe("ABC");
  });

  it("5 人：前三個頭像＋「+2」（純文字、aria-hidden）", () => {
    const { container } = render(<EditorAvatars editors={["alice", "bob", "carol", "dave", "erin"].map((h) => ed(h))} />);
    const els = circles(group(container));
    expect(els.map((e) => e.textContent)).toEqual(["A", "B", "C"]);
    const more = Array.from(group(container).querySelectorAll("span")).find((s) => s.textContent === "+2");
    expect(more).toBeTruthy();
    expect(more).toHaveAttribute("aria-hidden", "true");
  });

  it("同一個 handle 以人與 agent 兩種身分出現 → 只畫一個", () => {
    const { container } = render(
      <EditorAvatars editors={[ed("alice", { avatar: { id: ID_A, v: 1 } }), ed("alice", { agentLabel: "claude", avatar: { id: ID_A, v: 1 } }), ed("bob")]} />,
    );
    const els = circles(group(container));
    expect(els).toHaveLength(2);
    expect(group(container).querySelectorAll("img")).toHaveLength(1);
  });

  it("去重後才算上限：4 筆其中 2 筆同 handle → 3 個頭像、沒有 +N", () => {
    const { container } = render(<EditorAvatars editors={[ed("alice"), ed("alice", { agentLabel: "x" }), ed("bob"), ed("carol")]} />);
    expect(circles(group(container))).toHaveLength(3);
    expect(group(container).textContent).not.toContain("+");
  });

  it("兩個已刪除的使用者（handle 空字串）合成一個「?」占位，沒有 img", () => {
    const { container } = render(<EditorAvatars editors={[ed(""), ed("")]} />);
    const els = circles(group(container));
    expect(els).toHaveLength(1);
    expect(els[0]!.textContent).toBe("?");
    expect(container.querySelector("img")).toBeNull();
  });

  it("agent 編輯者畫本人頭貼（img、src 經 avatarUrl），不是 AI 圖示", () => {
    const { container } = render(<EditorAvatars editors={[ed("alice", { agentLabel: "claude", avatar: { id: ID_B, v: 3 } })]} />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(avatarUrl(ID_B, 3));
    expect(container.querySelector("svg")).toBeNull();
  });

  it("avatar 欄缺（舊 server）→ 首字、不丟錯", () => {
    const legacy = { handle: "alice", agentLabel: null } as unknown as VersionEditorDto;
    const { container } = render(<EditorAvatars editors={[legacy]} />);
    expect(container.querySelector("img")).toBeNull();
    expect(group(container).textContent).toBe("A");
  });

  it("沒有編輯者 → 不渲染", () => {
    const { container } = render(<EditorAvatars editors={[]} />);
    expect(container.firstElementChild).toBeNull();
  });
});
