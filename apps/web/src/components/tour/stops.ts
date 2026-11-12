import type { AiActionDto } from "@knotebook/shared";
import type { TFunction } from "i18next";
import "@/i18n/tour-strings";
import { isMacPlatform } from "@/lib/platform";
import { getShellControls, getTourNoteEditor } from "@/lib/tour-bridge";
import { findDrawerButton, findTourTarget, findUserMenuTrigger, isNarrowViewport } from "@/lib/tour-targets";
import {
  findInSampleEditor,
  liveSelectionTarget,
  liveTriggerTarget,
  startLiveSelection,
  startLiveTrigger,
  stopLiveSelection,
  stopLiveTrigger,
} from "./live-stops";

/**
 * 功能導覽的站點表。每站說明要指哪裡（`target`）、要先做什麼（`prepare`）、什麼情況下整站不跑（`precondition`）。
 *
 * - 目標一律靠元件上的 `data-kb-tour-target` 屬性找（`lib/tour-targets.ts`），不比名稱：側欄裡到處是使用者自己取的名字。
 *   每次都重新查 DOM：AppShell 會隨首頁↔筆記頁、筆記頁整頁載入換殼，先前查到的元素可能已經卸載。
 * - 現場演示站（`live`）在示範筆記的編輯器裡叫出真的選單，細節見 `live-stops.ts`；它們的 `leave` 負責收掉選單與過濾。
 * - 窄視窗的側欄收在抽屜裡。抽屜是會鎖焦點、把外面標成 `aria-hidden` 的 modal，開著時導覽卡片按不到，
 *   所以側欄裡的站改指頁首的漢堡鈕，也不跑 `prepare`（切 tab 在窄視窗會順便打開抽屜）。
 */

export type StopId = "tabs" | "newNote" | "folders" | "search" | "header" | "versions" | "wikilink" | "ai" | "slash" | "userMenu";

export interface StopContext {
  /** 側欄搜尋框目前的字。 */
  searchQuery: string;
  /**
   * 開始時向 server 讀到的 AI 動作（`GET /api/ai/actions`；讀取失敗是空陣列）。不讀查詢快取：
   * 從首頁打開時快取還沒有資料，看快取會把站台有設定 AI 誤判成沒有。
   */
  aiActions: readonly AiActionDto[];
  /** 示範筆記的 id：現場演示只動這一篇的編輯器。 */
  sampleNoteId: string;
  /**
   * 開始時算一次：能不能在示範筆記上現場演示（編輯器可編輯、最後一段是空段落，見 `canRunLiveStop`）。
   * 不能的演示站改指筆記裡現成的成品，靜態說明。
   */
  liveStops: boolean;
}

export interface StopDef {
  id: StopId;
  titleKey: string;
  bodyKey: string;
  /** 窄視窗改用的說明；沒有就沿用 `bodyKey`。 */
  narrowBodyKey?: string;
  /** 要挖亮的元素；多個時挖洞取它們的聯集。找不到回空陣列。 */
  target: (ctx: StopContext) => Element[];
  /** 窄視窗改指的元素；沒有就沿用 `target`。 */
  narrowTarget?: (ctx: StopContext) => Element[];
  /** 找目標之前要做的事（只在寬視窗跑，見 `prepareStop`）。 */
  prepare?: (ctx: StopContext) => void;
  /** 開始時算一次；不成立的站整站不跑、不算進總站數。 */
  precondition?: (ctx: StopContext) => boolean;
  /**
   * 離開這一站時要收拾的東西（例如演示開的選單）。引擎開始進這一站就會呼叫恰好一次：
   * 下一步、上一步、等不到目標而跳過、結束、卸載、位置離開示範筆記都算。窄視窗不跑 `prepare`，
   * 但 `leave` 照樣會被呼叫，所以它要能在 `prepare` 沒跑過時安全執行。拋錯只記到 console，不擋換站。
   */
  leave?: (ctx: StopContext) => void;
  /**
   * 這一站在這一輪是不是現場演示。是的話：卡片不搶焦點（焦點留在編輯器，選單才不會關）、導覽攔鍵盤與選單上的點擊，
   * `→`／`Enter` 下一步、`←` 上一步。沒有這個欄位＝一般靜態站。
   */
  live?: (ctx: StopContext) => boolean;
  /** 窄視窗也跑 `prepare`。預設不跑（理由見檔頭）；演示站在編輯器裡、不碰側欄，所以跑。 */
  prepareInNarrow?: boolean;
}

