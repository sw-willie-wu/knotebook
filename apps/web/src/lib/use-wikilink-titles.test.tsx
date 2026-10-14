import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useWikilinkTitleOf, wikilinkIdsIn } from "./use-wikilink-titles";
import type { DiffBlock } from "./version-diff";

const ID1 = "11111111-1111-4111-8111-111111111111";
const a: DiffBlock[] = [{ id: "A", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: ID1 } }], children: [] }];

describe("#269 useWikilinkTitleOf", () => {
  it("wikilinkIdsIn 走 inline、表格與 children", () => {
    const out = new Set<string>();
    wikilinkIdsIn([{ id: "t", type: "table", content: { type: "tableContent", rows: [{ cells: [[{ type: "wikilink", props: { targetNoteId: "x" } }]] }] }, children: [{ id: "c", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: "y" } }] }] }], out);
    expect([...out].sort()).toEqual(["x", "y"]);
    // 表格 cell 的物件形 `{ type: "tableCell", content: [...] }` 也要走到。
    const obj = new Set<string>();
    wikilinkIdsIn([{ id: "t2", type: "table", content: { type: "tableContent", rows: [{ cells: [{ type: "tableCell", content: [{ type: "wikilink", props: { targetNoteId: "z" } }] }] }] } }], obj);
    expect([...obj]).toEqual(["z"]);
  });

  it("清單重抓但相關標題沒變 ⇒ 同一個函式；相關標題變了 ⇒ 換函式；沒有 QueryClient ⇒ 一律 undefined", () => {
    const qc = new QueryClient();
    qc.setQueryData(["notes"], [{ id: ID1, title: "One" }, { id: "other", title: "X" }]);
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useWikilinkTitleOf(a, a), { wrapper });
    const first = result.current;
    expect(first(ID1)).toBe("One");
    act(() => qc.setQueryData(["notes"], [{ id: ID1, title: "One" }, { id: "other", title: "Changed" }]));
    expect(result.current).toBe(first);
    act(() => qc.setQueryData(["notes"], [{ id: ID1, title: "Two" }]));
    expect(result.current).not.toBe(first);
    expect(result.current(ID1)).toBe("Two");
    const bare = renderHook(() => useWikilinkTitleOf(a, a));
    expect(bare.result.current(ID1)).toBeUndefined();
  });

  it("舊文件存大寫 targetNoteId：照樣對到清單的小寫 id（sameNoteId），以文件裡的原字串查得到標題", () => {
    const lower = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const upper: DiffBlock[] = [{ id: "U", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: lower.toUpperCase() } }], children: [] }];
    const qc = new QueryClient();
    qc.setQueryData(["notes"], [{ id: lower, title: "One" }]);
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useWikilinkTitleOf(upper, null), { wrapper });
    expect(result.current(lower.toUpperCase())).toBe("One");
  });
});
