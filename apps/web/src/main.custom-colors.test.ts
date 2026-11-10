import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("main.tsx (#378)", () => {
  it("MN1 在 createRoot 之前安裝自訂色碼登記", () => {
    const src = readFileSync(`${process.cwd()}/src/main.tsx`, "utf8");
    const install = src.indexOf("installCustomColors()");
    expect(install).not.toBe(-1);
    expect(install).toBeLessThan(src.indexOf("createRoot("));
  });
});
