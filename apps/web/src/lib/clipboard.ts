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
 *
 * PR2（D.4）：host 選擇器擴為 `[role="dialog"],[role="menu"]`——內文卡頁頭的 ⋮
 * 選單（`role="menu"`）也是 Radix 的 focus-trap surface（跟 dialog 同一套
 * `FocusScope` 邏輯），從選單觸發複製時一樣需要把暫時的 textarea 掛進去，否則焦點
 * 被搶走、`execCommand("copy")` 在沒有焦點的元素上跑會靜默失敗（見下方
 * `copyViaExecCommand` 的說明）。這是有意的契約擴張——`clipboard.test.ts` 鏡像新增
 * 一個 `role="menu"` host 案。
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

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // ⚠ 掛在哪裡會決定成敗：Radix 的 modal dialog／dropdown menu 都裝了 document 級
  // `focusin` 監聽器，焦點一落到容器外就同步搶回去。textarea 若掛在 document.body，
  // `select()` 之後焦點立刻被奪走，`execCommand("copy")` 在沒有焦點的 textarea 上跑——
  // Chromium 實測仍回傳 true 但剪貼簿是空的。掛進焦點所在的 dialog／menu 內就不會
  // 觸發那個監聽器（PR2 D.4：⋮ 選單是 `role="menu"`，同一套雷，選擇器一併擴充）。
  const host = active?.closest('[role="dialog"],[role="menu"]') ?? document.body;

  host.appendChild(textarea);
  try {
    textarea.select();
    // 上面那種「回傳 true 但其實沒複製」的情境，queryCommandEnabled 會誠實回 false
    // （實測對照過）。瀏覽器沒有這支 API 時就只能信 execCommand 的回傳值。
    if (typeof document.queryCommandEnabled === "function" && !document.queryCommandEnabled("copy")) {
      return false;
    }
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    active?.focus();
  }
}
