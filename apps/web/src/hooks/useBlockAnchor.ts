import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { BLOCK_ANCHOR_RE } from "@knotebook/shared";
import type { BlockAnchorApi } from "./block-anchor-context";

/** §10.2：找不到區塊時 MutationObserver 等的上限；高亮的時間。 */
export const ANCHOR_WAIT_MS = 2_000;
export const ANCHOR_FLASH_MS = 2_000;
export const ANCHOR_FLASH_ATTR = "data-anchor-flash";

/** 只認 `#b-<id>`（`<id>` 合 BLOCK_ANCHOR_RE）；簡報的 `#/…` 與其他 fragment 一律 null。 */
export function blockIdFromHash(hash: string): string | null {
  if (!hash.startsWith("#b-")) return null;
  const id = hash.slice(3);
  return BLOCK_ANCHOR_RE.test(id) ? id : null;
}

/**
 * 在 root 內（任何深度——RF4）找 `.bn-block-outer[data-id="<id>"]`（重複 id 取第一個）；找到就 `scrollIntoView({ block: "start" })`
 * ＋高亮 2 s；找不到用 MutationObserver 等最多 2 s，仍無 ⇒ 不捲、不報錯（停頂端）。id 已過 BLOCK_ANCHOR_RE，不需要 CSS.escape。
 * 回傳取消（清 observer 與計時器、拿掉高亮）。
 */
export function scrollToBlock(root: HTMLElement, blockId: string): () => void {
  const selector = `.bn-block-outer[data-id="${blockId}"]`;
  let observer: MutationObserver | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let flashed: HTMLElement | null = null;
  const stopWaiting = () => {
    observer?.disconnect();
    observer = null;
    if (waitTimer !== undefined) clearTimeout(waitTimer);
    waitTimer = undefined;
  };
  const hit = (el: HTMLElement) => {
    stopWaiting();
    el.scrollIntoView({ block: "start" });
    el.setAttribute(ANCHOR_FLASH_ATTR, "");
    flashed = el;
    flashTimer = setTimeout(() => {
      el.removeAttribute(ANCHOR_FLASH_ATTR);
      flashed = null;
    }, ANCHOR_FLASH_MS);
  };
  const found = root.querySelector<HTMLElement>(selector);
  if (found) hit(found);
  else {
    observer = new MutationObserver(() => {
      const el = root.querySelector<HTMLElement>(selector);
      if (el) hit(el);
    });
    observer.observe(root, { childList: true, subtree: true });
    waitTimer = setTimeout(stopWaiting, ANCHOR_WAIT_MS);
  }
  return () => {
    stopWaiting();
    if (flashTimer !== undefined) clearTimeout(flashTimer);
    flashed?.removeAttribute(ANCHOR_FLASH_ATTR);
  };
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
  const [pending, setPending] = useState<{ noteKey: string; blockId: string } | null>(null);

  const lastKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (opts.noteKey === undefined) return; // 解析中：不設定、不消耗
    if (lastKeyRef.current === opts.noteKey) return;
    lastKeyRef.current = opts.noteKey;
    const id = ignoreRef.current ? null : blockIdFromHash(hashRef.current);
    setPending(id === null ? null : { noteKey: opts.noteKey, blockId: id });
  }, [opts.noteKey]);

  const jobRef = useRef<(() => void) | null>(null);
  useEffect(() => () => jobRef.current?.(), []);
  useEffect(() => {
    if (pending === null || opts.noteKey === undefined || pending.noteKey !== opts.noteKey || !opts.ready || opts.root === null) return;
    jobRef.current?.();
    jobRef.current = scrollToBlock(opts.root, pending.blockId);
    setPending(null);
  }, [pending, opts.noteKey, opts.ready, opts.root]);

  const requestAnchor = useCallback((blockId: string) => {
    const key = noteKeyRef.current;
    if (key === undefined || !BLOCK_ANCHOR_RE.test(blockId)) return;
    setPending({ noteKey: key, blockId });
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
