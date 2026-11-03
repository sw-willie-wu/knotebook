import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { BLOCK_ANCHOR_RE, TOP_SECTION_ID } from "@knotebook/shared";
import type { BlockAnchorApi } from "./block-anchor-context";
import { findMatchBlock, topUnits } from "./block-find";
import { onSearchMarkClear, watchSearchEscape } from "./search-mark";

/**
 * #93 PR2：側欄搜尋點片段時，router navigation state 帶的查詢字（`navigate(href, { state: { kbFind } })`）。不進網址，免得複製出去的連結被污染。
 * 注意 state 存在 `history.state`：重新整理後瀏覽器仍帶著它，所以重整會再跳一次（與 `#b-` 重整會再捲一次同形）。
 */
export const FIND_STATE_KEY = "kbFind";
export function findTextFromState(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const v = (state as Record<string, unknown>)[FIND_STATE_KEY];
  return typeof v === "string" && v !== "" ? v : null;
}

/** §10.2：找不到區塊時 MutationObserver 等的上限；高亮的時間。 */
export const ANCHOR_WAIT_MS = 2_000;
export const ANCHOR_FLASH_MS = 2_000;
/** 高亮浮層的 class（動畫在 index.css）與屬性（值＝區塊 id，e2e 以它定位）。 */
export const ANCHOR_FLASH_CLASS = "kn-anchor-flash";
export const ANCHOR_FLASH_ATTR = "data-anchor-flash";
/** 搜尋跳轉的常駐標記：同一個浮層加上這個 class（動畫改成閃兩下後停在亮的；index.css）。 */
export const ANCHOR_MARK_CLASS = "kn-anchor-mark";
/** 搜尋標記在捲動穩定之前的狀態（透明、不動畫）；穩定後換成 ANCHOR_MARK_CLASS，動畫才開始（index.css）。 */
export const ANCHOR_PENDING_CLASS = "kn-anchor-pending";
/** 等捲動穩定的上限：超過就不等了直接開始閃（不讓標記永遠不出現）。 */
export const ANCHOR_SETTLE_MAX_MS = 1_000;

/** 只認 `#b-<id>`（`<id>` 合 BLOCK_ANCHOR_RE）；簡報的 `#/…` 與其他 fragment 一律 null。 */
export function blockIdFromHash(hash: string): string | null {
  if (!hash.startsWith("#b-")) return null;
  const id = hash.slice(3);
  return BLOCK_ANCHOR_RE.test(id) ? id : null;
}

/**
 * 高亮浮層掛在哪：從編輯器根（`.ProseMirror`）往外、root 之內第一個 positioned 祖先（NoteEditor／公開頁的文章欄 wrapper 是
 * `relative`）；沒有就 root。浮層必須在 ProseMirror 管的 DOM **之外**：可編輯的編輯器裡，`.bn-block-outer` 上任何外來的屬性變動都會讓
 * ProseMirror 重繪該節點、換掉元素（e2e 實測：設上後約 70 ms 元素就脫離 DOM；唯讀時不換），掛在區塊上的高亮因此看不到。
 * 在捲動容器之內，浮層才會跟著內容一起捲。
 */
function overlayHost(root: HTMLElement, el: HTMLElement): HTMLElement {
  let node = (el.closest(".ProseMirror") ?? el).parentElement;
  while (node && node !== root && root.contains(node)) {
    if (getComputedStyle(node).position !== "static") return node;
    node = node.parentElement;
  }
  return root;
}

