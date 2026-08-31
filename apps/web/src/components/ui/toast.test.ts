import { readFileSync } from "node:fs";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissAllToasts, dismissToast, toast, useToasts } from "./toast";

// 回歸測試：apps/web/src/components/ui/toast.tsx 的 id 產生器曾用
// crypto.randomUUID()，在非 secure context（LAN plain-http，rev 5.6
// 正當拓撲）該 API 不存在 → toast() 每次呼叫都拋 TypeError。這裡用
// vi.stubGlobal 模擬「沒有 randomUUID」的 crypto 形狀，確認 toast()
// 不再依賴它。

afterEach(() => {
  dismissAllToasts();
  vi.unstubAllGlobals();
});

describe("toast()", () => {
  it("does not throw when crypto.randomUUID is unavailable (non-secure context)", () => {
    // 模擬非 secure context 的 crypto 形狀——存在但沒有 randomUUID。
    vi.stubGlobal("crypto", {});

    let id = "";
    expect(() => {
      id = toast({ title: "a" });
    }).not.toThrow();
    expect(id).toBeTruthy();
  });

  it("produces distinct ids across successive calls", () => {
    const id1 = toast({ title: "a" });
    const id2 = toast({ title: "b" });
    expect(id1).not.toBe(id2);
  });

  it("dismissToast removes the matching item by id", () => {
    const { result } = renderHook(() => useToasts());

    let id1 = "";
    let id2 = "";
    act(() => {
      id1 = toast({ title: "a" });
      id2 = toast({ title: "b" });
    });
    expect(result.current.map((t) => t.id)).toEqual([id1, id2]);

    act(() => {
      dismissToast(id1);
    });
    expect(result.current.map((t) => t.id)).toEqual([id2]);
  });

  it("#115：viewport 帶 pointer-events-none、toast item 帶 pointer-events-auto（成對不變量）", () => {
    // 源碼掃描（本檔是 .ts、渲染 Radix viewport 又需要 provider 整組）：空 viewport
    // 是右下角一塊 fixed 命中區，缺 `pointer-events-none` 會擋住 AI bubble 下緣；
    // 但這個 class 只有在 item 自帶 `pointer-events-auto` 時才安全——兩者成對，
    // 拆開任一半都要紅。
    //
    // ⚠ 掃描前必須剝掉 `//` 註解（比照 theme.* 系列守衛慣例）：toast.tsx 的
    // 說明註解本身就含這兩個字面量，不剝的話「守衛守住的是自己的註解」——
    // 第一版正是這樣被突變測試（把兩個 class 都拔掉仍 4/4 綠）翻案的。錨定也
    // 收緊到**帶引號的 class 字面量開頭**，不吃 cn(...) 區塊裡的任意文字。
    const raw = readFileSync(`${process.cwd()}/src/components/ui/toast.tsx`, "utf8");
    const source = raw.replace(/(^|[^:])\/\/[^\n]*/g, "$1");

    const viewport = /ToastPrimitive\.Viewport[\s\S]*?className=\{cn\(([\s\S]*?)\)\}/.exec(source);
    expect(viewport, "找不到 Viewport 的 className").not.toBeNull();
    expect(viewport![1]).toMatch(/"pointer-events-none [^"]*fixed bottom-0 right-0/);

    const root = /ToastPrimitive\.Root\s[\s\S]*?className=\{cn\(([\s\S]*?)\)\}/.exec(source);
    expect(root, "找不到 ToastRoot 的 className").not.toBeNull();
    expect(root![1]).toMatch(/"pointer-events-auto /);
  });
});
