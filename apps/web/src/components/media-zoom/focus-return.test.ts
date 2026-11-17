import { afterEach, describe, expect, it } from "vitest";
import { focusReturnTarget } from "./focus-return";

afterEach(() => {
  document.body.innerHTML = "";
});

function build(html: string): void {
  document.body.innerHTML = html;
}

function byId(id: string): HTMLElement {
  return document.getElementById(id)!;
}

describe("focusReturnTarget", () => {
  it("preferred 在頁面上：回它", () => {
    build(`<div tabindex="0" id="wrap"><img id="media"></div><button id="btn">z</button>`);
    expect(focusReturnTarget(byId("btn"), byId("media"))).toBe(byId("btn"));
  });

  it("preferred 已移除：回 fallback 最近的 tabindex=0 祖先", () => {
    build(`<div tabindex="0" id="wrap"><span><img id="media"></span></div><button id="btn">z</button>`);
    const btn = byId("btn");
    btn.remove();
    expect(focusReturnTarget(btn, byId("media"))).toBe(byId("wrap"));
  });

  it("fallback 本身 tabindex=0：回自己", () => {
    build(`<div tabindex="0" id="outer"><div tabindex="0" id="media"></div></div>`);
    expect(focusReturnTarget(null, byId("media"))).toBe(byId("media"));
  });

  it("tabindex=-1 的祖先跳過", () => {
    build(`<div tabindex="0" id="outer"><div tabindex="-1" id="inner"><img id="media"></div></div>`);
    expect(focusReturnTarget(null, byId("media"))).toBe(byId("outer"));
  });

  it("都沒有可聚焦的：回 null", () => {
    build(`<div><img id="media"></div><button id="btn">z</button>`);
    const btn = byId("btn");
    btn.remove();
    expect(focusReturnTarget(btn, byId("media"))).toBeNull();
  });

  it("fallback 自己也不在頁面上：回 null", () => {
    build(`<div tabindex="0" id="wrap"><img id="media"></div>`);
    const wrap = byId("wrap");
    const media = byId("media");
    wrap.remove();
    expect(focusReturnTarget(null, media)).toBeNull();
  });

  it("兩者都 null：回 null", () => {
    expect(focusReturnTarget(null, null)).toBeNull();
  });
});