/** 把浮層對準 el。座標以浮層自己在 (0,0) 時量到的原點換算——不依賴 host 是不是 containing block、捲到哪。 */
function placeOverlay(overlay: HTMLElement, el: HTMLElement): void {
  overlay.style.top = "0px";
  overlay.style.left = "0px";
  const origin = overlay.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  overlay.style.top = `${rect.top - origin.top}px`;
  overlay.style.left = `${rect.left - origin.left}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
}

/**
 * 在 host 裡疊一層蓋住 el 的高亮浮層。一般錨點的 2 s 高亮只在掛上時量一次位置：期間若版面重排（圖片載入、視窗縮放、協作者在上方插入內容），
 * 浮層可能短暫對不準——接受的取捨（高亮只是提示，不值得為它掛 ResizeObserver／MutationObserver）。常駐標記（搜尋跳轉）不能這樣，
 * 它會自己重新對位，見 `runScroll` 的 `startMark`。
 */
function mountFlashOverlay(root: HTMLElement, el: HTMLElement, blockId: string, pending: boolean): HTMLElement {
  const overlay = document.createElement("div");
  overlay.className = pending ? `${ANCHOR_FLASH_CLASS} ${ANCHOR_PENDING_CLASS}` : ANCHOR_FLASH_CLASS;
  overlay.setAttribute(ANCHOR_FLASH_ATTR, blockId);
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.position = "absolute";
  overlayHost(root, el).appendChild(overlay);
  placeOverlay(overlay, el);
  return overlay;
}

/** block 自己那一行（不含巢狀子 block）；找不到 ＝ null。 */
function contentLine(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>(":scope > .bn-block > .bn-block-content");
}
/**
 * 實際呼叫 `scrollIntoView` 的元素與位置。置中（搜尋跳轉）時對準 block 自己那一行，不是整個 `.bn-block-outer`：清單父項包住很多子項、
 * 展開的 toggle、長程式碼時 outer 比捲動容器高，對它置中會把開頭那一行捲出畫面。那一行本身也比捲動容器高 ⇒ 置中會切掉開頭，退回 `start`
 * （仍對準那一行）。`start`（一般錨點）一律對準 outer，與一向的行為一致。
 */
function scrollPlan(root: HTMLElement, el: HTMLElement, align: ScrollLogicalPosition): { target: HTMLElement; block: ScrollLogicalPosition } {
  if (align !== "center") return { target: el, block: align };
  const line = contentLine(el);
  if (line === null) return { target: el, block: el.getBoundingClientRect().height > root.clientHeight ? "start" : "center" };
  return { target: line, block: line.getBoundingClientRect().height > root.clientHeight ? "start" : "center" };
}

/** 要捲到哪：`block` ＝目標 block（高亮它）；`top` ＝捲回頂端（`_top` 段落找不到命中字）；null ＝還沒好，繼續等。 */
type Resolved = { kind: "block"; el: HTMLElement } | { kind: "top" } | null;

function runScroll(root: HTMLElement, resolve: () => Resolved, align: ScrollLogicalPosition, persist: boolean, scrollOnly = false): () => void {
  let observer: MutationObserver | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let overlay: HTMLElement | null = null;
  let stopMark: (() => void) | null = null;
  const stopWaiting = () => {
    observer?.disconnect();
    observer = null;
    if (waitTimer !== undefined) clearTimeout(waitTimer);
    waitTimer = undefined;
  };
  const removeOverlay = () => {
    if (flashTimer !== undefined) clearTimeout(flashTimer);
    flashTimer = undefined;
    stopMark?.();
    stopMark = null;
    overlay?.remove();
    overlay = null;
  };
  /**
   * 常駐標記（搜尋跳轉）：浮層留著，閃兩下後停在亮的（同一個主色與強度）。取消條件只有三種：Esc、關閉搜尋（`clearSearchMark`）、
   * 被下一次搜尋跳轉取代／離開這篇（呼叫端取消這個 job）。
   *
   * 為什麼用浮層、不用 class／屬性掛在 block 上：可編輯的編輯器裡，`.bn-block-outer` 上任何外來的屬性都會讓 ProseMirror 重繪該節點、
   * 換掉元素（見 `overlayHost`），class 撐不過任何一次重繪。浮層在 ProseMirror 管轄之外，不會被覆蓋、也不會寫進文件；代價是位置要自己維護：
   * MutationObserver（內容變動、協作者的更新）＋ResizeObserver（版面變化）＋視窗縮放，合併成每個 frame 最多重新對位一次，依 `data-id`
   * 重找 block（節點被換掉也找得回）；block 被刪掉就移除標記、不再找。
   */
  const startMark = (host: HTMLElement, blockId: string) => {
    const ac = new AbortController();
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 閃爍等捲動穩定才開始：目標 block 的視窗座標連續兩個 frame 不變（`scrollIntoView` 可能是平滑捲動、筆記剛載入版面還在動；
    // 動畫在捲動途中就播完，使用者看到的就只剩恆亮）。上限 ANCHOR_SETTLE_MAX_MS，不支援 rAF 時用 16 ms 計時器。
    // 開始時只換 class（pending → mark），不重建浮層；之後重新對位只改位置，動畫不會重播或中斷。
    let settleFrame: number | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let settleCap: ReturnType<typeof setTimeout> | undefined;
    const startFlashing = () => {
      if (settleFrame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(settleFrame);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      if (settleCap !== undefined) clearTimeout(settleCap);
      settleFrame = settleTimer = settleCap = undefined;
      host.classList.remove(ANCHOR_PENDING_CLASS);
      host.classList.add(ANCHOR_MARK_CLASS);
    };
    const pos = () => {
      const cur = root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${blockId}"]`);
      const r = cur?.getBoundingClientRect();
      return r ? `${Math.round(r.top)}:${Math.round(r.left)}` : "";
    };
    let last = pos();
    let same = 0;
    const sample = () => {
      settleFrame = settleTimer = undefined;
      const now = pos();
      same = now === last ? same + 1 : 0;
      last = now;
      if (same >= 2) {
        startFlashing();
        return;
      }
      if (typeof requestAnimationFrame === "function") settleFrame = requestAnimationFrame(sample);
      else settleTimer = setTimeout(sample, 16);
    };
    if (typeof requestAnimationFrame === "function") settleFrame = requestAnimationFrame(sample);
    else settleTimer = setTimeout(sample, 16);
    settleCap = setTimeout(startFlashing, ANCHOR_SETTLE_MAX_MS);
    const place = () => {
      frame = undefined;
      timer = undefined;
      const cur = root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${blockId}"]`);
      if (!cur) {
        cancel(); // block 被刪掉了：不再找
        return;
      }
      placeOverlay(host, cur);
    };
    const schedule = () => {
      if (frame !== undefined || timer !== undefined) return;
      if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(place);
      else timer = setTimeout(place, 16);
    };
    const mo = new MutationObserver(schedule);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    ro?.observe(root);
    const editor = root.querySelector(".ProseMirror");
    if (editor) ro?.observe(editor);
    window.addEventListener("resize", schedule, { signal: ac.signal });
    // Esc：讓路條件與 BlockNote blur 的例外都在 `watchSearchEscape`。
    const offEsc = watchSearchEscape(() => cancel());
    stopMark = () => {
      if (settleFrame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(settleFrame);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      if (settleCap !== undefined) clearTimeout(settleCap);
      ac.abort();
      offEsc();
      mo.disconnect();
      ro?.disconnect();
      if (frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
    };
  };
  const hit = (target: Resolved) => {
    if (target === null) return;
    stopWaiting();
    if (target.kind === "top") {
      if (typeof root.scrollTo === "function") root.scrollTo({ top: 0 });
      else root.scrollTop = 0;
      return;
    }
    const el = target.el;
    const plan = scrollPlan(root, el, align);
    plan.target.scrollIntoView({ block: plan.block });
    if (scrollOnly) return; // 等待期間搜尋已被關閉／Esc：照樣捲過去，但不留標記
    const blockId = el.getAttribute("data-id") ?? "";
    const mark = persist && blockId !== "";
    overlay = mountFlashOverlay(root, el, blockId, mark);
    if (mark) {
      startMark(overlay, blockId);
      return;
    }
    overlay.addEventListener("animationend", removeOverlay, { once: true });
    flashTimer = setTimeout(removeOverlay, ANCHOR_FLASH_MS);
  };
  // 搜尋跳轉：從等 block 出現到標記存在的整段期間都聽「關閉搜尋」——還在等的時候關了，不要等 block 出現才又冒出一個標記。
  const offBus = persist ? onSearchMarkClear(() => cancel()) : null;
  function cancel() {
    offBus?.();
    stopWaiting();
    removeOverlay();
  }
  const found = resolve();
  if (found) hit(found);
  else {
    observer = new MutationObserver(() => hit(resolve()));
    observer.observe(root, { childList: true, subtree: true });
    waitTimer = setTimeout(stopWaiting, ANCHOR_WAIT_MS);
  }
  return cancel;
}

