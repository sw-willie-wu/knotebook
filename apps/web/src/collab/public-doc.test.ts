import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EMPTY_YDOC_UPDATE_B64, YDOC_FRAGMENT } from "@knotebook/shared";
import { decodePublicYdoc } from "./public-doc";

/** 不經過 decodePublicYdoc 自己的解碼路徑，用 btoa 獨立算 base64（防兩端共用同一份錯誤）。 */
function independentBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("decodePublicYdoc（#72 Task 3：公開端點 ydoc payload → Y.Doc）", () => {
  it("防套套邏輯：EMPTY_YDOC_UPDATE_B64 必須等於 Y 獨立算出的空文件編碼（兩端都 import 同常數時，常數本身錯了照樣全綠——這條用 Y 現算擋住）", () => {
    expect(independentBase64(Y.encodeStateAsUpdate(new Y.Doc()))).toBe(EMPTY_YDOC_UPDATE_B64);
  });

  it("空文件 payload（AAA=）→ 解出空 fragment、不 throw（server 對從沒開過編輯器的筆記回這個值）", () => {
    const doc = decodePublicYdoc(EMPTY_YDOC_UPDATE_B64);
    expect(doc.getXmlFragment(YDOC_FRAGMENT).length).toBe(0);
  });

  it("有內容的文件 round-trip：encode → base64 → decode 後 fragment 內容一致", () => {
    const source = new Y.Doc();
    const fragment = source.getXmlFragment(YDOC_FRAGMENT);
    source.transact(() => {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText("公開分享的內容")]);
      fragment.insert(0, [paragraph]);
    });

    const decoded = decodePublicYdoc(independentBase64(Y.encodeStateAsUpdate(source)));
    expect(decoded.getXmlFragment(YDOC_FRAGMENT).toString()).toBe(fragment.toString());
    expect(decoded.getXmlFragment(YDOC_FRAGMENT).toString()).toContain("公開分享的內容");
  });

  it("壞掉的 base64 → throw（呼叫端的錯誤邊界接手，不得靜默回空文件——那會把資料毀損渲染成「空筆記」）", () => {
    expect(() => decodePublicYdoc("not base64 !!!")).toThrow();
  });
});
