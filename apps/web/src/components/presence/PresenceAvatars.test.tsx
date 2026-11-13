import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import i18n from "@/i18n";
import type { CursorScroller } from "@/collab/cursor-scroll";
import { LONG_PRESS_MS } from "@/lib/long-press";
import { PresenceAvatars, type PresenceAvatarsProps } from "./PresenceAvatars";
import { agentState, fakeProvider, removeRemote, setRemote, userState } from "./test-awareness";

// #293：頁頭頭像列。Host 照 NotePage 的 `<header className="@container …">` 掛法。

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

const cur = (tag: string) => ({ anchor: { tag }, head: { tag } });

function Host(props: PresenceAvatarsProps) {
  return (
    <header className="@container flex items-center gap-3">
      <PresenceAvatars {...props} />
    </header>
  );
}

function mount(aw: Awareness, overrides: Partial<PresenceAvatarsProps> = {}) {
  const scroller = vi.fn<(cursor: unknown) => boolean>(() => true);
  const scrollerRef: { current: CursorScroller | null } = { current: scroller };
  const props: PresenceAvatarsProps = { provider: fakeProvider(aw), connected: true, myUserId: "u-me", scrollerRef, ...overrides };
  const r = render(<Host {...props} />);
  return { ...r, scroller, scrollerRef, rerenderWith: (o: Partial<PresenceAvatarsProps>) => r.rerender(<Host {...props} {...o} />) };
}

/** 依 key 字典序首屏排序：agent:15、u-a、u-b、u-c、u-d、u-e。 */
function six(aw: Awareness) {
  setRemote(aw, 10, userState("u-a", "Ann", { cursor: cur("a") }));
  setRemote(aw, 11, userState("u-b", "Bob"));
  setRemote(aw, 12, userState("u-c", "Cid", { cursor: cur("c") }));
  setRemote(aw, 13, userState("u-d", "Dee"));
  setRemote(aw, 14, userState("u-e", "Eve", { role: "viewer" }));
  setRemote(aw, 15, agentState("w", "claude", { cursor: cur("w") }));
}

function group(): HTMLElement {
  return screen.getByRole("group", { name: "Also viewing this note" });
}

/** 頭像按鈕（不含 +N）。 */
function personButtons(): HTMLElement[] {
  return within(group())
    .getAllByRole("button")
    .filter((b) => !b.hasAttribute("aria-haspopup"));
}

/** React／Radix 事件處理器裡丟的錯不會穿過 `fireEvent`（jsdom 改報到 window 的 error 事件），`not.toThrow` 抓不到；這裡收集。 */
function collectErrors(): { errors: unknown[]; stop: () => void } {
  const errors: unknown[] = [];
  const onError = (e: ErrorEvent) => {
    errors.push(e.error);
    e.preventDefault();
  };
  window.addEventListener("error", onError);
  return { errors, stop: () => window.removeEventListener("error", onError) };
}

beforeEach(async () => {
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
  awarenesses.splice(0).forEach((a) => a.destroy());
});

