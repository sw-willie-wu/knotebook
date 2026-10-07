import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { BrowserRouter, useLocation, useNavigate } from "react-router";
import { canonicalizedFrom, useHistoryLocationKey, withCanonicalizedFrom } from "./real-location";

// #179：NotePage 的收斂 effect 靠 `useHistoryLocationKey` 判斷「有沒有導覽在途」。它讀的是
// `UNSAFE_NavigationContext.navigator.location`——型別上不保證存在。正式 app 用 BrowserRouter，
// 這裡就在 BrowserRouter 下釘住「讀得到、而且就是 history 當下那一筆的 key」：react-router 升級
// 若改了 navigator 的形狀，這裡會紅，而不是讓防護默默退化成「無法判斷、照常 replace」。

let readKey: (() => string | undefined) | undefined;
let go: ((to: string) => void) | undefined;

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  readKey = useHistoryLocationKey();
  go = (to) => void navigate(to);
  return <div data-testid="rendered-key">{location.key}</div>;
}

describe("useHistoryLocationKey（BrowserRouter）", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    readKey = undefined;
    go = undefined;
  });

  it("回傳 history 當下 entry 的 key，與 render 到的 location.key 一致；導覽後跟著換", async () => {
    window.history.replaceState(null, "", "/start");
    render(
      <BrowserRouter>
        <Probe />
      </BrowserRouter>,
    );

    const first = readKey?.();
    expect(typeof first).toBe("string");
    expect(first).toBe(screen.getByTestId("rendered-key").textContent);

    await act(async () => {
      go?.("/next");
    });
    const second = readKey?.();
    expect(typeof second).toBe("string");
    expect(second).not.toBe(first);
    expect(second).toBe(screen.getByTestId("rendered-key").textContent);
  });
});

describe("canonicalizedFrom 標記", () => {
  it("保留既有 state 的鍵、加上來源 pathname；非物件 state 從空物件起算", () => {
    expect(withCanonicalizedFrom({ openEdits: false }, "/notes/x")).toEqual({
      openEdits: false,
      knotebookCanonicalizedFrom: "/notes/x",
    });
    expect(canonicalizedFrom(withCanonicalizedFrom(null, "/n/a/b"))).toBe("/n/a/b");
    expect(canonicalizedFrom(null)).toBeUndefined();
    expect(canonicalizedFrom({ other: 1 })).toBeUndefined();
  });
});
