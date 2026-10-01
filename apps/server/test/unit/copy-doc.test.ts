/**
 * #175 PR2 T4：複製的 Y.Doc 處理（`notes/copy-doc.ts`，純 Yjs、不碰 DB）。整合面在 `test/groups-v2-copy.test.ts`。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { cloneForCopy, rewriteUploadUrls } from "../../src/notes/copy-doc.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
function docWith(urls: string[]): Y.Doc {
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
  group.insert(0, urls.map((u, i) => {
    const c = new Y.XmlElement("blockContainer"); c.setAttribute("id", `b${i}`);
    const img = new Y.XmlElement("image"); img.setAttribute("url", u);
    c.insert(0, [img]); return c;
  }));
  return doc;
}

describe("cloneForCopy／rewriteUploadUrls（#175 §6.5 (2)、B10）", () => {
  it("clone 後 XML 逐字相同、是不同的 Y.Doc（clientID 不同）", () => {
    const src = docWith([`/api/uploads/${U1}`, "https://example.com/a.png"]);
    const { doc } = cloneForCopy(src);
    expect(doc.getXmlFragment(YDOC_FRAGMENT).toString()).toBe(src.getXmlFragment(YDOC_FRAGMENT).toString());
    expect(doc.clientID).not.toBe(src.clientID);
  });
  it("只收 url 恰為 /api/uploads/<uuid> 的節點；巢狀也收；同 id 多節點歸同一組（RF2）；大寫 uuid 正規化成小寫鍵", () => {
    const src = docWith([`/api/uploads/${U1}`, `/api/uploads/${U1}`, `/api/uploads/${U2.toUpperCase()}`,
      "https://example.com/a.png", `https://host/api/uploads/${U1}`, `/api/uploads/${U1}?x=1`, "/api/uploads/not-a-uuid"]);
    const { uploadNodes } = cloneForCopy(src);
    expect([...uploadNodes.keys()].sort()).toEqual([U1, U2]);
    expect(uploadNodes.get(U1)).toHaveLength(2);
  });
  it("rewrite：同一 id 的節點全改成同一個新 id；mapping 沒有的節點不動；來源 doc 不受影響", () => {
    const src = docWith([`/api/uploads/${U1}`, `/api/uploads/${U1}`, `/api/uploads/${U2}`]);
    const before = src.getXmlFragment(YDOC_FRAGMENT).toString();
    const copy = cloneForCopy(src);
    const N1 = "33333333-3333-4333-8333-333333333333";
    rewriteUploadUrls(copy, new Map([[U1, N1]]));
    const xml = copy.doc.getXmlFragment(YDOC_FRAGMENT).toString();
    expect(xml.split(`/api/uploads/${N1}`).length - 1).toBe(2);
    expect(xml).toContain(`/api/uploads/${U2}`);
    expect(src.getXmlFragment(YDOC_FRAGMENT).toString()).toBe(before);
  });
  it("空文件：clone 出空文件、沒有附件（RF3 的單元半邊）", () => {
    const { doc, uploadNodes } = cloneForCopy(new Y.Doc());
    expect(doc.getXmlFragment(YDOC_FRAGMENT).length).toBe(0);
    expect(uploadNodes.size).toBe(0);
  });
  it("源碼守衛：`notes/tx/copy.ts`（剝註解後）不寫 updatedAt／updated_at——副本的 updated_at 只吃 DB default（Global Constraints；MCP list_notes 排序說明依賴）", () => {
    const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/notes/tx/copy.ts");
    const src = readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toContain("copyNoteInTx"); // 讀對檔（剝註解沒把整份剝光）
    expect(src).not.toMatch(/updatedAt|updated_at/);
  });
});