export { isNarrowViewport };

/** 全部都找到才算找到：只挖亮其中一部分會讓說明對不上。 */
function all(...els: (Element | null)[]): Element[] {
  return els.every((el) => el !== null) ? (els as Element[]) : [];
}

const drawerButton = () => all(findDrawerButton());
const noteMenu = () => findTourTarget("noteMenu");

/** 搜尋中側欄的 tab 列與標題列都不渲染（換成搜尋結果）；不替使用者清掉搜尋字，所以整站不跑。空白也算搜尋中。 */
const searchIsEmpty = (ctx: StopContext) => ctx.searchQuery === "";

/** 「新增筆記」只在我的筆記／最近 tab 出現，「新增資料夾」在我的筆記標題列；選取模式中兩者都會被換掉。 */
function showMyNotes(): void {
  const shell = getShellControls();
  shell?.showTab("myNotes");
  shell?.endSelectionIfActive();
}

export const STOPS: Readonly<Record<StopId, StopDef>> = {
  tabs: {
    id: "tabs",
    titleKey: "tourGuide.stops.tabs.title",
    bodyKey: "tourGuide.stops.tabs.body",
    narrowBodyKey: "tourGuide.stops.tabs.narrowBody",
    target: () => all(findTourTarget("tabs")),
    narrowTarget: drawerButton,
    precondition: searchIsEmpty,
  },
  newNote: {
    id: "newNote",
    titleKey: "tourGuide.stops.newNote.title",
    bodyKey: "tourGuide.stops.newNote.body",
    narrowBodyKey: "tourGuide.stops.newNote.narrowBody",
    target: () => all(findTourTarget("newNote")),
    narrowTarget: drawerButton,
    prepare: showMyNotes,
  },
  folders: {
    id: "folders",
    titleKey: "tourGuide.stops.folders.title",
    bodyKey: "tourGuide.stops.folders.body",
    narrowBodyKey: "tourGuide.stops.folders.narrowBody",
    target: () => all(findTourTarget("newFolder")),
    narrowTarget: drawerButton,
    prepare: showMyNotes,
    precondition: searchIsEmpty,
  },
  search: {
    id: "search",
    titleKey: "tourGuide.stops.search.title",
    bodyKey: "tourGuide.stops.search.body",
    narrowBodyKey: "tourGuide.stops.search.narrowBody",
    target: () => all(findTourTarget("search")),
    narrowTarget: drawerButton,
    precondition: searchIsEmpty,
  },
  header: {
    id: "header",
    titleKey: "tourGuide.stops.header.title",
    bodyKey: "tourGuide.stops.header.body",
    target: () => all(findTourTarget("share"), noteMenu()),
  },
  versions: {
    id: "versions",
    titleKey: "tourGuide.stops.versions.title",
    bodyKey: "tourGuide.stops.versions.body",
    narrowBodyKey: "tourGuide.stops.versions.narrowBody",
    target: () => all(findTourTarget("versions")),
    // 窄視窗沒有右下角的泡泡，版本歷史在頁首 ⋮ 裡。
    narrowTarget: () => all(noteMenu()),
  },
  wikilink: {
    id: "wikilink",
    titleKey: "tourGuide.stops.wikilink.title",
    bodyKey: "tourGuide.stops.wikilink.body",
    target: (ctx) => liveTriggerTarget(ctx.sampleNoteId, "[[", "wikilinkMenu", "wikilink"),
    prepare: (ctx) => {
      if (ctx.liveStops) startLiveTrigger(ctx.sampleNoteId, "[[");
    },
    prepareInNarrow: true,
    leave: (ctx) => stopLiveTrigger(ctx.sampleNoteId),
    live: (ctx) => ctx.liveStops,
  },
  ai: {
    id: "ai",
    titleKey: "tourGuide.stops.ai.title",
    bodyKey: "tourGuide.stops.ai.body",
    target: () => liveSelectionTarget(),
    prepare: (ctx) => startLiveSelection(ctx.sampleNoteId),
    prepareInNarrow: true,
    leave: (ctx) => stopLiveSelection(ctx.sampleNoteId),
    // 站台沒有設定 AI 就整站略過（AI 工具列不會出現）。
    precondition: (ctx) => ctx.aiActions.length > 0,
    // 只選取、不需要空段落，所以不看 `liveStops`；拿不到示範筆記的編輯器就不是演示。
    live: (ctx) => getTourNoteEditor(ctx.sampleNoteId) !== null,
  },
  slash: {
    id: "slash",
    titleKey: "tourGuide.stops.slash.title",
    bodyKey: "tourGuide.stops.slash.body",
    target: (ctx) => {
      const base = liveTriggerTarget(ctx.sampleNoteId, "/", "slashMenu", "flowchart");
      if (base.length === 0) return base;
      // 選單旁邊一起挖亮筆記裡用 `/` 插的流程圖；筆記裡沒有流程圖就只挖亮選單。
      const chart = findInSampleEditor(ctx.sampleNoteId, "flowchart");
      return chart === null || base.includes(chart) ? base : [...base, chart];
    },
    prepare: (ctx) => {
      if (ctx.liveStops) startLiveTrigger(ctx.sampleNoteId, "/");
    },
    prepareInNarrow: true,
    leave: (ctx) => stopLiveTrigger(ctx.sampleNoteId),
    live: (ctx) => ctx.liveStops,
  },
  userMenu: {
    id: "userMenu",
    titleKey: "tourGuide.stops.userMenu.title",
    bodyKey: "tourGuide.stops.userMenu.body",
    narrowBodyKey: "tourGuide.stops.userMenu.narrowBody",
    target: () => all(findUserMenuTrigger()),
    narrowTarget: drawerButton,
  },
};

