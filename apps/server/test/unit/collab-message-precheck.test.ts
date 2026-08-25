import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOGUS_MESSAGE_LIMIT, classifyClientMessage } from "../../src/collab/server.js";

/** 手工組 wire 訊息：varString(docName) + varUint(type) [+ varUint(subtype)]。
 * 這裡刻意不用 lib0（手組 varint）——測試對 wire 格式的理解要獨立於實作共用的工具。 */
function frame(docName: string, type: number, subtype?: number): Uint8Array {
  const name = new TextEncoder().encode(docName);
  if (name.length >= 128) throw new Error("測試用 docName 請短於 128 bytes（單一 varint byte）");
  if (type >= 128 || (subtype !== undefined && subtype >= 128)) throw new Error("測試用 type/subtype 請 <128");
  const bytes = [name.length, ...name, type];
  if (subtype !== undefined) bytes.push(subtype);
  return new Uint8Array(bytes);
}

const NOTE = "11111111-1111-1111-1111-111111111111";

describe("classifyClientMessage（issue #50 訊息預檢）", () => {
  it("MessageReceiver 有 handler 的 type（0/1/3/4/5/7 + Auth+Token + BroadcastStateless(6)）→ ok", () => {
    // ⚠ 白名單是「4.5.0 的 switch 實際有 case 的集合」，不是 MessageType enum 的範圍
    //（審查抓到：enum 有 0..10，但 8/9/10 沒有 case、落在 console.error 的 default）。
    // 6 放行的理由不同：client 送它 Hocuspocus 會 throw 並自行關線，自我設限。
    for (const type of [0, 1, 3, 4, 5, 6, 7]) {
      expect(classifyClientMessage(frame(NOTE, type)).verdict).toBe("ok");
    }
    expect(classifyClientMessage(frame(NOTE, 2, 0)).verdict).toBe("ok"); // Auth + Token
  });

  it("enum 有名字但 switch 沒有 case 的 SyncStatus(8)/Ping(9)/Pong(10) → bogus（#50 的洞就在這）", () => {
    for (const type of [8, 9, 10]) {
      const check = classifyClientMessage(frame(NOTE, type));
      expect(check.verdict).toBe("bogus");
      expect(check.type).toBe(type);
    }
  });

  it("未知 type → bogus，帶 type 與 docName 前綴（截 64）", () => {
    const check = classifyClientMessage(frame(NOTE, 42));
    expect(check.verdict).toBe("bogus");
    expect(check.type).toBe(42);
    expect(check.docNamePrefix).toBe(NOTE);

    const longName = "x".repeat(100);
    const longCheck = classifyClientMessage(frame(longName, 42));
    expect(longCheck.docNamePrefix).toBe("x".repeat(64));
  });

  it("裸 Pong frame（[10]，無 documentName 前綴——provider 只在回應 server Ping 時送）→ malformed 轉交", () => {
    // server 4.5.0 從不 Ping，所以今天沒有合法 client 會送這個；轉交後 Hocuspocus 解不開
    // 會 throw 關線。升級到會 Ping 的 server 版本時這條會提醒你回來看 classifyClientMessage。
    expect(classifyClientMessage(new Uint8Array([10])).verdict).toBe("malformed");
  });

  it("Auth 非 Token 子型別（PermissionDenied/Authenticated 是 server→client 方向）→ bogus", () => {
    expect(classifyClientMessage(frame(NOTE, 2, 1)).verdict).toBe("bogus");
    expect(classifyClientMessage(frame(NOTE, 2, 2)).verdict).toBe("bogus");
  });

  it("畸形訊息 → malformed（轉交給 Hocuspocus，它會 throw 並自行關線）", () => {
    expect(classifyClientMessage(new Uint8Array([])).verdict).toBe("malformed");
    // 宣稱 name 長 100 bytes 但訊息只有 3 bytes。
    expect(classifyClientMessage(new Uint8Array([100, 1, 2])).verdict).toBe("malformed");
    // varint continuation 串燒（每 byte 都掛 continuation bit）——不得無限迴圈或當成合法。
    expect(classifyClientMessage(new Uint8Array(20).fill(0xff)).verdict).toBe("malformed");
    // 有 name、沒有 type。
    expect(classifyClientMessage(new Uint8Array([1, 65])).verdict).toBe("malformed");
    // Auth 有 type、沒有 subtype。
    expect(classifyClientMessage(frame(NOTE, 2)).verdict).toBe("malformed");
  });

  it("上限常數 sanity：>1（滾動升級寬限）且有限", () => {
    expect(BOGUS_MESSAGE_LIMIT).toBeGreaterThan(1);
    expect(BOGUS_MESSAGE_LIMIT).toBeLessThanOrEqual(100);
  });

  it("@hocuspocus/server 版本在已稽核清單內——升版必須回來重對 MessageReceiver 的 switch", () => {
    // 白名單「0/1/3/4/5/6/7 + Auth/Token」是對特定版本 dist 的 switch 逐 case 稽核的
    // 結果（4.5.0 稽核於 issue #50；4.6.0 經比對 byte-identical）。dependency 是 ^4.5
    // caret——升版不會有任何測試自動變紅，唯有這條逼人回來重稽核：新版本若新增了
    // handler（例如開始回 Ping），白名單與裸 Pong 的 malformed 處理都要重看。
    const pkg = JSON.parse(
      readFileSync(new URL("../../node_modules/@hocuspocus/server/package.json", import.meta.url), "utf8")
    ) as { version: string };
    expect(["4.5.0", "4.6.0"]).toContain(pkg.version);
  });
});