/**
 * 在 root 內（任何深度——RF4）找 `.bn-block-outer[data-id="<id>"]`（重複 id 取第一個）；找到就 `scrollIntoView({ block: "start" })`（帶 `findText` 時為 `"center"`）
 * ＋高亮 2 s（ProseMirror 管轄外的浮層，見 `overlayHost`；動畫結束或 2 s 後移除——`prefers-reduced-motion` 沒有動畫，靠計時器）；
 * 找不到用 MutationObserver 等最多 2 s，仍無 ⇒ 不捲、不報錯（停頂端）。id 已過 BLOCK_ANCHOR_RE，不需要 CSS.escape。
 * 回傳取消（清 observer 與計時器、移除浮層）；同一篇再要求錨點時呼叫端先取消上一個，所以畫面上最多一個浮層。
 *
 * `findText`（#93 PR2，側欄搜尋點片段）：段落標題 `blockId` 就緒後，改捲到**該段落範圍內第一個含 `findText` 的 block**（`findMatchBlock`，
 * 比對規則與片段標亮同一支）並高亮它；範圍內找不到 ⇒ 照舊停在段落標題。`blockId` 是 `_top`（筆記開頭、沒有標題）時，編輯器掛上後找；
 * 找不到 ⇒ 捲回頂端。
 */