/** 完整導覽的站序；最後一站固定是 userMenu。 */
export const FULL_TOUR: readonly [StopId, ...StopId[]] = ["tabs", "newNote", "folders", "search", "header", "versions", "wikilink", "ai", "slash", "userMenu"];

/** 依目前視窗寬窄找目標。 */
export function stopTarget(stop: StopDef, ctx: StopContext): Element[] {
  return (isNarrowViewport() && stop.narrowTarget !== undefined ? stop.narrowTarget : stop.target)(ctx);
}

/** `narrow` 預設當下讀一次；元件訂閱寬窄變化時把訂閱到的值傳進來。不 export：呼叫端一律走 `stopBody`，才不會漏帶 `{{mod}}`。 */
function stopBodyKey(stop: StopDef, narrow: boolean = isNarrowViewport()): string {
  return narrow && stop.narrowBodyKey !== undefined ? stop.narrowBodyKey : stop.bodyKey;
}

/** 說明文字：快捷鍵的修飾鍵由 `{{mod}}` 帶入（Mac 是 `⌘`，其他是 `Ctrl+`）。 */
export function stopBody(t: TFunction, stop: StopDef, narrow: boolean = isNarrowViewport()): string {
  return t(stopBodyKey(stop, narrow), { mod: isMacPlatform() ? "⌘" : "Ctrl+" });
}

/** 跑站點的前置動作；窄視窗不跑，除非站點自己說要跑（見檔頭）。 */
export function prepareStop(stop: StopDef, ctx: StopContext): void {
  if (isNarrowViewport() && stop.prepareInNarrow !== true) return;
  stop.prepare?.(ctx);
}
