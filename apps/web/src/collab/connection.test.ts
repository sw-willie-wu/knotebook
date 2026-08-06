import { describe, expect, it } from "vitest";
import { COLLAB_CLOSE_NOTE_DELETED, COLLAB_CLOSE_REVOKED, type Role } from "@knotebook/shared";
import { collabReducer, INITIAL_COLLAB_STATE, isTerminal, type CollabEvent, type CollabState } from "./connection";

// 事件建構捷徑——測試裡大量重複，抽出來讓每條斷言只剩「狀態 + 事件 → 狀態」這一件事。
const open = (role: Role): CollabEvent => ({ type: "open", role });
const close = (reason: string): CollabEvent => ({ type: "close", reason });
const tokenRole = (role: Role): CollabEvent => ({ type: "token-role", role });

/** 網路層斷線的 close reason：瀏覽器原生 CloseEvent 的 reason 幾乎總是空字串。 */
const NETWORK_CLOSE = "";
/** Hocuspocus `closeConnections()` 廣播的 reason（非撤權，屬「其他 reason」）。 */
const RESET_CONNECTION = "Reset Connection";

const CONNECTING: CollabState = { phase: "connecting" };
const RECONNECTING_ONCE: CollabState = { phase: "reconnecting-once" };
const KICKED: CollabState = { phase: "kicked" };
const DELETED: CollabState = { phase: "deleted" };
const connected = (role: Role): CollabState => ({ phase: "connected", role });

/** 所有事件的代表性樣本——用來對終態做「收任何事件都不轉移」的全稱斷言。 */
const ALL_EVENTS: CollabEvent[] = [
  open("owner"),
  open("editor"),
  open("viewer"),
  open("none"),
  close(COLLAB_CLOSE_REVOKED),
  close(COLLAB_CLOSE_NOTE_DELETED),
  close(NETWORK_CLOSE),
  close(RESET_CONNECTION),
  tokenRole("owner"),
  tokenRole("editor"),
  tokenRole("viewer"),
  tokenRole("none"),
];

describe("INITIAL_COLLAB_STATE", () => {
  it("starts in connecting", () => {
    expect(INITIAL_COLLAB_STATE).toEqual({ phase: "connecting" });
  });
});

describe("collabReducer — open", () => {
  it("connecting + open → connected with the role from the token response body", () => {
    expect(collabReducer(CONNECTING, open("editor"))).toEqual(connected("editor"));
    expect(collabReducer(CONNECTING, open("viewer"))).toEqual(connected("viewer"));
    expect(collabReducer(CONNECTING, open("owner"))).toEqual(connected("owner"));
  });

  it("reconnecting-once + open → connected（那一次重連成功，回到正常態）", () => {
    expect(collabReducer(RECONNECTING_ONCE, open("editor"))).toEqual(connected("editor"));
  });

  it("connected + open（重新驗證）→ 以新角色留在 connected", () => {
    expect(collabReducer(connected("editor"), open("viewer"))).toEqual(connected("viewer"));
  });

  it("connected + open 角色不變 → 回傳同一個 state 物件（不觸發多餘 re-render）", () => {
    const state = connected("editor");
    expect(collabReducer(state, open("editor"))).toBe(state);
  });
});

describe("collabReducer — close(REVOKED)：撤權雙擊流程", () => {
  it("connected + close(REVOKED) → reconnecting-once（第一擊：重取 token 連一次）", () => {
    expect(collabReducer(connected("editor"), close(COLLAB_CLOSE_REVOKED))).toEqual(RECONNECTING_ONCE);
  });

  it("reconnecting-once + close(REVOKED) → kicked（第二擊：終態）", () => {
    expect(collabReducer(RECONNECTING_ONCE, close(COLLAB_CLOSE_REVOKED))).toEqual(KICKED);
  });

  it("連續兩次 REVOKED 從 connected 一路走到 kicked", () => {
    const first = collabReducer(connected("editor"), close(COLLAB_CLOSE_REVOKED));
    expect(first).toEqual(RECONNECTING_ONCE);
    expect(collabReducer(first, close(COLLAB_CLOSE_REVOKED))).toEqual(KICKED);
  });

  it("connecting + close(REVOKED) → reconnecting-once（尚未 open 也算第一擊）", () => {
    expect(collabReducer(CONNECTING, close(COLLAB_CLOSE_REVOKED))).toEqual(RECONNECTING_ONCE);
  });
});