export function scrollToBlock(root: HTMLElement, blockId: string, findText?: string, scrollOnly = false): () => void {
  // 搜尋跳轉（帶 findText）捲到畫面中間；一般 `#b-` 錨點、wikilink、複製出去的段落連結維持捲到最上面。
  const align: ScrollLogicalPosition = findText === undefined ? "start" : "center";
  const persist = findText !== undefined && !scrollOnly; // 只有搜尋跳轉留常駐標記
  const selector = `.bn-block-outer[data-id="${blockId}"]`;
  if (blockId === TOP_SECTION_ID) {
    return runScroll(root, () => {
      if (topUnits(root) === null) return null; // 編輯器還沒掛上
      const m = findText === undefined ? null : findMatchBlock(root, TOP_SECTION_ID, findText);
      return m ? { kind: "block", el: m } : { kind: "top" };
    }, align, persist, scrollOnly);
  }
  return runScroll(root, () => {
    const heading = root.querySelector<HTMLElement>(selector);
    if (!heading) return null;
    const m = findText === undefined ? null : findMatchBlock(root, blockId, findText);
    return { kind: "block", el: m ?? heading };
  }, align, persist, scrollOnly);
}

/**
 * member 的消耗條件（§10.2）：**這一篇**同步過了（`syncedFor === noteId`），不看 `synced`——A → B 的第一個 commit 帶著 A 的 `synced`
 * 殘值。產品上那個殘值 commit 與 `synced` 等價（pending 的設定與 `setSynced(false)` 落在同一批更新）；被拆掉的舊 provider 也送不出遲到的
 * `"synced"`（真的 `HocuspocusProvider.destroy()` 會 `removeAllListeners`，useCollab 的 cleanup 在 `disposed = true` 後同步呼叫它）。
 * 所以 `syncedFor` 是 spec rev 5 定的**防禦性**逐篇就緒條件：不依賴 provider 監聽器的拆除紀律。W8 跨篇案能分出它與 `synced` 的差別，
 * 靠的是假 provider 的 `destroy` 不清監聽器（測試裡才有的遲到事件）。
 */
export function memberAnchorReady(s: { syncedFor: string | null; noteId: string | undefined }): boolean {
  return s.syncedFor !== null && s.noteId !== undefined && s.syncedFor === s.noteId;
}

export interface MemberBlockAnchorOptions {
  noteId: string | undefined;
  /** useCollab 的回傳（`synced` 刻意傳進來但不用——§15.4 的突變「改回只看 synced」就是把下面的 ready 換成它）。 */
  collab: { synced: boolean; syncedFor: string | null };
  root: HTMLElement | null;
  presenting: boolean;
}

/** NotePage 的段落錨點組合（plan gate r1 I2：抽成正式 hook，NotePage 與 W8 的 Host 呼叫同一支）。 */
export function useMemberBlockAnchor(opts: MemberBlockAnchorOptions): BlockAnchorApi {
  return useBlockAnchor({
    noteKey: opts.noteId,
    ready: memberAnchorReady({ syncedFor: opts.collab.syncedFor, noteId: opts.noteId }),
    root: opts.root,
    ignore: opts.presenting,
    currentNoteId: opts.noteId ?? null,
  });
}

export interface UseBlockAnchorOptions {
  /** member＝有效 note id（解析中 undefined）；公開頁＝公開 ref 的識別字串。 */
  noteKey: string | undefined;
  /** 這一篇可以渲染了（member：memberAnchorReady；公開頁：doc 解碼完成）。 */
  ready: boolean;
  /** 捲動容器（NoteEditor 的內層 overflow-y-auto；公開頁的內文容器）。 */
  root: HTMLElement | null;
  /** 簡報播放中（`?present`）忽略 `#b-`。 */
  ignore?: boolean;
  currentNoteId: string | null;
}

