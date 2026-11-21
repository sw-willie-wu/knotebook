import { describe, expect, it } from "vitest";
import { fitPills } from "./pill-fit";

describe("fitPills", () => {
  it("fits all when they fit without the +N button", () => expect(fitPills([40, 40], 90, 4, 30)).toBe(2));
  it("reserves the +N width when not all fit", () => expect(fitPills([40, 40, 40], 100, 4, 30)).toBe(1));
  it("still shows the first pill when it plus +N doesn't fit; the caller truncates it", () => {
    expect(fitPills([80], 50, 4, 30)).toBe(1);
    expect(fitPills([80, 40], 50, 4, 30)).toBe(1);
  });
  it("counts the gap between pills", () => {
    expect(fitPills([40, 40], 84, 4, 30)).toBe(2);
    expect(fitPills([40, 40], 83, 4, 30)).toBe(1);
  });
  it("shows nothing for an empty list", () => expect(fitPills([], 0, 4, 30)).toBe(0));
});
