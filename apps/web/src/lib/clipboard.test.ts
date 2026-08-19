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

  it("fallback 不留下暫時的 textarea", async () => {
    stubClipboard(null);
    stubExecCommand(true);

    await copyText("x");

    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });
});