/**
 * #269 §10.2：每篇一個「待處理錨點」。設定只有兩種時機——首次掛載／`noteKey` 改變時讀當下的 `location.hash`、或 `requestAnchor`。
 * 不看 `location.key`、不看 navigation type；其他 location 變化（同篇 REPLACE／POP、modal、query）都不設定 ⇒ 不重捲、不重閃。
 * NotePage 不隨筆記重掛（App.tsx 共用實例），所以「noteKey 改變」而非「掛載」才是跨篇的觸發點。
 */
export function useBlockAnchor(opts: UseBlockAnchorOptions): BlockAnchorApi {
  const location = useLocation();
  const hashRef = useRef(location.hash);
  hashRef.current = location.hash;
  const ignoreRef = useRef(opts.ignore ?? false);
  ignoreRef.current = opts.ignore ?? false;
  const noteKeyRef = useRef(opts.noteKey);
  noteKeyRef.current = opts.noteKey;
  const stateRef = useRef(location.state);
  stateRef.current = location.state;
  const [pending, setPending] = useState<{ noteKey: string; blockId: string; findText?: string } | null>(null);

  const lastKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (opts.noteKey === undefined) return; // 解析中：不設定、不消耗
    if (lastKeyRef.current === opts.noteKey) return;
    lastKeyRef.current = opts.noteKey;
    const findText = ignoreRef.current ? null : findTextFromState(stateRef.current);
    // 搜尋點到 `_top` 片段的別篇導覽沒有 hash，只有 state：段落＝`_top`。
    const id = ignoreRef.current ? null : (blockIdFromHash(hashRef.current) ?? (findText === null ? null : TOP_SECTION_ID));
    setPending(id === null ? null : { noteKey: opts.noteKey, blockId: id, ...(findText === null ? {} : { findText }) });
  }, [opts.noteKey]);

  // 兩個槽：`jobRef` ＝一般錨點的 2 s 高亮；`markRef` ＝搜尋跳轉的常駐標記。分開，才不會讓筆記內的 wikilink／`#b-` 點擊把搜尋標記清掉
  // （標記只由 Esc、關閉搜尋、下一次搜尋跳轉、離開這篇取消）。
  const jobRef = useRef<(() => void) | null>(null);
  const markRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      jobRef.current?.();
      markRef.current?.();
    },
    [],
  );
  // 離開這篇（noteKey 改變）：標記跟著消失，不留在別篇。NotePage 不隨筆記重掛，所以要在這裡清。
  useEffect(
    () => () => {
      markRef.current?.();
      markRef.current = null;
    },
    [opts.noteKey],
  );
  // 搜尋跳轉等筆記就緒（collab 同步）的期間也要聽「關閉搜尋」與 Esc：此時還沒有標記可清，記下來，就緒後照樣捲過去、但不留標記。
  const abandonedRef = useRef(false);
  useEffect(() => {
    if (pending === null || pending.findText === undefined) return;
    abandonedRef.current = false;
    const abandon = () => {
      abandonedRef.current = true;
    };
    const offBus = onSearchMarkClear(abandon);
    const offEsc = watchSearchEscape(abandon);
    return () => {
      offBus();
      offEsc();
    };
  }, [pending]);
  useEffect(() => {
    if (pending === null || opts.noteKey === undefined || pending.noteKey !== opts.noteKey || !opts.ready || opts.root === null) return;
    if (pending.findText === undefined) {
      jobRef.current?.();
      jobRef.current = scrollToBlock(opts.root, pending.blockId);
    } else {
      // 再點另一個搜尋結果：舊標記移除、換到新的位置。
      markRef.current?.();
      markRef.current = scrollToBlock(opts.root, pending.blockId, pending.findText, abandonedRef.current);
      abandonedRef.current = false;
    }
    setPending(null);
  }, [pending, opts.noteKey, opts.ready, opts.root]);

  const requestAnchor = useCallback((blockId: string, findText?: string) => {
    const key = noteKeyRef.current;
    if (key === undefined || !BLOCK_ANCHOR_RE.test(blockId)) return;
    setPending({ noteKey: key, blockId, ...(findText === undefined || findText === "" ? {} : { findText }) });
  }, []);

  const rootRef = useRef(opts.root);
  rootRef.current = opts.root;
  const scrollToTop = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    if (typeof root.scrollTo === "function") root.scrollTo({ top: 0 });
    else root.scrollTop = 0;
  }, []);

  return useMemo(() => ({ currentNoteId: opts.currentNoteId, requestAnchor, scrollToTop }), [opts.currentNoteId, requestAnchor, scrollToTop]);
}
