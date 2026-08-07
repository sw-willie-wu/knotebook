import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { docClock } from "../../src/collab/store.js";

describe("docClock（Y.decodeStateVector(Y.encodeStateVector(doc)) 各 client seq 總和）", () => {
  it("空 doc → 0", () => {
    expect(docClock(new Y.Doc())).toBe(0);
  });

  it("單一 client：每次編輯後嚴格遞增，增量等於該次寫入的 op 長度", () => {
    const doc = new Y.Doc();
    expect(docClock(doc)).toBe(0);

    doc.getText("t").insert(0, "a");
    expect(docClock(doc)).toBe(1);

    doc.getText("t").insert(1, "bc");
    expect(docClock(doc)).toBe(3);

    doc.getText("t").insert(3, "defgh");
    expect(docClock(doc)).toBe(8);
  });

  it("多 client：合併另一個 clientID 的更新後，clock 是兩者總和（遞增，非取代）", () => {
    const docA = new Y.Doc();
    docA.getText("t").insert(0, "abc"); // clientA clock = 3
    expect(docClock(docA)).toBe(3);

    const docB = new Y.Doc();
    docB.getText("t").insert(0, "de"); // clientB（不同隨機 clientID）clock = 2
    expect(docClock(docB)).toBe(2);

    // 把 docB 的更新併進 docA：模擬 remote sync，docA 現在同時持有兩個 client 的貢獻。
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    expect(docClock(docA)).toBe(5);

    // 反向合併也成立：docB 併入 docA 全量更新後兩邊收斂到同一個總和。
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    expect(docClock(docB)).toBe(5);
  });

  it("encodeStateAsUpdate/applyUpdate 往返：clock 不變", () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "hello world");
    const before = docClock(doc);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));

    expect(docClock(restored)).toBe(before);
  });

  it("刪除內容觸發 tombstone/GC 合併後，clock 不減（維持刪除前的總和）", () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "hello world"); // 單一 client、單一 insert，clock = 11
    const beforeDelete = docClock(doc);
    expect(beforeDelete).toBe(11);

    // 刪除只是把既有 item 標記為已刪除（可能連帶把它切成兩段），不消耗新的 clock 額度。
    doc.getText("t").delete(0, 5);
    expect(docClock(doc)).toBeGreaterThanOrEqual(beforeDelete);

    // 經一次 encodeStateAsUpdate/applyUpdate 往返（gc 預設開啟，deleted item 會被壓縮成
    // GC struct）：clock 仍不得低於刪除前的總和——GC 只影響「保留哪些內容」，不影響
    // 「每個 client 已知涵蓋到哪個 clock」這個判定基準。
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));
    expect(docClock(restored)).toBeGreaterThanOrEqual(beforeDelete);
  });
});
