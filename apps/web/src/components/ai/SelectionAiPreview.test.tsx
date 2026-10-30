import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { AiPreview } from "@/ai/preview";
import "@/i18n";
import type { DiffBlock } from "@/lib/version-diff";
import { ThemeProvider } from "@/theme";
import { SelectionAiPreview } from "./SelectionAiPreview";

const para = (id: string, text: string): DiffBlock => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] });

function makePreview(afterText: string): AiPreview {
  return { before: [para("a1", "original middle sentence")], after: [para("n1", afterText)], noChange: false };
}

describe("SelectionAiPreview（#263 §5.4）", () => {
  it("只渲染被改的區塊，每塊照 diff 標記（added／deleted／changed）", async () => {
    render(
      <ThemeProvider>
        <SelectionAiPreview preview={makePreview("totally new text")} onReady={() => {}} />
      </ThemeProvider>,
    );
    await screen.findByTestId("selection-ai-preview");
    const marks = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="selection-ai-preview"] .bn-block-outer[data-id]')).map((el) =>
      el.getAttribute("data-diff"),
    );
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((mark) => mark === "added" || mark === "deleted" || mark === "changed")).toBe(true);
  });

  it("就緒訊號：掛載後 onReady(那份 preview)；preview 換新 → 先 onReady(null) 再 onReady(新的)；卸載 → onReady(null)", async () => {
    const onReady = vi.fn();
    const first = makePreview("first result");
    const second = makePreview("second result");
    const { rerender, unmount } = render(
      <ThemeProvider>
        <SelectionAiPreview preview={first} onReady={onReady} />
      </ThemeProvider>,
    );
    await screen.findByTestId("selection-ai-preview");
    expect(onReady.mock.calls).toEqual([[first]]);
    rerender(
      <ThemeProvider>
        <SelectionAiPreview preview={second} onReady={onReady} />
      </ThemeProvider>,
    );
    expect(onReady.mock.calls).toEqual([[first], [null], [second]]);
    unmount();
    expect(onReady.mock.calls.at(-1)).toEqual([null]);
  });

  it("#269：只改快照的 wikilink 區塊（AI 往返後 snapshotTitle≠label）不標記；快取沒有筆記清單（titleOf 為空）也照常渲染", async () => {
    const wl = (snap: string) => ({ type: "wikilink", props: { targetNoteId: "11111111-1111-4111-8111-111111111111", snapshotTitle: snap, label: "L", anchorBlockId: "" } });
    const preview: AiPreview = { before: [{ id: "a", type: "paragraph", content: [wl("Target")], children: [] }], after: [{ id: "a", type: "paragraph", content: [wl("L")], children: [] }], noChange: false };
    // 未變更區塊的 wikilink 由 MemberWikilink 渲染（要 QueryClient 與 Router）；queries 預設停用 ⇒ 不發 /api/notes、快取保持空。
    const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <SelectionAiPreview preview={preview} onReady={() => {}} />
          </ThemeProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const box = await screen.findByTestId("selection-ai-preview");
    expect(box.querySelector("[data-diff]")?.getAttribute("data-diff") ?? "context").toBe("context");
  });

  it("#269：變動區塊內的 wikilink（無 label）以快取的現行標題呈現——titleOf 有傳到 renderDiff，不顯示兩側快照", async () => {
    const ID = "11111111-1111-4111-8111-111111111111";
    const wl = (snap: string) => ({ type: "wikilink", props: { targetNoteId: ID, snapshotTitle: snap, label: "", anchorBlockId: "" } });
    const text = (t: string) => ({ type: "text", text: t, styles: {} });
    const preview: AiPreview = {
      before: [{ id: "a", type: "paragraph", content: [wl("Target"), text(" x")], children: [] }],
      after: [{ id: "a", type: "paragraph", content: [wl("Other"), text(" y")], children: [] }],
      noChange: false,
    };
    // queries 停用 ⇒ 不發 /api/notes；清單只從預先放進快取的資料來（hook 被動訂閱）。
    const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    queryClient.setQueryData(["notes"], [{ id: ID, title: "Live", ownerHandle: "ann", groupId: null, slug: "live" }]);
    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <SelectionAiPreview preview={preview} onReady={() => {}} />
          </ThemeProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const box = await screen.findByTestId("selection-ai-preview");
    const block = box.querySelector('[data-id="a"]');
    expect(block?.getAttribute("data-diff")).toBe("changed");
    expect(block).toHaveTextContent("Live");
    expect(block).not.toHaveTextContent("Target");
    expect(block).not.toHaveTextContent("Other");
  });

  it("PV1（並排 PR-2 擴大成整列）：before／after 都是一列（右欄 b → B）→ 渲染不丟例外、看得到 B、onReady 被呼叫", async () => {
    const twoCols = (id: string, left: DiffBlock, right: DiffBlock): DiffBlock => ({
      id,
      type: "columnList",
      props: {},
      children: [
        { id: `${id}c0`, type: "column", props: { width: 1 }, children: [left] },
        { id: `${id}c1`, type: "column", props: { width: 1 }, children: [right] },
      ],
    });
    const preview: AiPreview = {
      before: [twoCols("r", para("a1", "a"), para("b1", "b"))],
      after: [twoCols("n", para("n1", "a"), para("n2", "B"))],
      noChange: false,
    };
    const onReady = vi.fn();
    render(
      <ThemeProvider>
        <SelectionAiPreview preview={preview} onReady={onReady} />
      </ThemeProvider>,
    );
    const box = await screen.findByTestId("selection-ai-preview");
    expect(box).toHaveTextContent("B");
    expect(onReady).toHaveBeenCalledWith(preview);
  });
});

describe("index.css：框選 AI 預覽的樣式規則（#263 §5.3、§5.4）", () => {
  const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8");
  it("沒有上下文塊的淡色規則（#263 後續：預覽不再帶前後上下文，surround 已移除）", () => {
    expect(css).not.toContain('data-diff="surround"');
  });
  it("框內唯讀編輯器左右內距歸零，選擇器墊到 (0,3,0)", () => {
    expect(css).toMatch(/\.kb-ai-preview \.bn-editor\.bn-editor \{[^}]*padding-inline: 0;/);
  });
  it("四種色條改 inset box-shadow 並拿掉 border-left，選擇器 (0,4,0)", () => {
    for (const mark of ["added", "deleted", "changed", "moved"]) {
      expect(css).toMatch(new RegExp(`\\.kb-ai-preview \\.kb-diff \\[data-diff="${mark}"\\] > \\.bn-block \\{[^}]*border-left: 0;[^}]*box-shadow: inset 3px 0 0 `));
    }
  });
});
