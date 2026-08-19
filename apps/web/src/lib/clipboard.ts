/**
 * 複製文字到剪貼簿，回傳是否成功（**不拋錯**——呼叫端只需要處理 true/false）。
 *
 * 為什麼不能只用 `navigator.clipboard`：那支 API 只存在於 secure context（https 或
 * localhost）。自架 Knotebook 最常見的拓撲之一就是明文 http 的區網位址
 * （見 docs/self-hosting.md 的 LAN 模式），在那裡 `navigator.clipboard` 是 undefined，
 * 「複製連結」會直接失效。所以保留 `document.execCommand("copy")` 這條老路當退路：
 * 它已被標記為 deprecated，但在非 secure context 仍是唯一可用的程式化複製手段。
 *
 * 兩條路都失敗時回 `false`，呼叫端應該把網址攤開來讓使用者自己選取複製。
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 權限被拒或非 secure context 下的實作差異——落到下面的退路再試一次。
    }
  }

  return copyViaExecCommand(text);
}

function copyViaExecCommand(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  // 不能用 display:none／visibility:hidden——那樣選取不到，execCommand 會失敗。
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
