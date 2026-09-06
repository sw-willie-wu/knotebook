// 實作等級：full（Task 1 spike：四個探針全綠，游標真的解回目標 block）。
import { createHash } from "node:crypto";
import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { YDOC_FRAGMENT, sectionize, topLevelContainers, type EditOp } from "@knotebook/shared";
import type { CollabContext } from "../../collab/server.js";

// D8：只對已載入文件掛 awareness，直接發事件（clock 不大於 meta 的項目會被整筆跳過，
// y-protocols/awareness.js:256；Hocuspocus 的 handleAwarenessUpdate 再重新編碼廣播）。
// ⚠ clocks 是**模組層**、process 生命週期、永不修剪：provider 在 removal 後仍保留 meta 的
// clock（awareness.js:269-272），重新起算的計數會被靜默丟棄＝閒置停止後 AI 再也不現身。
// 守衛：test/unit/editing-presence.test.ts 的「clock map 是 process 生命週期」那一案（唯一一個）。
// ⚠ state 一定要帶 `beat`：change 只在 state 深度不等時才發（awareness.js:278），而名牌只吃
// change 的 `updated`（@blocknote/core/dist/yjs.js:80）——少了它，名牌一次都不會亮。
// 每個 beat 都重取 documents.get，絕不快取 Awareness（unload 會 destroy、reload 是新物件）。
const clocks = new Map<number, number>();
const ORIGIN = "ai-presence";
export const PRESENCE_COLOR = "#7c3aed";

export function presenceClientId(noteId: string, tokenId: string): number {
  return createHash("sha256").update(noteId + tokenId).digest().readUInt32BE(0);
}

export type PresenceTarget =
  | { kind: "section"; sectionId: string }
  | { kind: "block"; blockId: string }
  | { kind: "doc-start" };

/** spec §9：`?section=` 讀 → 該段第一顆；整篇讀 → 文件開頭。讀取不動結構，用 sectionId 是安全的。 */
export function presenceTargetForRead(section: string | undefined): PresenceTarget {
  return section === undefined ? { kind: "doc-start" } : { kind: "section", sectionId: section };
}

/**
 * spec §9：段落寫入 → 該段第一顆；`replace_all` → 文件第一顆。
 * ⚠ **只吃編輯後的 `afterBlockIds`，絕不吃請求帶進來的 `section_id`**：section_id 就是 heading
 * 那顆 block 的 id，而 replace_section／delete_section 連 heading 一起換掉（apply.ts 的
 * `ed.replaceBlocks(sectionIds, …)`），編輯完成後它已不存在——拿它去查會靜默退回文件開頭。
 * `afterBlockIds[0]` 就是這次寫下去的第一顆 block，四個 op 一致；delete_section 的 afterIds
 * 恆為空（該段已刪，沒有落點）→ 文件開頭。
 * ⚠ **刻意偏離 spec §9 的只有 `insert_after` 一個 op**：spec 的字面是「定到該段的 heading」，
 * 這裡落在**剛插入的第一顆**。理由是簽章裡刻意沒有 sectionId 參數（見上），而使用者要看的本來
 * 就是 AI 剛寫下的那一顆；其餘四個 op 的結果與 spec 逐字相同。plan 與 spec 都不進版控，所以
 * 這個偏離只有這段註解留得下來——不要當成 bug「修」回去。
 */
export function presenceTargetForWrite(op: EditOp, afterBlockIds: readonly string[]): PresenceTarget {
  if (op === "replace_all") return { kind: "doc-start" }; // spec §9 明文：整篇取代 → 文件第一顆
  const first = afterBlockIds[0];
  return first === undefined ? { kind: "doc-start" } : { kind: "block", blockId: first };
}

export interface PresenceOptions { now?: () => number; capacity?: number; idleMs?: number; heartbeatMs?: number }
interface Entry {
  noteId: string; tokenId: string; clientId: number;
  user: { name: string; color: string }; target: PresenceTarget; lastBeat: number;
  timer: ReturnType<typeof setInterval>; idle: ReturnType<typeof setTimeout>;
}

