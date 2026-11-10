import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { PRESENCE_FIELD, type AvatarRef, type Role } from "@knotebook/shared";
import { resetLocalPresenceFieldForTest, useLocalPresenceField } from "./local-field";
import { fakeProvider, type FakeProvider } from "./test-awareness";

// #293：本分頁的 `knotebook` 欄；重連（authenticated）同值重寫、斷線（close）清遠端舊 meta。

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const awarenesses: Awareness[] = [];
let now = 1000;

function newAwareness(): Awareness {
  const a = new Awareness(new Y.Doc());
  awarenesses.push(a);
  return a;
}

type Props = {
  provider: { awareness?: Awareness | null } | FakeProvider | null;
  role: Role | null;
  name: string | null;
  avatar: AvatarRef | null;
};

function mount(initial: Props) {
  return renderHook((props: Props) => useLocalPresenceField(props), { initialProps: initial });
}

/** 遠端各自建 Awareness，clock 推到 2，產生「本機收到的那份」update。 */
function remoteAt2(): { id: number; update: Uint8Array } {
  const r = newAwareness();
  r.setLocalState({ user: { id: `u-${r.clientID}`, name: "R" } });
  r.setLocalState({ user: { id: `u-${r.clientID}`, name: "R2" } });
  expect(r.meta.get(r.clientID)!.clock).toBe(2);
  return { id: r.clientID, update: encodeAwarenessUpdate(r, [r.clientID]) };
}

function field(a: Awareness): unknown {
  return a.getLocalState()?.[PRESENCE_FIELD];
}

function clock(a: Awareness): number {
  return a.meta.get(a.clientID)!.clock;
}

beforeEach(() => {
  resetLocalPresenceFieldForTest();
  now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
  awarenesses.splice(0).forEach((a) => a.destroy());
});