describe("PresenceAvatars", () => {
  it("PA1 名稱與不播報；只有我或未連線 → 不渲染", () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "Ann"));
    const { container, unmount } = mount(aw);
    const g = group();
    for (let el: HTMLElement | null = g; el && el !== container.parentElement; el = el.parentElement) {
      expect(el).not.toHaveAttribute("aria-live");
      expect(el.getAttribute("role")).not.toBe("status");
      expect(el.getAttribute("role")).not.toBe("log");
    }
    unmount();

    const mine = newAwareness();
    setRemote(mine, 10, userState("u-me", "Me"));
    const onlyMe = mount(mine);
    expect(onlyMe.container.querySelector('[role="group"]')).toBeNull();
    expect(onlyMe.container.querySelector("header")!.childElementCount).toBe(0);
    onlyMe.unmount();

    const off = mount(aw, { connected: false });
    expect(off.container.querySelector('[role="group"]')).toBeNull();
  });

  it("PA2 可及名稱：人四形（有無角色、有無游標）、空名字退 ?", () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "Ann", { cursor: cur("a") }));
    setRemote(aw, 11, userState("u-b", "Ann B"));
    setRemote(aw, 12, userState("u-c", "Old C", { field: false, cursor: cur("c") }));
    setRemote(aw, 13, userState("u-d", "Old D", { field: false }));
    setRemote(aw, 14, userState("u-e", "", { role: "viewer" }));
    mount(aw);
    expect(screen.getByRole("button", { name: "Ann, Editor, go to their cursor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ann B, Editor, no cursor right now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Old C, go to their cursor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Old D, no cursor right now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "?, Viewer, no cursor right now" })).toBeInTheDocument();
  });

  it("PA2 可及名稱：AI 兩形", () => {
    const aw = newAwareness();
    setRemote(aw, 20, agentState("w", "claude", { cursor: cur("w") }));
    setRemote(aw, 21, agentState("x", "bot"));
    mount(aw);
    expect(screen.getByRole("button", { name: "w (claude), AI agent, go to its cursor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "x (bot), AI agent, no cursor right now" })).toBeInTheDocument();
  });

  it("PA2 可及名稱：名字只有不可見字元（零寬空白、RLO）也退 ?", () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", String.fromCharCode(0x200b), { role: "viewer" }));
    setRemote(aw, 11, userState("u-b", String.fromCharCode(0x202e, 0x200e), { role: "viewer", cursor: cur("b") }));
    mount(aw);
    expect(screen.getByRole("button", { name: "?, Viewer, no cursor right now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "?, Viewer, go to their cursor" })).toBeInTheDocument();
  });

  it("PA2 可及名稱：zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "王小明", { role: "viewer" }));
    render(
      <Host provider={fakeProvider(aw)} connected myUserId="u-me" scrollerRef={{ current: null }} />,
    );
    expect(screen.getByRole("group", { name: "目前也在這篇的人" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "王小明，檢視者，目前沒有游標位置" })).toBeInTheDocument();
  });

  it("PA3 Tooltip：focus 與 hover 都開；按鈕上沒有 aria-describedby", async () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "Ann", { cursor: cur("a") }));
    mount(aw);
    const btn = screen.getByRole("button", { name: "Ann, Editor, go to their cursor" });
    act(() => {
      btn.focus();
    });
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("Ann · Editor");
    expect(tip).toHaveTextContent("Click to go to their cursor");
    expect(btn).not.toHaveAttribute("aria-describedby");
    expect(btn).toHaveAccessibleDescription("");
    act(() => {
      btn.blur();
    });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    fireEvent.pointerMove(btn, { pointerType: "mouse" });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Ann · Editor");
  });

  it("PA3 Tooltip：AI 與無游標的第二行", async () => {
    const aw = newAwareness();
    setRemote(aw, 20, agentState("w", "claude", { cursor: cur("w") }));
    setRemote(aw, 11, userState("u-b", "Bob"));
    mount(aw);
    const ai = screen.getByRole("button", { name: "w (claude), AI agent, go to its cursor" });
    act(() => {
      ai.focus();
    });
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("w (claude) · AI agent");
    expect(tip).toHaveTextContent("Click to go to its cursor");
    const bob = screen.getByRole("button", { name: "Bob, Editor, no cursor right now" });
    act(() => {
      bob.focus();
    });
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Bob · Editor"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("No cursor right now");
  });

  it("PA4 點擊捲動：讀即時 cursor；無游標不呼叫；scroller 為 null 不丟錯", () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "Ann", { cursor: cur("a1") }));
    setRemote(aw, 11, userState("u-b", "Bob"));
    const { scroller, scrollerRef } = mount(aw);
    const fresh = cur("a2");
    setRemote(aw, 10, userState("u-a", "Ann", { cursor: fresh })); // 不推幀：不重繪
    fireEvent.click(screen.getByRole("button", { name: "Ann, Editor, go to their cursor" }));
    expect(scroller).toHaveBeenCalledTimes(1);
    expect(scroller.mock.calls[0]![0]).toBe(fresh);
    fireEvent.click(screen.getByRole("button", { name: "Bob, Editor, no cursor right now" }));
    expect(scroller).toHaveBeenCalledTimes(1);
    scrollerRef.current = null;
    const caught = collectErrors();
    fireEvent.click(screen.getByRole("button", { name: "Ann, Editor, go to their cursor" }));
    caught.stop();
    expect(caught.errors).toEqual([]);
  });

  it("PA5 點頭像、在頭像上按 Enter、pointerdown 都不開選單", () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "Ann", { cursor: cur("a") }));
    setRemote(aw, 11, userState("u-b", "Bob"));
    const { scroller } = mount(aw);
    const btn = screen.getByRole("button", { name: "Ann, Editor, go to their cursor" });
    fireEvent.click(btn);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(scroller).toHaveBeenCalledTimes(1);
    // Enter 的 keydown 不得被 preventDefault（否則原生 button 不會轉成 click）
    expect(fireEvent.keyDown(btn, { key: "Enter" })).toBe(true);
    fireEvent.click(btn);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(scroller).toHaveBeenCalledTimes(2);
    expect(fireEvent.pointerDown(btn, { pointerType: "mouse", button: 0 })).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(group()).not.toHaveAttribute("aria-haspopup");
  });

  it("PA6 容量與 +N：6 位 → 4 顆＋寬 +2／窄 +5／精簡 +6；疊放結構", () => {
    const aw = newAwareness();
    six(aw);
    mount(aw);
    const btns = personButtons();
    expect(btns).toHaveLength(4);
    // 手機（< 640）只剩精簡 +N：每顆頭像都帶 max-sm:hidden；窄形留下的那顆在 640 以上不藏
    expect(btns[0]).toHaveClass("max-sm:hidden");
    expect(btns[0]).not.toHaveClass("@max-[43.5rem]:hidden");
    for (const b of btns.slice(1)) expect(b).toHaveClass("max-sm:hidden", "@max-[43.5rem]:hidden");
    expect(screen.getAllByRole("button", { name: /more, show everyone/ })).toHaveLength(3);
    const wide = screen.getByRole("button", { name: "2 more, show everyone" });
    const narrow = screen.getByRole("button", { name: "5 more, show everyone" });
    const compact = screen.getByRole("button", { name: "6 more, show everyone" });
    expect(wide).toHaveClass("max-sm:hidden", "@max-[43.5rem]:hidden");
    for (const cls of ["sm:@min-[43.5rem]:hidden", "sm:hidden"]) expect(wide).not.toHaveClass(cls);
    expect(narrow).toHaveClass("max-sm:hidden", "sm:@min-[43.5rem]:hidden");
    for (const cls of ["@max-[43.5rem]:hidden", "sm:hidden"]) expect(narrow).not.toHaveClass(cls);
    expect(compact).toHaveClass("sm:hidden");
    for (const cls of ["max-sm:hidden", "@max-[43.5rem]:hidden", "sm:@min-[43.5rem]:hidden"]) expect(compact).not.toHaveClass(cls);
    for (const b of [wide, narrow, compact]) {
      expect(b).toHaveAttribute("aria-haspopup", "menu");
      expect(b).toHaveAttribute("aria-expanded", "false");
    }
    // 聚焦／hover 的那顆浮到上層，焦點框不被下一顆蓋住
    for (const b of [...btns, wide, narrow, compact]) expect(b).toHaveClass("focus-visible:z-10", "hover:z-10");
    const g = group();
    expect(g).toHaveClass("[&>button+button]:-ms-1.5");
    expect(g.className).not.toContain("space-x");
    const first = g.firstElementChild as HTMLElement;
    expect(first.tagName).toBe("SPAN");
    expect(first).toHaveAttribute("aria-hidden", "true");
    expect(first.tabIndex).toBe(-1);
    fireEvent.click(wide);
    expect(wide).toHaveAttribute("aria-expanded", "true");
  });

  it("#335 頭像尺寸：頁首每顆頭像與 +N 都是 24px，點擊區 ::before 預設 32×32、觸控裝置 36×44（x 伸出量 ≤ 疊放的 6px，不蓋鄰居中心）；手機精簡 +N 視覺 32×28、點擊區 40×44", () => {
    const aw = newAwareness();
    six(aw);
    mount(aw);
    for (const b of personButtons()) {
      const circle = b.firstElementChild as HTMLElement;
      expect(circle.style.width).toBe("24px");
      expect(circle.style.height).toBe("24px");
      expect(b).toHaveClass("before:-inset-x-1", "before:-inset-y-1", "pointer-coarse:before:-inset-x-1.5", "pointer-coarse:before:-inset-y-2.5");
    }
    for (const name of ["2 more, show everyone", "5 more, show everyone"]) {
      const more = screen.getByRole("button", { name });
      expect(more).toHaveClass("h-6", "w-6");
      expect(more).not.toHaveClass("h-7");
      expect(more).toHaveClass("before:-inset-x-1", "before:-inset-y-1", "pointer-coarse:before:-inset-x-1.5", "pointer-coarse:before:-inset-y-2.5");
    }
    // 精簡 +N 只在手機寬出現、前面沒有鄰居可蓋：視覺 32×28（h-7 w-8），::before 擴成 40×44
    const compact = screen.getByRole("button", { name: "6 more, show everyone" });
    expect(compact).toHaveClass("h-7", "w-8", "before:-inset-x-1", "before:-inset-y-2");
    for (const cls of ["h-6", "w-6"]) expect(compact).not.toHaveClass(cls);
    // 手機寬時它前面接的是連線點，疊放用的負邊距要清掉；點擊區不帶頭像那組擴大 class
    expect(compact).toHaveClass("max-sm:ms-0!");
    expect(compact).not.toHaveClass("before:-inset-y-1");
    expect(compact.className).not.toMatch(/pointer-coarse:|max-sm:before:/);
  });

  it("PA6 容量：5 位 → 5 顆、窄 +4 與精簡 +5；2 位 → 兩顆在寬窄形都不藏，只有精簡 +2", () => {
    const aw = newAwareness();
    for (const [i, id] of ["u-a", "u-b", "u-c", "u-d", "u-e"].entries()) setRemote(aw, 10 + i, userState(id, id));
    const five = mount(aw);
    const btns = personButtons();
    expect(btns).toHaveLength(5);
    expect(btns[0]).toHaveClass("max-sm:hidden");
    expect(btns[0]).not.toHaveClass("@max-[43.5rem]:hidden");
    for (const b of btns.slice(1)) expect(b).toHaveClass("max-sm:hidden", "@max-[43.5rem]:hidden");
    expect(screen.getByRole("button", { name: "4 more, show everyone" })).toHaveClass("sm:@min-[43.5rem]:hidden");
    expect(screen.getByRole("button", { name: "5 more, show everyone" })).toHaveClass("sm:hidden");
    expect(screen.queryAllByRole("button", { name: /more, show everyone/ })).toHaveLength(2);
    five.unmount();

    const two = newAwareness();
    setRemote(two, 10, userState("u-a", "Ann"));
    setRemote(two, 11, userState("u-b", "Bob"));
    mount(two);
    for (const b of personButtons()) {
      expect(b).toHaveClass("max-sm:hidden");
      expect(b).not.toHaveClass("@max-[43.5rem]:hidden");
    }
    const chips = screen.getAllByRole("button", { name: /more, show everyone/ });
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveAccessibleName("2 more, show everyone");
    expect(chips[0]).toHaveClass("sm:hidden");
  });

  it("PA6 精簡 +N：一位 → +1；沒有其他人 → 不渲染", () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "Ann"));
    const one = mount(aw);
    expect(screen.getByRole("button", { name: "1 more, show everyone" })).toHaveClass("sm:hidden");
    one.unmount();

    const none = newAwareness();
    mount(none);
    expect(screen.queryAllByRole("button", { name: /more, show everyone/ })).toHaveLength(0);
  });

  it("PA6 精簡 +N：點了開完整名單；Esc 後開它的那顆被藏就退到第一顆看得見的頭像", async () => {
    const aw = newAwareness();
    six(aw);
    mount(aw);
    const compact = screen.getByRole("button", { name: "6 more, show everyone" });
    expect(compact).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(compact);
    expect(compact).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "People on this note (6)" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(6);
    // 模擬 640 以上：精簡那顆是 display:none，其餘看得見
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) =>
      el === compact ? ({ display: "none" } as CSSStyleDeclaration) : real(el, pseudo),
    );
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const target = personButtons()[0]!;
    await waitFor(() => expect(target).toHaveFocus());
    expect(compact).not.toHaveFocus();
  });

  it("PA7 完整名單：名稱、6 列同序、無游標列 aria-disabled、選一列捲動並關閉；Esc 焦點回 +N", async () => {
    const aw = newAwareness();
    six(aw);
    const { scroller } = mount(aw);
    const more = screen.getByRole("button", { name: "2 more, show everyone" });
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "People on this note (6)" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.getAttribute("data-person-key"))).toEqual([
      "agent:15",
      "user:u-a",
      "user:u-b",
      "user:u-c",
      "user:u-d",
      "user:u-e",
    ]);
    for (const i of [2, 4, 5]) {
      expect(items[i]).toHaveAttribute("aria-disabled", "true");
      expect(items[i]).not.toHaveAttribute("data-disabled");
      expect(items[i]).toHaveTextContent("No cursor");
      // 沒有游標也要看得到角色（觸控沒有 Tooltip，名單是唯一處）
      expect(items[i]).toHaveTextContent(i === 5 ? "Viewer" : "Editor");
    }
    for (const i of [0, 1, 3]) expect(items[i]).not.toHaveTextContent("No cursor");
    for (const i of [0, 1, 3]) expect(items[i]).not.toHaveAttribute("aria-disabled");
    expect(items[1]).toHaveTextContent("Editor");
    expect(items[0]).toHaveTextContent("AI agent");
    // 名字與右側小字之間有空白，可及名稱不黏成一個字
    expect(items[1]).toHaveAccessibleName("Ann Editor");
    expect(items[5]).toHaveAccessibleName("Eve Viewer No cursor");
    // 列頭像的分隔圈用選單底色
    expect((items[1]!.querySelector('[aria-hidden="true"]') as HTMLElement).style.boxShadow).toContain("var(--color-popover)");
    fireEvent.click(items[3]!);
    expect(scroller).toHaveBeenCalledTimes(1);
    expect(scroller.mock.calls[0]![0]).toEqual(cur("c"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await waitFor(() => expect(more).toHaveFocus());
    fireEvent.click(more);
    fireEvent.keyDown(screen.getByRole("menu", { name: "People on this note (6)" }), { key: "Escape" });
    await waitFor(() => expect(more).toHaveFocus());
  });

  it("PA7c 沒有游標的列可用方向鍵到達；選取它不捲動、不拋錯、選單不關", async () => {
    const aw = newAwareness();
    six(aw);
    const { scroller } = mount(aw);
    fireEvent.click(screen.getByRole("button", { name: "2 more, show everyone" }));
    const menu = screen.getByRole("menu", { name: "People on this note (6)" });
    const items = within(menu).getAllByRole("menuitem");
    // items[2] 是第一個沒有游標的列（Bob）
    items[1]!.focus();
    fireEvent.keyDown(items[1]!, { key: "ArrowDown" });
    await waitFor(() => expect(items[2]).toHaveFocus());
    expect(items[2]).toHaveAttribute("aria-disabled", "true");
    const caught = collectErrors();
    // 選單還開著才是「選了沒反應」的真正守衛（沒游標時 scroller 本來就不會被呼叫）
    for (const press of [
      () => fireEvent.keyDown(items[2]!, { key: "Enter" }),
      () => fireEvent.keyDown(items[2]!, { key: " " }),
      () => fireEvent.click(items[2]!),
    ]) {
      press();
      expect(screen.getByRole("menu", { name: "People on this note (6)" })).toBeInTheDocument();
    }
    caught.stop();
    expect(caught.errors).toEqual([]);
    // 有游標的列照舊：捲動並關閉
    fireEvent.click(items[3]!);
    expect(scroller).toHaveBeenCalledTimes(1);
  });

  it("PA7b 沒有游標的 AI 列同時顯示 AI agent 與 No cursor", () => {
    const aw = newAwareness();
    six(aw);
    setRemote(aw, 15, agentState("w", "claude"));
    mount(aw);
    fireEvent.click(screen.getByRole("button", { name: "2 more, show everyone" }));
    const item = within(screen.getByRole("menu")).getAllByRole("menuitem").find((i) => i.dataset.personKey === "agent:15")!;
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("AI agent");
    expect(item).toHaveTextContent("No cursor");
  });

  it("PA8 選單列出全部的人（含已顯示的頭像）", () => {
    const aw = newAwareness();
    six(aw);
    mount(aw);
    fireEvent.click(screen.getByRole("button", { name: "2 more, show everyone" }));
    const menu = screen.getByRole("menu", { name: "People on this note (6)" });
    for (const name of ["w (claude)", "Ann", "Bob", "Cid", "Dee", "Eve"]) {
      expect(within(menu).getByText(name)).toBeInTheDocument();
    }
  });

  it("PA11 選單開著時名單變動：列跟著少、+N 消失；Esc 焦點退到第一顆頭像", async () => {
    const aw = newAwareness();
    six(aw);
    mount(aw);
    fireEvent.click(screen.getByRole("button", { name: "2 more, show everyone" }));
    removeRemote(aw, 13);
    removeRemote(aw, 14);
    pushFrame();
    const menu = screen.getByRole("menu", { name: "People on this note (4)" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(4);
    expect(document.querySelector('[aria-label="2 more, show everyone"]')).toBeNull();
    const caught = collectErrors();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const first = screen.getByRole("button", { name: "w (claude), AI agent, go to its cursor" });
    await waitFor(() => expect(first).toHaveFocus());
    caught.stop();
    expect(caught.errors).toEqual([]);
  });

  it("PA12 斷線 → 消失；重連 → 回來，且開著的選單不跟著回來", async () => {
    const aw = newAwareness();
    six(aw);
    const { container, rerenderWith } = mount(aw);
    fireEvent.click(screen.getByRole("button", { name: "2 more, show everyone" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    rerenderWith({ connected: false });
    expect(container.querySelector('[role="group"]')).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    rerenderWith({ connected: true });
    expect(group()).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("PA13 超長名字＋RLO：Tooltip 與名單列的名字以 <bdi> 隔離並截斷，角色字在 bdi 之外", async () => {
    const RLO = String.fromCharCode(0x202e);
    const name = `Ann${RLO}${"x".repeat(300)}`;
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", name, { cursor: cur("a") }));
    mount(aw);
    const btn = screen.getByRole("button", { name: `${name}, Editor, go to their cursor` });
    act(() => {
      btn.focus();
    });
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveClass("max-w-64");
    const tipName = tip.querySelector("bdi")!;
    expect(tipName).not.toBeNull();
    expect(tipName.textContent).toBe(name);
    expect(tipName).toHaveClass("truncate", "min-w-0");
    expect(tipName.parentElement).toHaveClass("flex", "min-w-0");
    expect(tipName.nextElementSibling).toHaveTextContent("· Editor");
    // 長按（contextmenu 路徑）開名單
    fireEvent.pointerDown(btn, { pointerType: "touch", clientX: 0, clientY: 0 });
    fireEvent.contextMenu(btn);
    fireEvent.pointerUp(btn, { pointerType: "touch" });
    const row = within(screen.getByRole("menu")).getByRole("menuitem");
    const rowName = row.querySelector("bdi")!;
    expect(rowName).not.toBeNull();
    expect(rowName.textContent).toBe(name);
    expect(rowName).toHaveClass("truncate", "min-w-0");
    expect(rowName.nextElementSibling).toHaveTextContent("Editor");
    expect(rowName.textContent).not.toContain("Editor");
  });

  describe("長按（fake timers）", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function two(aw: Awareness) {
      setRemote(aw, 10, userState("u-a", "Ann", { cursor: cur("a") }));
      setRemote(aw, 11, userState("u-b", "Bob"));
    }

    /** 觸控長按 → 選單開、焦點在該列 → 手指放開 → 補發的 click 不捲。 */
    function longPress(btn: HTMLElement, key: string, scroller: ReturnType<typeof vi.fn>) {
      fireEvent.pointerDown(btn, { pointerType: "touch", clientX: 0, clientY: 0 });
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      act(() => {
        vi.advanceTimersByTime(0);
      });
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(document.activeElement).toBe(screen.getByRole("menu").querySelector(`[data-person-key="${key}"]`));
      fireEvent.pointerUp(btn, { pointerType: "touch" });
      fireEvent.click(btn);
      expect(scroller).not.toHaveBeenCalled();
    }

    function escape() {
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      act(() => {
        vi.advanceTimersByTime(0);
      });
    }

    function pressAndEscape() {
      const aw = newAwareness();
      two(aw);
      const { scroller } = mount(aw);
      const ann = screen.getByRole("button", { name: "Ann, Editor, go to their cursor" });
      longPress(ann, "user:u-a", scroller);
      escape();
      expect(ann).toHaveFocus();
      expect(screen.queryByRole("tooltip")).toBeNull();
      return ann;
    }

    it("PA9 (a)(b) 長按開選單、焦點在該列、click 不捲；Esc 焦點回頭像且 Tooltip 被抑制；按鍵解除抑制", () => {
      const ann = pressAndEscape();
      fireEvent.keyDown(ann, { key: "Shift" });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    });

    it("PA9(c) blur 解除抑制且不留下 tooltip；再聚焦是新的聚焦", () => {
      const ann = pressAndEscape();
      act(() => {
        ann.blur();
      });
      expect(screen.queryByRole("tooltip")).toBeNull();
      act(() => {
        ann.focus();
      });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    });

    it("PA9(d) pointerdown 解除抑制且不留下 tooltip；hover 再開", () => {
      const ann = pressAndEscape();
      fireEvent.pointerDown(ann, { pointerType: "mouse", button: 0 });
      expect(screen.queryByRole("tooltip")).toBeNull();
      fireEvent.pointerUp(ann, { pointerType: "mouse" });
      fireEvent.pointerMove(ann, { pointerType: "mouse" });
      // 還焦點時 Radix 的 onChange(true) 已把 provider 的延遲關掉（抑制中的關閉不回呼 onChange(false)），
      // 這次 hover 其實不等 300 ms；推 300 ms 只是不依賴這個細節。
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    });

    it("PA10 長按沒有游標的人：aria-disabled 列仍取得焦點；Esc 焦點回該顆", () => {
      const aw = newAwareness();
      two(aw);
      const { scroller } = mount(aw);
      const bob = screen.getByRole("button", { name: "Bob, Editor, no cursor right now" });
      const caught = collectErrors();
      longPress(bob, "user:u-b", scroller);
      expect(document.activeElement).toHaveAttribute("aria-disabled", "true");
      escape();
      expect(bob).toHaveFocus();
      caught.stop();
      expect(caught.errors).toEqual([]);
    });

    it("PA14 選單開著時開它的那顆被藏（display:none）：焦點退到看得見的第一顆，且該顆 Tooltip 被抑制", () => {
      const aw = newAwareness();
      setRemote(aw, 10, userState("u-a", "Ann", { cursor: cur("a") }));
      setRemote(aw, 11, userState("u-b", "Bob", { cursor: cur("b") }));
      const { scroller } = mount(aw);
      const ann = screen.getByRole("button", { name: "Ann, Editor, go to their cursor" });
      const bob = screen.getByRole("button", { name: "Bob, Editor, go to their cursor" });
      longPress(bob, "user:u-b", scroller);
      bob.style.display = "none"; // 模擬寬窄切換後 `max-sm:hidden` 生效
      escape();
      expect(ann).toHaveFocus();
      expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("PA15 選單開著時開它的那顆離開：焦點退到第一顆，且該顆 Tooltip 被抑制", () => {
      const aw = newAwareness();
      setRemote(aw, 10, userState("u-a", "Ann", { cursor: cur("a") }));
      setRemote(aw, 11, userState("u-b", "Bob", { cursor: cur("b") }));
      const { scroller } = mount(aw);
      const ann = screen.getByRole("button", { name: "Ann, Editor, go to their cursor" });
      longPress(screen.getByRole("button", { name: "Bob, Editor, go to their cursor" }), "user:u-b", scroller);
      removeRemote(aw, 11);
      pushFrame();
      escape();
      expect(ann).toHaveFocus();
      expect(screen.queryByRole("tooltip")).toBeNull();
    });
  });
});
