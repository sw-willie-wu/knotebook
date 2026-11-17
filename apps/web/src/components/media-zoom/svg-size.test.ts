import { describe, expect, it } from "vitest";
import { svgIntrinsicSize } from "./svg-size";

function svg(attrs: string): SVGSVGElement {
  const host = document.createElement("div");
  host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}></svg>`;
  return host.querySelector("svg") as SVGSVGElement;
}

describe("svgIntrinsicSize", () => {
  it("reads the viewBox", () => {
    expect(svgIntrinsicSize(svg('viewBox="0 0 300 200"'))).toEqual({ width: 300, height: 200 });
  });
  it("falls back to width/height when the viewBox has no area", () => {
    expect(svgIntrinsicSize(svg('viewBox="0 0 0 200" width="120" height="80"'))).toEqual({ width: 120, height: 80 });
  });
  it("falls back to width/height when the viewBox is incomplete", () => {
    expect(svgIntrinsicSize(svg('viewBox="0 0 300" width="120" height="80"'))).toEqual({ width: 120, height: 80 });
  });
  it("accepts px units", () => {
    expect(svgIntrinsicSize(svg('width="120px" height="80px"'))).toEqual({ width: 120, height: 80 });
  });
  it("reads a percentage-width svg with a negative-origin viewBox", () => {
    expect(svgIntrinsicSize(svg('width="100%" style="max-width: 516px;" viewBox="-8 -8 516 300"'))).toEqual({
      width: 516,
      height: 300,
    });
  });
  it("returns null for percentage sizes without a viewBox", () => {
    expect(svgIntrinsicSize(svg('width="100%" height="100%"'))).toBeNull();
  });
  it("returns null when nothing is declared", () => {
    expect(svgIntrinsicSize(svg(""))).toBeNull();
  });
});
