import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import {
  PresenceRegistry, presenceClientId, presenceTargetForRead, presenceTargetForWrite,
} from "../../src/notes/editing/presence.js";

/** 只實作 registry 真正用到的表面：documents.get(name) → { awareness:{states,meta,emit}, getXmlFragment }。 */
function fakeHocuspocus() {
  const documents = new Map<string, ReturnType<typeof makeDoc>>();
  function makeDoc() {
    const states = new Map<number, unknown>();
    const meta = new Map<number, { clock: number; lastUpdated: number }>();
    const emitted: unknown[][] = [];
    return {
      awareness: { states, meta, emit: (name: string, args: unknown[]) => { emitted.push([name, ...args]); } },
      emitted,
      // 空 fragment：cursorFor 找不到文字節點 → 不送 cursor。本檔只驗 registry 的機械行為，
      // 「游標落在哪一顆」由 test/note-presence.test.ts 在真 Yjs 結構上驗。
      getXmlFragment: () => ({ get: () => undefined, length: 0 }),
    };
  }
  return { documents, makeDoc };
}
const user = { name: "w (claude)", color: "#7c3aed" };
type FakeDoc = ReturnType<ReturnType<typeof fakeHocuspocus>["makeDoc"]>;
const clockOf = (doc: FakeDoc, id: number) => doc.awareness.meta.get(id)!.clock;

