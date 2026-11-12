/**
 * 功能導覽要指的畫面元素，一律靠元件上的 `data-kb-tour-target` 屬性找，不比可及名稱或文字：
 * 側欄裡到處是使用者自己取的名字（資料夾、筆記標題，選取模式的資料夾鈕還拿資料夾名當 `aria-label`），
 * 用名稱找遲早會撞到。屬性只掛在真正的目標元件上（`tourTarget(id)` 展開到元件的 props），使用者內容不會帶它。
 *
 * 站點表（`components/tour/stops.ts`）用這支，結束導覽後找回使用者選單觸發鈕也用這支。這支只 import React 與首包本來就有的
 * 寬窄判準常數，首包的元件可以直接用 `tourTarget`。
 *
 * 導覽的寬窄判準也只住在這裡（`isNarrowViewport`，要跟著視窗變化重畫的元件用 `useIsNarrowViewport`）：站點表、引擎、
 * 卡片的窄視窗補句、結束後找焦點都從這裡取，不各自寫 `matchMedia`，判準要換時只改這一處。
 *
 * 每次呼叫都重查 DOM：AppShell 會隨首頁↔筆記頁、筆記頁整頁載入換殼，先前查到的元素可能已經卸載。
 */

import { useSyncExternalStore } from "react";
import { NARROW_QUERY } from "@/lib/sidebar-drawer";

export type TourTargetId =
  | "tabs"
  | "newNote"
  | "newFolder"
  | "search"
  | "share"
  | "noteMenu"
  | "versions"
  | "userMenu"
  | "drawerButton"
  | "suggestionMenu"
  | "wikilink";

const ATTR = "data-kb-tour-target";

/** 展開到目標元件的 props：`<Button {...tourTarget("newNote")}>`。 */
export function tourTarget(id: TourTargetId): { "data-kb-tour-target": TourTargetId } {
  return { "data-kb-tour-target": id };
}

/**
 * 第一個帶這個屬性、而且不在 `aria-hidden="true"` 或 `inert` 範圍內的元素。
 * 側欄有固定卡片與抽屜兩份，屬性兩份都有：抽屜開著時，Radix 會把抽屜以外的整棵樹標成 `aria-hidden`，
 * 所以拿到的是抽屜那份；抽屜關著時只剩固定卡片那份。CSS 造成的不可見（窄視窗下的固定卡片是 `display: none`）
 * 這裡不判斷，導覽另外看元素尺寸。
 */
export function findTourTarget(id: TourTargetId, root: ParentNode = document): Element | null {
  for (const el of root.querySelectorAll(`[${ATTR}="${id}"]`)) {
    if (el.closest('[aria-hidden="true"], [inert]') === null) return el;
  }
  return null;
}

/** 開抽屜的漢堡鈕：在筆記頁頁首，或沒有頁首的頁面上的窄版頂列（同一時間只會掛其中一顆）。 */
export function findDrawerButton(): Element | null {
  return findTourTarget("drawerButton");
}

/** 使用者選單觸發鈕（寬視窗在側欄卡片底部；抽屜開著時是抽屜裡那顆）。 */
export function findUserMenuTrigger(): Element | null {
  return findTourTarget("userMenu");
}

/** 導覽的寬窄判準：窄＝側欄是抽屜。 */
export function isNarrowViewport(): boolean {
  return window.matchMedia(NARROW_QUERY).matches;
}

function subscribeNarrowViewport(onChange: () => void): () => void {
  const mql = window.matchMedia(NARROW_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** 同 `isNarrowViewport`，視窗跨過判準時重畫。 */
export function useIsNarrowViewport(): boolean {
  return useSyncExternalStore(subscribeNarrowViewport, isNarrowViewport, () => false);
}

/**
 * 導覽結束後要聚焦的使用者選單觸發鈕（傳給 `start` 的 `returnFocus`）：寬視窗是側欄卡片底部的帳號列；
 * 窄視窗的使用者選單在已經關掉的抽屜裡，改回開抽屜的漢堡鈕。
 */
export function findUserMenuReturnTarget(): Element | null {
  return isNarrowViewport() ? findDrawerButton() : findUserMenuTrigger();
}
