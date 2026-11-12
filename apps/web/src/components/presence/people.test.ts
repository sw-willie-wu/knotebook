import { describe, expect, it } from "vitest";
import { AGENT_PRESENCE_COLOR, collabUserColor } from "@knotebook/shared";
import {
  firstGrapheme,
  orderBySeen,
  presenceCursor,
  presenceLayout,
  presencePeople,
  presenceSignature,
  type PresencePerson,
  type UserPresencePerson,
} from "./people";
import { agentState, userState } from "./test-awareness";

// #293：名單、合併、排序、簽章、容量、首字。me＝"u-me"、本分頁 clientID＝1。
const ME = "u-me";
const MY_CLIENT = 1;
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CURSOR = { anchor: { a: 1 }, head: { h: 1 } };

function people(entries: [number, unknown][]): PresencePerson[] {
  return presencePeople(new Map(entries), MY_CLIENT, ME);
}

function onlyUser(entries: [number, unknown][]): UserPresencePerson {
  const list = people(entries);
  expect(list).toHaveLength(1);
  const [p] = list;
  if (p.kind !== "user") throw new Error("expected user");
  return p;
}

describe("presencePeople", () => {
  it("PP1 自己的 clientID 略過（即使 user.id 是別人）", () => {
    expect(people([[MY_CLIENT, userState("u-a", "Ann")]])).toEqual([]);
  });

  it("PP2 我的另一個分頁略過；我自己憑證的 AI 照樣一項", () => {
    const list = people([
      [2, userState(ME, "Me")],
      [3, agentState("me", "Claude")],
    ]);
    expect(list.map((p) => p.key)).toEqual(["agent:3"]);
  });

  it("PP3 同一人多分頁合併：角色取高、名字取 since 大者；舊版 client 不改變結果", () => {
    const merged = [
      [10, userState("u-a", "Ann 新", { role: "viewer", since: 200 })],
      [11, userState("u-a", "Ann 舊", { role: "editor", since: 100 })],
    ] as [number, unknown][];
    const expected = { key: "user:u-a", userId: "u-a", role: "editor", name: "Ann 新" };
    expect(onlyUser(merged)).toMatchObject(expected);
    expect(onlyUser([...merged, [12, userState("u-a", "Ann 更舊", { field: false })]])).toMatchObject(expected);
  });

  it("PP4 since 同分或缺席：都沒有取 clientID 大者；有 since=0 勝過缺席（−∞）", () => {
    expect(
      onlyUser([
        [31, userState("u-a", "大", { role: "editor" })],
        [30, userState("u-a", "小", { role: "editor" })],
      ]).name,
    ).toBe("大");
    expect(
      onlyUser([
        [30, userState("u-a", "有 since", { since: 0 })],
        [31, userState("u-a", "沒有 since")],
      ]).name,
    ).toBe("有 since");
  });

  it("PP5 有無游標：任一份有就算有", () => {
    expect(
      onlyUser([
        [10, userState("u-a", "Ann", { cursor: { anchor: {}, head: {} } })],
        [11, userState("u-a", "Ann", { cursor: null })],
      ]).hasCursor,
    ).toBe(true);
    expect(
      onlyUser([
        [10, userState("u-a", "Ann")],
        [11, userState("u-a", "Ann")],
      ]).hasCursor,
    ).toBe(false);
  });

  it("PP6 AI 不合併：每個 clientID 一項、顏色一律 AGENT_PRESENCE_COLOR", () => {
    const list = people([
      [20, agentState("bob", "Claude", { color: "#000000" })],
      [21, agentState("bob", "Cursor", { color: "#000000" })],
    ]);
    expect(list.map((p) => p.key)).toEqual(["agent:20", "agent:21"]);
    expect(list.map((p) => p.color)).toEqual([AGENT_PRESENCE_COLOR, AGENT_PRESENCE_COLOR]);
    expect(list[0]).toMatchObject({ kind: "agent", clientId: 20, handle: "bob", label: "Claude" });
  });

  it("PP7 非物件、沒有 user、空或非字串的 user.id → 略過", () => {
    expect(
      people([
        [10, null],
        [11, "x"],
        [12, {}],
        [13, { user: {} }],
        [14, { user: { id: "" } }],
        [15, { user: { id: 5 } }],
      ]),
    ).toEqual([]);
  });

  it("PP8 舊版 client：只有 user → 無角色、無頭貼、游標照實", () => {
    expect(onlyUser([[10, { user: { id: "u-a", name: "Ann" }, cursor: CURSOR }]])).toMatchObject({
      name: "Ann",
      role: null,
      avatar: null,
      hasCursor: true,
    });
  });

  it("PP9 惡意頭貼 → null；合法 → { id, v }", () => {
    for (const avatar of ["https://evil/x.png", "javascript:alert(1)", { id: "../x", v: 1 }, { id: UUID, v: 1e300 }]) {
      expect(onlyUser([[10, userState("u-a", "Ann", { avatar })]]).avatar).toBeNull();
    }
    expect(onlyUser([[10, userState("u-a", "Ann", { avatar: { id: UUID, v: 3 } })]]).avatar).toEqual({ id: UUID, v: 3 });
  });

  it("PP10 knotebook.v === 2 → 整欄當缺席", () => {
    const state = { user: { id: "u-a", name: "Ann" }, knotebook: { v: 2, kind: "user", role: "owner", avatar: null, since: 1 } };
    expect(onlyUser([[10, state]]).role).toBeNull();
  });

  it("PP11 角色不在白名單 → null", () => {
    expect(onlyUser([[10, userState("u-a", "Ann", { role: "admin" })]]).role).toBeNull();
  });

  it("PP14 kind 不是 user／agent → 角色、頭貼都不採用", () => {
    const state = {
      user: { id: "u-a", name: "Ann" },
      knotebook: { v: 1, kind: "bogus", role: "owner", avatar: { id: UUID, v: 1 }, since: 9 },
    };
    expect(onlyUser([[10, state]])).toMatchObject({ role: null, avatar: null });
  });

  it("PP12 kind: agent 卻缺 label 或 handle → 不出現", () => {
    expect(people([[20, { user: { name: "x" }, knotebook: { v: 1, kind: "agent", handle: "bob" } }]])).toEqual([]);
    expect(people([[21, { user: { name: "x" }, knotebook: { v: 1, kind: "agent", label: "Claude" } }]])).toEqual([]);
  });

  it("PP13 人的顏色＝collabUserColor(userId)，不讀 state.user.color", () => {
    expect(onlyUser([[10, userState("u-a", "Ann", { color: "#ff0000" })]]).color).toBe(collabUserColor("u-a"));
  });
});

