import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

/**
 * `navigator.clipboard` 只存在於 secure context（https 或 localhost）。自架最常見的
 * 拓撲之一是明文 http 的區網位址，那裡整個 API 都不存在——所以每個 case 都得能
 * 分別控制「clipboard API 在不在」與「execCommand 成不成功」。
 */
function stubClipboard(writeText: (() => Promise<void>) | null): void {
  vi.stubGlobal("navigator", writeText === null ? {} : { clipboard: { writeText } });
}

function stubExecCommand(result: boolean | (() => never)): ReturnType<typeof vi.fn> {
  const execCommand = vi.fn(typeof result === "function" ? result : () => result);
  Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true, writable: true });
  return execCommand;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // 兩支 document 方法是用 defineProperty 補上的（jsdom 沒有實作），逐案清掉避免外溢。
  Reflect.deleteProperty(document, "execCommand");
  Reflect.deleteProperty(document, "queryCommandEnabled");
});

describe("copyText", () => {
  it("secure context：用 navigator.clipboard.writeText", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    const execCommand = stubExecCommand(true);

    await expect(copyText("https://example.test/notes/x")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://example.test/notes/x");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("非 secure context（沒有 navigator.clipboard）：退回 execCommand 仍然複製得到", async () => {
    stubClipboard(null);
    const execCommand = stubExecCommand(true);

    await expect(copyText("http://192.168.0.2:8006/notes/x")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("clipboard API 存在但拋錯（權限被拒）：退回 execCommand", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    const execCommand = stubExecCommand(true);

    await expect(copyText("x")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("兩條路都失敗 → false（呼叫端據此顯示手動複製的退路）", async () => {
    stubClipboard(null);
    stubExecCommand(false);

    await expect(copyText("x")).resolves.toBe(false);
  });

  it("execCommand 拋錯也算失敗，不往外拋", async () => {
    stubClipboard(null);
    stubExecCommand(() => {
      throw new Error("nope");
    });

    await expect(copyText("x")).resolves.toBe(false);
  });

  /**
   * 這條釘的是實測過的真實失敗：Radix 的 modal dialog 會裝一個 document 級
   * `focusin` 監聽器，只要焦點落到容器外就同步搶回去。textarea 若掛在
   * `document.body`，`select()` 之後焦點立刻被奪走，`execCommand("copy")` 在沒有
   * 焦點的 textarea 上執行——Chromium 實測仍回傳 `true` 但剪貼簿是空的，於是使用者
   * 看到「已複製」卻什麼都沒複製到。所以 textarea 必須掛進焦點所在的 dialog 容器內。
   */
  it("焦點在 modal dialog 內時，暫時的 textarea 要掛在該 dialog 裡而非 document.body", async () => {
    stubClipboard(null);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    button.focus();

    let hostAtCopyTime: string | null = null;
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => {
        const textarea = document.querySelector("textarea");
        hostAtCopyTime = textarea?.parentElement === dialog ? "dialog" : (textarea?.parentElement?.tagName ?? "none");
        return true;
      }),
      configurable: true,
      writable: true,
    });

    await expect(copyText("x")).resolves.toBe(true);
    expect(hostAtCopyTime).toBe("dialog");

    dialog.remove();
  });

  it("瀏覽器回報 copy 指令不可用（queryCommandEnabled false）→ 一律當失敗，不誤報成功", async () => {
    stubClipboard(null);
    stubExecCommand(true); // 焦點被搶走的情境下 Chromium 仍會回 true——不能只信它
    Object.defineProperty(document, "queryCommandEnabled", {
      value: vi.fn(() => false),
      configurable: true,
      writable: true,
    });

    await expect(copyText("x")).resolves.toBe(false);
  });

  it("fallback 不留下暫時的 textarea", async () => {
    stubClipboard(null);
    stubExecCommand(true);

    await copyText("x");

    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });
});