export class PresenceRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly hocuspocus: Hocuspocus<CollabContext> | undefined;
  private readonly now: () => number;
  readonly capacity: number;
  private readonly idleMs: number;
  private readonly heartbeatMs: number;

  constructor(hocuspocus: Hocuspocus<CollabContext> | undefined, opts: PresenceOptions = {}) {
    this.hocuspocus = hocuspocus;
    this.now = opts.now ?? Date.now;
    this.capacity = opts.capacity ?? 500;
    this.idleMs = opts.idleMs ?? 120_000;
    // ⚠ 心跳可以縮短、**絕不可放大**：對端 y-protocols 的 outdatedTimeout 是寫死的 30 s，
    // 不會跟著這個值走，放大到 30 s 以上就是瀏覽器把 AI 掃掉（實測 10 s / 30 s 這個比例可行）。
    this.heartbeatMs = opts.heartbeatMs ?? 10_000;
  }
  get size(): number { return this.entries.size; }

  private bump(clientId: number): number {
    const n = (clocks.get(clientId) ?? 0) + 1;
    clocks.set(clientId, n);
    return n;
  }

  /** ⚠ 回的是 `Y.relativePositionToJSON(...)` 的 JSON 物件，**不是 yjs 那支回 `Uint8Array` 的
   *  編碼版**（awareness 傳輸會 JSON.stringify，消費端 y-prosemirror 讀的是
   *  `createRelativePositionFromJSON`；送錯形會在裝飾計算裡丟 "Unexpected case"）。
   *  驗收 grep 要求整個 apps/server 完全不出現那個編碼函式名，所以這裡刻意不寫出它。 */
  private cursorFor(doc: Y.Doc, target: PresenceTarget): { anchor: unknown; head: unknown } | null {
    const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
    const containers = topLevelContainers(fragment);
    const byId = (id: string | undefined) => containers.find(c => c.getAttribute("id") === id);
    let block = containers[0];
    if (target.kind === "section") {
      // 零 block `_top`（筆記以 heading 開頭）→ blockIds[0] 是 undefined → 退文件開頭
      block = byId(sectionize(fragment).find(s => s.sectionId === target.sectionId)?.blockIds[0]) ?? block;
    } else if (target.kind === "block") {
      // 併發：這一顆可能在我們 emit 之前又被別人改掉了 → 退文件開頭，不丟錯
      block = byId(target.blockId) ?? block;
    }
    // ⚠ 兩層都要判型，但兩層擋的是**不同**情境（實測用真 BlockNote 文件量過，見下）：
    // 第一層（`content instanceof Y.XmlElement`）擋的是**文件連一顆頂層容器都沒有**——尚未被
    // 任何用戶端寫入的空文件，`topLevelContainers` 回 `[]`，`block` 是 `undefined`，於是
    // `content` 也是 `undefined`。拿掉這層、直接呼叫 `content.get(0)`，會在**這裡**（伺服器端
    // `cursorFor` 本身，touch/emit 呼叫進來的同步呼叫鏈）丟
    // `TypeError: Cannot read properties of undefined (reading 'get')`——這是可達的正式情境
    // （筆記剛建立、還沒有人打過字）。這跟 Task 1 spike 講的「錯誤編碼形在裝飾計算裡丟錯」是
    // **兩個不同機制**：spike 那條是游標的**編碼形式**在**用戶端** y-prosemirror 的裝飾計算裡
    // 丟錯；這裡是**完全沒有頂層容器**在**伺服器端**因為呼叫在 `undefined` 上取子節點而丟錯。
    // 圖片、分隔線這類「非文字」block **不是**這一層要擋的對象：容器的第一個子節點就是那顆
    // 內容元素本身（例如 `<blockContainer><image .../></blockContainer>`），`content` 非
    // `undefined`，只是長度為 0——是**第二層**（`text instanceof Y.XmlText`）安靜擋下它們、
    // 回空值、不丟錯（`content.get(0)` 在 0 長度的元素上安全回 `undefined`）。
    // 守衛＝本檔（`editing-presence.test.ts`）除「目標推導」與「clientId 穩定」外的其餘 6 案
    // （不含「表格」那一案）——只拿掉第一層會讓這 6 案在 touch() 內同步丟出上述例外；「表格」
    // 那一案因為文件裡確實有頂層容器，不受第一層影響，仍然綠。第二層另有窄化守衛：若只判
    // `!== undefined`（表格這類「有子節點但子節點是元素」的窄縫——`<table><tableRow>…`，
    // `table.get(0)` 是 `tableRow` 這個 `Y.XmlElement`，不是 `undefined` 也不是文字），不丟錯
    // 但會塞一個指向元素而非文字節點的型別錯誤 cursor 進 awareness state，見「內容的第一個
    // 子節點是元素而非文字」那一案。
    const content = block?.get(0);
    const text = content instanceof Y.XmlElement ? content.get(0) : undefined;
    if (!(text instanceof Y.XmlText)) return null;
    const rel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 0));
    return { anchor: rel, head: rel };
  }

  private emit(entry: Entry, kind: "added" | "updated" | "removed"): void {
    const doc = this.hocuspocus?.documents.get(entry.noteId);
    if (!doc) return; // 未載入／已 unload：沒有人看得到，也沒有 Awareness 可寫
    const clock = this.bump(entry.clientId);
    if (kind === "removed") {
      doc.awareness.states.delete(entry.clientId);
    } else {
      // ⚠ `beat: clock` 不是裝飾品：state 深度相等時 provider 不發 change，BlockNote 的名牌
      //   就永遠不會亮（Global Constraints 專條）。守衛＝單元檔的「state 深度不等」那一案。
      const cursor = this.cursorFor(doc, entry.target);
      doc.awareness.states.set(entry.clientId, { user: entry.user, beat: clock, ...(cursor ? { cursor } : {}) });
    }
    doc.awareness.meta.set(entry.clientId, { clock, lastUpdated: this.now() });
    doc.awareness.emit("update", [{
      added: kind === "added" ? [entry.clientId] : [],
      updated: kind === "updated" ? [entry.clientId] : [],
      removed: kind === "removed" ? [entry.clientId] : [],
    }, ORIGIN]);
  }

  touch(noteId: string, tokenId: string, user: { name: string; color: string }, target: PresenceTarget): void {
    if (!this.hocuspocus?.documents.get(noteId)) return; // 未載入＝沒人看得到
    const key = `${noteId}:${tokenId}`;
    const existing = this.entries.get(key);
    if (existing) {
      existing.user = user; existing.target = target; existing.lastBeat = this.now();
      clearTimeout(existing.idle);
      existing.idle = setTimeout(() => this.stop(noteId, tokenId), this.idleMs);
      this.emit(existing, "updated");
      return;
    }
    if (this.entries.size >= this.capacity) {
      const oldest = [...this.entries.values()].sort((a, b) => a.lastBeat - b.lastBeat)[0]!;
      this.stop(oldest.noteId, oldest.tokenId);
    }
    const entry = { noteId, tokenId, clientId: presenceClientId(noteId, tokenId), user, target, lastBeat: this.now() } as Entry;
    entry.timer = setInterval(() => { entry.lastBeat = this.now(); this.emit(entry, "updated"); }, this.heartbeatMs);
    entry.idle = setTimeout(() => this.stop(noteId, tokenId), this.idleMs);
    this.entries.set(key, entry);
    this.emit(entry, "added");
  }

  stop(noteId: string, tokenId: string): void {
    const entry = this.entries.get(`${noteId}:${tokenId}`);
    if (!entry) return;
    clearInterval(entry.timer);
    clearTimeout(entry.idle);
    this.entries.delete(`${noteId}:${tokenId}`);
    this.emit(entry, "removed");
  }

  stopAll(): void { for (const e of [...this.entries.values()]) this.stop(e.noteId, e.tokenId); }
}