describe("presenceCursor", () => {
  it("取有 cursor 且 since 最大者；AI 取該 clientID；不存在 → null", () => {
    const c10 = { anchor: { c: 10 }, head: { c: 10 } };
    const c11 = { anchor: { c: 11 }, head: { c: 11 } };
    const one = new Map<number, unknown>([
      [10, userState("u-a", "Ann 新", { role: "viewer", since: 200 })],
      [11, userState("u-a", "Ann 舊", { role: "editor", since: 100, cursor: c11 })],
    ]);
    expect(presenceCursor(one, "user:u-a", MY_CLIENT, ME)).toBe(c11);
    const both = new Map<number, unknown>([
      [11, userState("u-a", "Ann 舊", { role: "editor", since: 100, cursor: c11 })],
      [10, userState("u-a", "Ann 新", { role: "viewer", since: 200, cursor: c10 })],
    ]);
    expect(presenceCursor(both, "user:u-a", MY_CLIENT, ME)).toBe(c10);
    const ai = { anchor: { ai: 1 }, head: { ai: 1 } };
    const withAi = new Map<number, unknown>([[20, agentState("bob", "Claude", { cursor: ai })]]);
    expect(presenceCursor(withAi, "agent:20", MY_CLIENT, ME)).toBe(ai);
    expect(presenceCursor(both, "user:u-x", MY_CLIENT, ME)).toBeNull();
  });
});

function user(id: string): PresencePerson {
  return { kind: "user", key: `user:${id}`, userId: id, name: id, role: null, avatar: null, color: "c", hasCursor: false };
}