describe("useLocalPresenceField", () => {
  it("LF1 寫入 knotebook 欄", () => {
    const aw = newAwareness();
    mount({ provider: { awareness: aw }, role: "owner", name: "Ann", avatar: null });
    expect(field(aw)).toEqual({ v: 1, kind: "user", role: "owner", avatar: null, since: 1000 });
  });

  it.each([
    ["role null", { role: null, name: "Ann" }],
    ["role none", { role: "none", name: "Ann" }],
    ["name null", { role: "owner", name: null }],
  ] as const)("LF2 %s → 不寫", (_label, input) => {
    const aw = newAwareness();
    mount({ provider: { awareness: aw }, role: input.role, name: input.name, avatar: null });
    expect(field(aw)).toBeUndefined();
  });

  it("LF3 角色變了重寫、since 不變", () => {
    const aw = newAwareness();
    const { rerender } = mount({ provider: { awareness: aw }, role: "owner", name: "Ann", avatar: null });
    now = 2000;
    rerender({ provider: { awareness: aw }, role: "viewer", name: "Ann", avatar: null });
    expect(field(aw)).toMatchObject({ role: "viewer", since: 1000 });
  });

  it("LF4 值沒變不寫（每次新的、內容相同的 avatar 物件）", () => {
    const aw = newAwareness();
    const provider = { awareness: aw };
    const { rerender } = mount({ provider, role: "owner", name: "Ann", avatar: { id: UUID, v: 1 } });
    const spy = vi.spyOn(aw, "setLocalStateField");
    for (let i = 0; i < 3; i += 1) rerender({ provider, role: "owner", name: "Ann", avatar: { id: UUID, v: 1 } });
    expect(spy).not.toHaveBeenCalled();
    expect(field(aw)).toMatchObject({ avatar: { id: UUID, v: 1 } });
  });

  it("LF5 改名 since 更新", () => {
    const aw = newAwareness();
    const { rerender } = mount({ provider: { awareness: aw }, role: "owner", name: "Ann", avatar: null });
    now = 3000;
    rerender({ provider: { awareness: aw }, role: "owner", name: "Ann L", avatar: null });
    expect(field(aw)).toMatchObject({ since: 3000 });
  });

  it("LF6 (a) 換 awareness 對新的寫、since 沿用", () => {
    const first = newAwareness();
    const { rerender } = mount({ provider: { awareness: first }, role: "owner", name: "Ann", avatar: null });
    now = 4000;
    const second = newAwareness();
    rerender({ provider: { awareness: second }, role: "owner", name: "Ann", avatar: null });
    expect(field(second)).toEqual({ v: 1, kind: "user", role: "owner", avatar: null, since: 1000 });
  });

  it("LF6 (b) 卸載再掛載（同分頁 NotePage 重掛）since 仍沿用", () => {
    const first = newAwareness();
    const { unmount } = mount({ provider: { awareness: first }, role: "owner", name: "Ann", avatar: null });
    unmount();
    now = 5000;
    const second = newAwareness();
    mount({ provider: { awareness: second }, role: "owner", name: "Ann", avatar: null });
    expect(field(second)).toMatchObject({ since: 1000 });
  });

  it("LF7 provider 沒有 awareness（NotePage 測試的 stub 形）→ 不丟錯", () => {
    expect(() => mount({ provider: {}, role: "owner", name: "Ann", avatar: null })).not.toThrow();
    expect(() => mount({ provider: null, role: "owner", name: "Ann", avatar: null })).not.toThrow();
  });

  it("LF12 deps 離開又回到原值（重連時 role owner→null→owner）→ 不重寫", () => {
    const aw = newAwareness();
    const provider = { awareness: aw };
    const { rerender } = mount({ provider, role: "owner", name: "Ann", avatar: null });
    const c = clock(aw);
    const spy = vi.spyOn(aw, "setLocalStateField");
    rerender({ provider, role: null, name: "Ann", avatar: null });
    rerender({ provider, role: "owner", name: "Ann", avatar: null });
    expect(spy).not.toHaveBeenCalled();
    expect(clock(aw)).toBe(c);
    expect(field(aw)).toEqual({ v: 1, kind: "user", role: "owner", avatar: null, since: 1000 });
  });

  it("LF12 StrictMode 掛載（effect 跑兩次）只寫一次", () => {
    const aw = newAwareness();
    const spy = vi.spyOn(aw, "setLocalStateField");
    renderHook(() => useLocalPresenceField({ provider: { awareness: aw }, role: "owner", name: "Ann", avatar: null }), {
      wrapper: StrictMode,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(field(aw)).toMatchObject({ role: "owner", since: 1000 });
  });

  it("LF8 頭貼變了 since 更新", () => {
    const aw = newAwareness();
    const { rerender } = mount({ provider: { awareness: aw }, role: "owner", name: "Ann", avatar: { id: UUID, v: 1 } });
    now = 4000;
    rerender({ provider: { awareness: aw }, role: "owner", name: "Ann", avatar: { id: UUID, v: 2 } });
    expect(field(aw)).toMatchObject({ since: 4000, avatar: { id: UUID, v: 2 } });
  });

  it("LF9 authenticated → 同值重寫（clock＋1），不換 props 的 rerender 後也成立", () => {
    const aw = newAwareness();
    const provider = fakeProvider(aw);
    const props: Props = { provider, role: "owner", name: "Ann", avatar: null };
    const { rerender } = mount(props);
    const before = field(aw);
    const c = clock(aw);
    const spy = vi.spyOn(aw, "setLocalStateField");
    now = 9000;
    act(() => {
      provider.emit("authenticated");
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(clock(aw)).toBe(c + 1);
    expect(field(aw)).toEqual(before);
    expect(field(aw)).toMatchObject({ since: 1000 });
    rerender(props);
    act(() => {
      provider.emit("authenticated");
    });
    expect(clock(aw)).toBe(c + 2);
    expect(field(aw)).toEqual(before);
  });

  it("LF9 本機還沒有這欄時 authenticated 不寫", () => {
    const aw = newAwareness();
    const provider = fakeProvider(aw);
    mount({ provider, role: null, name: "Ann", avatar: null });
    const c = clock(aw);
    act(() => {
      provider.emit("authenticated");
    });
    expect(field(aw)).toBeUndefined();
    expect(clock(aw)).toBe(c);
  });

  it("LF10 卸載或換 provider 後，舊 provider 的事件無效", () => {
    const aw = newAwareness();
    const remote = remoteAt2();
    const oldProvider = fakeProvider(aw);
    const { rerender, unmount } = mount({ provider: oldProvider, role: "owner", name: "Ann", avatar: null });
    // 留一筆「無 state 的遠端 meta」，close 若還有效就會被刪掉
    applyAwarenessUpdate(aw, remote.update, "server");
    removeAwarenessStates(aw, [remote.id], "provider");
    const c = clock(aw);

    const newProvider = fakeProvider(aw);
    rerender({ provider: newProvider, role: "owner", name: "Ann", avatar: null });
    act(() => {
      oldProvider.emit("authenticated");
      oldProvider.emit("close");
    });
    expect(clock(aw)).toBe(c);
    expect(aw.meta.has(remote.id)).toBe(true);

    unmount();
    act(() => {
      newProvider.emit("authenticated");
      newProvider.emit("close");
    });
    expect(clock(aw)).toBe(c);
    expect(aw.meta.has(remote.id)).toBe(true);
  });

  it("LF11 close → 只刪本機以外、已沒有 state 的遠端 meta；重連後同 clock 的現況被收下", () => {
    const aw = newAwareness();
    const provider = fakeProvider(aw);
    mount({ provider, role: "owner", name: "Ann", avatar: null });
    const r1 = remoteAt2();
    const r2 = remoteAt2();
    applyAwarenessUpdate(aw, r1.update, "server");
    applyAwarenessUpdate(aw, r2.update, "server");
    removeAwarenessStates(aw, [r1.id], "provider");
    act(() => {
      provider.emit("close");
    });
    expect(aw.meta.has(r1.id)).toBe(false);
    expect(aw.meta.has(r2.id)).toBe(true);
    expect(aw.meta.has(aw.clientID)).toBe(true);
    applyAwarenessUpdate(aw, r1.update, "server");
    expect(aw.getStates().has(r1.id)).toBe(true);
  });

  it("LF11 對照：不掛 hook 時同 clock 的現況被函式庫忽略", () => {
    const aw = newAwareness();
    const r1 = remoteAt2();
    applyAwarenessUpdate(aw, r1.update, "server");
    removeAwarenessStates(aw, [r1.id], "provider");
    applyAwarenessUpdate(aw, r1.update, "server");
    expect(aw.getStates().has(r1.id)).toBe(false);
  });
});