describe("PresenceRegistry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("clientId 是 uint32 且對 (noteId, tokenId) 穩定；capacity 預設 500", () => {
    const a = presenceClientId("n1", "t1");
    expect(a).toBe(presenceClientId("n1", "t1"));
    expect(Number.isInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(2 ** 32);
    expect(a).not.toBe(presenceClientId("n1", "t2"));
    expect(a).not.toBe(presenceClientId("n2", "t1"));
    expect(new PresenceRegistry(undefined).capacity).toBe(500);
  });

  it("目標推導：讀取三形；寫入吃**編輯後**的 afterBlockIds（replace_all → 文件開頭、delete_section → 文件開頭、其餘 → 剛寫下的第一顆）", () => {
    expect(presenceTargetForRead(undefined)).toEqual({ kind: "doc-start" });
    expect(presenceTargetForRead("_top")).toEqual({ kind: "section", sectionId: "_top" });
    expect(presenceTargetForRead("sec-1")).toEqual({ kind: "section", sectionId: "sec-1" });
    // ⚠ 第二個參數是 `ApplyResult.afterBlockIds`＝**編輯後**新寫下的 block id（文件順序）。
    //    絕不是請求帶進來的 section_id：那是 heading 的 block id，replace_section／delete_section
    //    會把 heading 一起換掉，編輯完成後它已不存在（繼承表第 21 列）。
    expect(presenceTargetForWrite("replace_all", ["r1", "r2"])).toEqual({ kind: "doc-start" });
    expect(presenceTargetForWrite("replace_section", ["s1", "s2"])).toEqual({ kind: "block", blockId: "s1" });
    expect(presenceTargetForWrite("insert_after", ["i1"])).toEqual({ kind: "block", blockId: "i1" });
    expect(presenceTargetForWrite("append", ["p1", "p2"])).toEqual({ kind: "block", blockId: "p1" });
    // delete_section 的 afterIds 恆為空（`prepareEdit` 的 delete 分支從不指派 afterIds）——
    // 被刪的那一段已經不存在，明確走文件開頭。
    expect(presenceTargetForWrite("delete_section", [])).toEqual({ kind: "doc-start" });
    // 防禦：任何 op 拿到空陣列都退文件開頭，不得丟 undefined 進 blockId
    expect(presenceTargetForWrite("append", [])).toEqual({ kind: "doc-start" });
  });

  it("touch：文件已載入才 seed（states+meta+emit added）；clock 從 1 起；未載入 no-op；hocuspocus 缺席全 no-op", () => {
    // n2:t2 在本檔只出現這一案，所以 spec §9 的「從 1 起」可以用絕對值釘住
    const h = fakeHocuspocus(); const doc = h.makeDoc(); h.documents.set("n2", doc);
    const reg = new PresenceRegistry(h as never);
    const id = presenceClientId("n2", "t2");
    reg.touch("n2", "t2", user, { kind: "doc-start" });
    expect(doc.awareness.states.get(id)).toMatchObject({ user });
    expect(clockOf(doc, id)).toBe(1);
    expect(doc.emitted.at(-1)).toEqual(["update", { added: [id], updated: [], removed: [] }, "ai-presence"]);
    reg.touch("nx", "t2", user, { kind: "doc-start" }); // 文件未載入 → 不建 entry
    expect(reg.size).toBe(1);
    const none = new PresenceRegistry(undefined);
    none.touch("n2", "t2", user, { kind: "doc-start" });
    expect(none.size).toBe(0);
  });

  it("heartbeat 每 10 s clock+1、emit updated；每 beat 重取 documents.get（unload 後不碰舊物件）", () => {
    const h = fakeHocuspocus(); const doc = h.makeDoc(); h.documents.set("n3", doc);
    const reg = new PresenceRegistry(h as never);
    const id = presenceClientId("n3", "t3");
    reg.touch("n3", "t3", user, { kind: "doc-start" });
    const c0 = clockOf(doc, id);
    vi.advanceTimersByTime(10_000);
    expect(clockOf(doc, id)).toBe(c0 + 1);
    expect(doc.emitted.at(-1)).toEqual(["update", { added: [], updated: [id], removed: [] }, "ai-presence"]);
    // reload：換成全新的 Document 物件，下一個 beat 必須打在新物件上
    const c1 = clockOf(doc, id);
    h.documents.delete("n3"); const fresh = h.makeDoc(); h.documents.set("n3", fresh);
    vi.advanceTimersByTime(10_000);
    expect(clockOf(doc, id)).toBe(c1);        // 舊物件不再被寫
    expect(clockOf(fresh, id)).toBe(c1 + 1);  // 新物件接手，clock 連續
  });

  it("閒置 120 s → stop（states.delete、clock+1、emit removed）；stop 後 re-touch clock 繼續（不重設）", () => {
    const h = fakeHocuspocus(); const doc = h.makeDoc(); h.documents.set("n4", doc);
    const reg = new PresenceRegistry(h as never);
    const id = presenceClientId("n4", "t4");
    reg.touch("n4", "t4", user, { kind: "doc-start" });
    vi.advanceTimersByTime(120_000);
    expect(doc.awareness.states.has(id)).toBe(false);
    expect(doc.emitted.at(-1)).toEqual(["update", { added: [], updated: [], removed: [id] }, "ai-presence"]);
    const afterStop = clockOf(doc, id);
    reg.touch("n4", "t4", user, { kind: "doc-start" });
    expect(clockOf(doc, id)).toBe(afterStop + 1);
    expect(reg.size).toBe(1);
  });

  it("第 (capacity+1) 筆逐出最舊 heartbeat 的 entry（狀態清掉、計時器清掉）；stopAll 清光", () => {
    const h = fakeHocuspocus();
    const reg = new PresenceRegistry(h as never, { capacity: 2 });
    for (const n of ["a5", "b5", "c5"]) {
      h.documents.set(n, h.makeDoc());
      reg.touch(n, "t5", user, { kind: "doc-start" });
      vi.advanceTimersByTime(1);
    }
    expect(reg.size).toBe(2);
    expect(h.documents.get("a5")!.awareness.states.size).toBe(0); // 最舊的被逐出、狀態清掉
    reg.stopAll();
    expect(reg.size).toBe(0);
    const before = h.documents.get("b5")!.emitted.length;
    vi.advanceTimersByTime(60_000);
    expect(h.documents.get("b5")!.emitted.length).toBe(before);   // 計時器真的被清掉了
  });

  it("每次 touch／每個 heartbeat 送出的 state 都與前一拍**深度不等**（beat 單調遞增）——名牌才會亮", () => {
    // ⚠ 這一案是「名牌看得見」這條交付的**唯一**單元守衛。awareness 的 change 事件只在
    //    !equalityDeep(state, prevState) 時才發（y-protocols/awareness.js:278），而 BlockNote 設
    //    data-active 的處理常式只吃 change 的 `updated`（@blocknote/core/dist/yjs.js:80）。
    //    把 state 裡的 `beat` 拿掉 → 心跳送出的 state 與上一拍完全相同 → change 不發 →
    //    名牌永遠是那個 4×5 的透明框。整支測試除了這一案不會有任何一案變紅。
    const h = fakeHocuspocus(); const doc = h.makeDoc(); h.documents.set("n7", doc);
    const reg = new PresenceRegistry(h as never);
    const id = presenceClientId("n7", "t7");
    const snap = () => JSON.stringify(doc.awareness.states.get(id));
    reg.touch("n7", "t7", user, { kind: "doc-start" });
    const s1 = snap();
    vi.advanceTimersByTime(10_000);          // heartbeat：目標與內容完全沒變
    const s2 = snap();
    expect(s2).not.toBe(s1);
    reg.touch("n7", "t7", user, { kind: "doc-start" }); // 同一個目標再 touch 一次
    const s3 = snap();
    expect(s3).not.toBe(s2);
    const beats = [s1, s2, s3].map(s => (JSON.parse(s) as { beat: number }).beat);
    expect(beats).toEqual([...beats].sort((a, b) => a - b));
    expect(new Set(beats).size).toBe(3);
  });

  it("內容的第一個子節點是元素而非文字（表格這類）時不送 cursor，也不丟錯（窄化成只判 undefined 會漏這個 case——見 presence.ts 的判型註解）", () => {
    // 手工造：blockContainer(tbl1) > table > tableRow（table 的內容不是 XmlText，是另一個
    // XmlElement）。圖片／分隔線那類「內容根本沒有子節點」已被本檔其餘 8 案的整條判型拿掉
    // 突變蓋住；這一案專守「有子節點但是元素、不是文字」這個窄化最可能漏掉的窄縫。
    const yDoc = new Y.Doc();
    const fragment = yDoc.getXmlFragment(YDOC_FRAGMENT);
    const group = new Y.XmlElement("blockGroup");
    const container = new Y.XmlElement("blockContainer");
    container.setAttribute("id", "tbl1");
    const table = new Y.XmlElement("table");
    const row = new Y.XmlElement("tableRow"); // 表格內容的第一個子節點是元素，不是 XmlText
    table.insert(0, [row]);
    container.insert(0, [table]);
    group.insert(0, [container]);
    fragment.insert(0, [group]);
    const states = new Map<number, unknown>();
    const meta = new Map<number, { clock: number; lastUpdated: number }>();
    const h = {
      documents: new Map([["n9", {
        awareness: { states, meta, emit: () => {} },
        getXmlFragment: yDoc.getXmlFragment.bind(yDoc),
      }]]),
    };
    const reg = new PresenceRegistry(h as never);
    const id = presenceClientId("n9", "t9");
    expect(() => reg.touch("n9", "t9", user, { kind: "block", blockId: "tbl1" })).not.toThrow();
    expect(states.get(id)).not.toHaveProperty("cursor");
  });

  it("clock map 是 process 生命週期：換一個全新的 registry，同一組鍵的 clock 仍嚴格遞增", () => {
    // ⚠ 這一案是「clock map 不得搬進實例」這條不變量的**唯一**守衛（presence.ts 檔頭指名它）。
    // 把 map 搬進實例、或加一個 reset()，只有這一案會紅，其餘全部照綠。
    const h = fakeHocuspocus(); const doc = h.makeDoc(); h.documents.set("n6", doc);
    const id = presenceClientId("n6", "t6");
    const first = new PresenceRegistry(h as never);
    first.touch("n6", "t6", user, { kind: "doc-start" });
    first.stop("n6", "t6");
    const highWater = clockOf(doc, id);
    const second = new PresenceRegistry(h as never); // 全新 registry，舊的丟掉
    second.touch("n6", "t6", user, { kind: "doc-start" });
    expect(clockOf(doc, id)).toBeGreaterThan(highWater);
  });
});