describe("orderBySeen", () => {
  it("依進場序；離開即移除；再回來排最後", () => {
    const [a, b, c] = [user("a"), user("b"), user("c")];
    let r = orderBySeen(new Map(), [b, a], 0);
    expect(r.people.map((p) => p.key)).toEqual(["user:b", "user:a"]);
    r = orderBySeen(r.seen, [a, b, c], r.nextSeq);
    expect(r.people.map((p) => p.key)).toEqual(["user:b", "user:a", "user:c"]);
    r = orderBySeen(r.seen, [a, c], r.nextSeq);
    expect(r.people.map((p) => p.key)).toEqual(["user:a", "user:c"]);
    r = orderBySeen(r.seen, [a, b, c], r.nextSeq);
    expect(r.people.map((p) => p.key)).toEqual(["user:a", "user:c", "user:b"]);
  });
});

describe("presenceSignature", () => {
  it("游標位置不算；有無游標、名字、角色、頭貼 v、人數都算", () => {
    const sig = (entries: [number, unknown][]) => presenceSignature(people(entries));
    const base = sig([[10, userState("u-a", "Ann", { role: "editor", cursor: CURSOR, avatar: { id: UUID, v: 1 } })]]);
    expect(
      sig([[10, userState("u-a", "Ann", { role: "editor", cursor: { anchor: { x: 9 }, head: { x: 9 } }, avatar: { id: UUID, v: 1 } })]]),
    ).toBe(base);
    const variants: [number, unknown][][] = [
      [[10, userState("u-a", "Ann", { role: "editor", cursor: null, avatar: { id: UUID, v: 1 } })]],
      [[10, userState("u-a", "Ann L", { role: "editor", cursor: CURSOR, avatar: { id: UUID, v: 1 } })]],
      [[10, userState("u-a", "Ann", { role: "viewer", cursor: CURSOR, avatar: { id: UUID, v: 1 } })]],
      [[10, userState("u-a", "Ann", { role: "editor", cursor: CURSOR, avatar: { id: UUID, v: 2 } })]],
      [
        [10, userState("u-a", "Ann", { role: "editor", cursor: CURSOR, avatar: { id: UUID, v: 1 } })],
        [11, userState("u-b", "Bob")],
      ],
    ];
    for (const v of variants) expect(sig(v)).not.toBe(base);
  });
});

describe("presenceLayout", () => {
  it.each([
    [0, 0, 0, 0, 0, 0],
    [1, 1, 0, 1, 0, 1],
    [2, 2, 0, 2, 0, 2],
    [3, 3, 0, 1, 2, 3],
    [5, 5, 0, 1, 4, 5],
    [6, 4, 2, 1, 5, 6],
    [9, 4, 5, 1, 8, 9],
  ])("total=%i → 寬 %i/%i、窄 %i/%i、精簡 0/%i", (total, ws, wm, ns, nm, cm) => {
    expect(presenceLayout(total)).toEqual({
      wide: { shown: ws, more: wm },
      narrow: { shown: ns, more: nm },
      compact: { shown: 0, more: cm },
    });
  });
});

describe("firstGrapheme", () => {
  it.each([
    ["ann", "A"],
    ["王小明", "王"],
    ["👩‍💻 dev", "👩‍💻"],
    ["éclair", "É"],
    ["  ", "?"],
    ["", "?"],
    [" bob", "B"],
  ])("%j → %j", (name, expected) => {
    expect(firstGrapheme(name)).toBe(expected);
  });

  // #293：開頭的 bidi／格式字元看不見，首字取第一個看得見的字素。
  it.each([
    [String.fromCharCode(0x202e) + "Ann", "A"],
    [String.fromCharCode(0x200f, 0x2066) + "bob", "B"],
    [String.fromCharCode(0xfeff, 0x200b) + "王", "王"],
    [String.fromCharCode(0x200b), "?"],
    [String.fromCharCode(0x202e, 0x3000, 0x200e), "?"],
  ])("開頭不可見字元 %j → %j", (name, expected) => {
    expect(firstGrapheme(name)).toBe(expected);
  });
});