describe("collabReducer — token-role", () => {
  it("reconnecting-once + token-role 'none' → kicked（重取 token 就已知失去存取權）", () => {
    expect(collabReducer(RECONNECTING_ONCE, tokenRole("none"))).toEqual(KICKED);
  });

  it("reconnecting-once + token-role 非 'none' → 維持 reconnecting-once（等 open 才算連上）", () => {
    expect(collabReducer(RECONNECTING_ONCE, tokenRole("editor"))).toBe(RECONNECTING_ONCE);
    expect(collabReducer(RECONNECTING_ONCE, tokenRole("viewer"))).toBe(RECONNECTING_ONCE);
  });

  it("connected(editor) + token-role 'viewer' → 留在 connected 但角色降為 viewer（N4）", () => {
    expect(collabReducer(connected("editor"), tokenRole("viewer"))).toEqual(connected("viewer"));
  });

  it("connected(viewer) + token-role 'editor' → 留在 connected 且角色回升（權限恢復只能靠 token-role）", () => {
    expect(collabReducer(connected("viewer"), tokenRole("editor"))).toEqual(connected("editor"));
  });

  it("connected + token-role 角色不變 → 回傳同一個 state 物件", () => {
    const state = connected("editor");
    expect(collabReducer(state, tokenRole("editor"))).toBe(state);
  });

  it("connected + token-role 'none' → 留在 connected 但角色 'none'（唯讀；踢出由 server 的 REVOKED close 裁決）", () => {
    expect(collabReducer(connected("editor"), tokenRole("none"))).toEqual(connected("none"));
  });

  it("connecting + token-role → 不轉移（角色在 open 時才落定）", () => {
    expect(collabReducer(CONNECTING, tokenRole("editor"))).toBe(CONNECTING);
    expect(collabReducer(CONNECTING, tokenRole("none"))).toBe(CONNECTING);
  });
});

describe("collabReducer — close(NOTE_DELETED)", () => {
  it("任何非終態 + close(NOTE_DELETED) → deleted", () => {
    for (const state of [CONNECTING, connected("owner"), connected("viewer"), RECONNECTING_ONCE]) {
      expect(collabReducer(state, close(COLLAB_CLOSE_NOTE_DELETED))).toEqual(DELETED);
    }
  });
});

describe("collabReducer — close(其他 reason)", () => {
  it("connected + close(網路斷線) → connecting（provider 內建退避重連，非終態）", () => {
    expect(collabReducer(connected("editor"), close(NETWORK_CLOSE))).toEqual(CONNECTING);
  });

  it("connected + close('Reset Connection') → connecting", () => {
    expect(collabReducer(connected("editor"), close(RESET_CONNECTION))).toEqual(CONNECTING);
  });

  it("reconnecting-once + close(其他 reason) → connecting（網路問題不算撤權訊號）", () => {
    expect(collabReducer(RECONNECTING_ONCE, close(NETWORK_CLOSE))).toEqual(CONNECTING);
  });

  it("connecting + close(其他 reason) → 維持 connecting（同一個物件）", () => {
    expect(collabReducer(CONNECTING, close(NETWORK_CLOSE))).toBe(CONNECTING);
  });

  it("撤權 reason 的比對是全等而非前綴/子字串", () => {
    expect(collabReducer(connected("editor"), close(`${COLLAB_CLOSE_REVOKED}x`))).toEqual(CONNECTING);
    expect(collabReducer(connected("editor"), close(COLLAB_CLOSE_REVOKED.toUpperCase()))).toEqual(CONNECTING);
    expect(collabReducer(CONNECTING, close(`x${COLLAB_CLOSE_NOTE_DELETED}`))).toEqual(CONNECTING);
  });
});

describe("collabReducer — 終態凍結", () => {
  it("kicked 收任何事件都不轉移（含同一個物件同一性）", () => {
    for (const event of ALL_EVENTS) {
      expect(collabReducer(KICKED, event)).toBe(KICKED);
    }
  });

  it("deleted 收任何事件都不轉移（含 REVOKED close 也不會覆蓋成 kicked）", () => {
    for (const event of ALL_EVENTS) {
      expect(collabReducer(DELETED, event)).toBe(DELETED);
    }
  });

  it("kicked 收 NOTE_DELETED 仍是 kicked（終態凍結優先於刪除規則）", () => {
    expect(collabReducer(KICKED, close(COLLAB_CLOSE_NOTE_DELETED))).toBe(KICKED);
  });
});

describe("isTerminal", () => {
  it("只有 kicked/deleted 是終態", () => {
    expect(isTerminal(KICKED)).toBe(true);
    expect(isTerminal(DELETED)).toBe(true);
    expect(isTerminal(CONNECTING)).toBe(false);
    expect(isTerminal(RECONNECTING_ONCE)).toBe(false);
    expect(isTerminal(connected("editor"))).toBe(false);
  });
});
