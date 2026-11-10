import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { usePresencePeople } from "./usePresencePeople";
import { setRemote, userState } from "./test-awareness";

// #293：訂閱 awareness、rAF 一幀合併、簽章沒變不 setState、cursorOf 讀即時值。

let frames: FrameRequestCallback[] = [];
const awarenesses: Awareness[] = [];

function newAwareness(): Awareness {
  const a = new Awareness(new Y.Doc());
  awarenesses.push(a);
  return a;
}

function pushFrame() {
  act(() => {
    frames.splice(0).forEach((f) => f(0));
  });
}

let renders = 0;
let latest: ReturnType<typeof usePresencePeople> | null = null;

function Probe({ awareness }: { awareness: Awareness | null }) {
  renders += 1;
  latest = usePresencePeople(awareness, "u-me");
  return null;
}

function keys(): string[] {
  return latest!.people.map((p) => p.key);
}

function changeObservers(a: Awareness): number {
  return a._observers.get("change")?.size ?? 0;
}

beforeEach(() => {
  frames = [];
  renders = 0;
  latest = null;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  awarenesses.splice(0).forEach((a) => a.destroy());
});

describe("usePresencePeople", () => {
  it("UP1 首次 render 就有既有的人；之後新人推一幀後出現", () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "Ann"));
    const perRender: string[][] = [];
    const { result } = renderHook(() => {
      const r = usePresencePeople(aw, "u-me");
      perRender.push(r.people.map((p) => p.key));
      return r;
    });
    // 第一次 render 就有（lazy initializer），不是 effect 補算後的第二次
    expect(perRender[0]).toEqual(["user:u-a"]);
    act(() => {
      setRemote(aw, 11, userState("u-b", "Bob"));
    });
    expect(result.current.people.map((p) => p.key)).toEqual(["user:u-a"]);
    pushFrame();
    expect(result.current.people.map((p) => p.key)).toEqual(["user:u-a", "user:u-b"]);
  });

  it("UP2 同一幀內多次 change 只 render 一次（推幀前不動）", () => {
    const aw = newAwareness();
    render(<Probe awareness={aw} />);
    const before = renders;
    act(() => {
      setRemote(aw, 10, userState("u-a", "Ann"));
      setRemote(aw, 11, userState("u-b", "Bob"));
      setRemote(aw, 12, userState("u-c", "Cat"));
    });
    expect(renders).toBe(before);
    expect(keys()).toEqual([]);
    pushFrame();
    expect(renders).toBe(before + 1);
    expect(keys()).toEqual(["user:u-a", "user:u-b", "user:u-c"]);
  });

  it("UP3 只有心跳變 → 不重繪", () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "Ann", { beat: 1 }));
    render(<Probe awareness={aw} />);
    const before = renders;
    act(() => {
      setRemote(aw, 10, userState("u-a", "Ann", { beat: 2 }));
    });
    pushFrame();
    expect(renders).toBe(before);
  });

  it("UP4／UP5 游標位置變不重繪但 cursorOf 讀到新值；有無游標變才重繪", () => {
    const aw = newAwareness();
    const first = { anchor: { p: 1 }, head: { p: 1 } };
    const second = { anchor: { p: 2 }, head: { p: 2 } };
    setRemote(aw, 10, userState("u-a", "Ann", { cursor: first }));
    render(<Probe awareness={aw} />);
    const before = renders;
    act(() => {
      setRemote(aw, 10, userState("u-a", "Ann", { cursor: second }));
    });
    pushFrame();
    expect(renders).toBe(before);
    expect(latest!.cursorOf("user:u-a")).toBe(second);
    act(() => {
      setRemote(aw, 10, userState("u-a", "Ann", { cursor: null }));
    });
    pushFrame();
    expect(renders).toBe(before + 1);
    expect(latest!.people[0].hasCursor).toBe(false);
  });

  it("UP6 換 awareness：舊的 change 不再影響、新的有人就出現、順序重新起算", () => {
    const oldAw = newAwareness();
    const { rerender } = render(<Probe awareness={oldAw} />);
    act(() => {
      setRemote(oldAw, 11, userState("u-b", "Bob"));
    });
    pushFrame();
    act(() => {
      setRemote(oldAw, 10, userState("u-a", "Ann"));
    });
    pushFrame();
    expect(keys()).toEqual(["user:u-b", "user:u-a"]);

    const newAw = newAwareness();
    setRemote(newAw, 20, userState("u-a", "Ann"));
    setRemote(newAw, 21, userState("u-b", "Bob"));
    rerender(<Probe awareness={newAw} />);
    expect(keys()).toEqual(["user:u-a", "user:u-b"]);

    act(() => {
      setRemote(oldAw, 12, userState("u-z", "Zed"));
    });
    pushFrame();
    expect(keys()).toEqual(["user:u-a", "user:u-b"]);
  });

  it("UP7 卸載：取消待處理的幀、解除 change 訂閱", () => {
    const aw = newAwareness();
    const base = changeObservers(aw);
    const { unmount } = render(<Probe awareness={aw} />);
    expect(changeObservers(aw)).toBe(base + 1);
    act(() => {
      setRemote(aw, 10, userState("u-a", "Ann"));
    });
    expect(frames).toHaveLength(1);
    unmount();
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(changeObservers(aw)).toBe(base);
  });

  it("UP8 awareness 為 null → 空名單、cursorOf 回 null", () => {
    const { result } = renderHook(() => usePresencePeople(null, "u-me"));
    expect(result.current.people).toEqual([]);
    expect(result.current.cursorOf("user:u-a")).toBeNull();
  });
});
