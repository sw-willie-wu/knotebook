import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { collectUnsafeUrlFindings } from "../../src/collab/store.js";

/** 造一個帶指定屬性的 block 元素，掛進共編 fragment。 */
function insertBlock(doc: Y.Doc, nodeName: string, attrs: Record<string, string>, parent?: Y.XmlElement): Y.XmlElement {
  const element = new Y.XmlElement(nodeName);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  if (parent) parent.insert(parent.length, [element]);
  else doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);
  return element;
}

describe("collectUnsafeUrlFindings（issue #44 最小步：只偵測不改寫）", () => {
  it("javascript:/data: 的 url 屬性 → 各記一筆發現（block 名與 scheme，不含 URL 本體）", () => {
    const doc = new Y.Doc();
    insertBlock(doc, "image", { url: "javascript:alert(1)" });
    insertBlock(doc, "video", { url: "data:text/html;base64,PHNjcmlwdD4=" });

    const findings = collectUnsafeUrlFindings(doc);
    expect(findings).toHaveLength(2);
    expect(findings).toContainEqual({ block: "image", scheme: "javascript:" });
    expect(findings).toContainEqual({ block: "video", scheme: "data:" });
    // URL 本體（攻擊者控制的內容）絕不得出現在發現裡。
    expect(JSON.stringify(findings)).not.toContain("alert");
    expect(JSON.stringify(findings)).not.toContain("base64");
  });

  it("巢狀元素（blockGroup/blockContainer 底下）一樣掃得到", () => {
    const doc = new Y.Doc();
    const group = insertBlock(doc, "blockGroup", {});
    const container = insertBlock(doc, "blockContainer", {}, group);
    insertBlock(doc, "file", { url: "javascript:void(0)" }, container);

    expect(collectUnsafeUrlFindings(doc)).toEqual([{ block: "file", scheme: "javascript:" }]);
  });

  it("自家上傳的相對網址、外部 http(s)、空字串 → 皆不算發現（與 web 端 isSafeMediaUrl 白名單一致）", () => {
    const doc = new Y.Doc();
    insertBlock(doc, "image", { url: "/api/uploads/u1" });
    insertBlock(doc, "image", { url: "https://example.com/a.png" });
    insertBlock(doc, "image", { url: "http://example.com/a.png" });
    insertBlock(doc, "file", { url: "" });

    expect(collectUnsafeUrlFindings(doc)).toEqual([]);
  });

  it("含冒號的一般文字屬性（caption/name）不誤報——只看名為 url 的屬性", () => {
    const doc = new Y.Doc();
    insertBlock(doc, "image", { url: "https://example.com/a.png", caption: "note: remember this", name: "time: 12:30" });

    expect(collectUnsafeUrlFindings(doc)).toEqual([]);
  });

  it("空文件 → 空發現", () => {
    expect(collectUnsafeUrlFindings(new Y.Doc())).toEqual([]);
  });

  it("非字串的 url 屬性值（敵意 client 寫任意 Yjs 值）一樣掃得到——URL 的 ToString 攤平陣列", () => {
    const doc = new Y.Doc();
    const element = new Y.XmlElement("image");
    element.setAttribute("url", ["javascript:alert(1)"] as unknown as string);
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);

    expect(collectUnsafeUrlFindings(doc)).toEqual([{ block: "image", scheme: "javascript:" }]);
  });

  it("深巢狀（5000 層）不炸——走訪是迭代的，深度是攻擊者可控的", () => {
    const doc = new Y.Doc();
    let parent = new Y.XmlElement("blockContainer");
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [parent]);
    for (let i = 0; i < 5_000; i += 1) {
      const child = new Y.XmlElement("blockContainer");
      parent.insert(0, [child]);
      parent = child;
    }
    const leaf = new Y.XmlElement("image");
    leaf.setAttribute("url", "javascript:deep");
    parent.insert(0, [leaf]);

    expect(collectUnsafeUrlFindings(doc)).toEqual([{ block: "image", scheme: "javascript:" }]);
  });

  it("block 名（client 寫進 Y.Doc 的任意字串）截斷到 64 字元——單行日誌大小不得由攻擊者決定", () => {
    const doc = new Y.Doc();
    insertBlock(doc, "x".repeat(1_000), { url: "javascript:alert(1)" });

    const findings = collectUnsafeUrlFindings(doc);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.block).toBe("x".repeat(64));
  });

  it("發現數不設限（distinct 清單的封頂在 log 端）——11 種相異 block 名全數列入 findings", () => {
    // log 端「最多列 10 個 distinct + 總數」的封頂行為在 store.ts 的 onStoreDocument；
    // 純函式這頭回傳完整發現，讓 log 端能報正確的 blocksTotal。這條配合下面
    // collab-store.test.ts 的整合斷言，一起釘住 docs 宣稱的「at most ten listed」。
    const doc = new Y.Doc();
    for (let i = 0; i < 11; i += 1) insertBlock(doc, `custom-block-${i}`, { url: "javascript:x" });

    const findings = collectUnsafeUrlFindings(doc);
    expect(findings).toHaveLength(11);
    expect(new Set(findings.map(f => f.block)).size).toBe(11);
  });

  it("掃描是唯讀的：對「只經 applyUpdate 建出」的 doc（production 形狀）掃描前後 state 位元組相同", () => {
    // production 的 server 端 doc 只透過 Y.applyUpdate 取得內容，share entry 是
    // AbstractType——getXmlFragment 的轉換分支就在這種 doc 上發生（審查實測 benign，
    // 這條把它釘住：yjs 升版若讓它變成會產生 update 的操作，這裡會紅）。
    const source = new Y.Doc();
    const el = new Y.XmlElement("image");
    el.setAttribute("url", "javascript:alert(1)");
    source.getXmlFragment(YDOC_FRAGMENT).insert(0, [el]);
    const update = Y.encodeStateAsUpdate(source);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    const before = Y.encodeStateAsUpdate(doc);
    const beforeSv = Y.encodeStateVector(doc);

    collectUnsafeUrlFindings(doc);

    expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(Buffer.from(before));
    expect(Buffer.from(Y.encodeStateVector(doc))).toEqual(Buffer.from(beforeSv));
  });
});
