/**
 * 觸控長按偵測（spec 2026-10-13 site-links rev 7 §7.4）：wikilink 與一般連結共用。只看 `pointerType === "touch"`（不看螢幕寬）。
 * - 按住 `LONG_PRESS_MS` 不動 ⇒ 成立；手指移動超過 `LONG_PRESS_SLOP_PX`、提早放開或 pointercancel（捲動）⇒ 取消。
 * - Android 在長按當下發 `contextmenu`：按壓中收到就攔下並立刻成立（系統的長按門檻可能比 500 ms 短）。滑鼠右鍵不在按壓中，不攔。
 * - 成立後放開時瀏覽器可能補發 mousedown／mouseup／click：`suppressing()` 為真期間由呼叫端攔掉，下一次 pointerdown 或吃掉 click 後解除。
 */
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

interface PointLike {
  pointerType: string;
  clientX: number;
  clientY: number;
}

export interface LongPress {
  down(e: PointLike): void;
  move(e: PointLike): void;
  /** pointerup／pointercancel。 */
  end(): void;
  /** 這次按下不追蹤（例如不是按在連結上）：取消計時並解除攔截。 */
  reset(): void;
  /** 回傳 true ＝這個 contextmenu 屬於觸控長按，呼叫端要 `preventDefault()`。 */
  contextMenu(): boolean;
  /** 長按成立後、補發的滑鼠事件還沒結束。 */
  suppressing(): boolean;
  /** click 到達：回傳 true ＝這是長按後補發的 click，要攔；同時解除攔截。 */
  consumeClick(): boolean;
  dispose(): void;
}

export function createLongPress(onLongPress: () => void): LongPress {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let fired = false;
  let startX = 0;
  let startY = 0;
  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = false;
  };
  const fire = () => {
    stop();
    fired = true;
    onLongPress();
  };
  return {
    down(e) {
      stop();
      fired = false;
      if (e.pointerType !== "touch") return;
      pending = true;
      startX = e.clientX;
      startY = e.clientY;
      timer = setTimeout(fire, LONG_PRESS_MS);
    },
    move(e) {
      if (pending && Math.hypot(e.clientX - startX, e.clientY - startY) > LONG_PRESS_SLOP_PX) stop();
    },
    end: stop,
    reset() {
      stop();
      fired = false;
    },
    contextMenu() {
      if (pending) fire();
      return fired;
    },
    suppressing: () => fired,
    consumeClick() {
      const was = fired;
      fired = false;
      return was;
    },
    dispose: stop,
  };
}
