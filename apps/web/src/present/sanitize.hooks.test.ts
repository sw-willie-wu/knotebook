import { describe, expect, it, vi } from "vitest";

// spec §13.1「hook 只註冊一次」：連續呼叫兩次，`uponSanitizeAttribute` hook 每個屬性只被呼叫一次。
const calls = vi.hoisted(() => ({ attr: [] as string[] }));

vi.mock("dompurify", async (importOriginal) => {
  const real = (await importOriginal<typeof import("dompurify")>()).default;
  const factory = ((root: Parameters<typeof real>[0]) => {
    const instance = real(root);
    const originalAddHook = instance.addHook.bind(instance);
    instance.addHook = ((name: string, hook: (...args: unknown[]) => void) => {
      if (name !== "uponSanitizeAttribute") return originalAddHook(name as never, hook as never);
      return originalAddHook(name as never, ((node: unknown, data: { attrName: string }, config: unknown) => {
        calls.attr.push(data.attrName);
        return hook(node, data, config);
      }) as never);
    }) as typeof instance.addHook;
    return instance;
  }) as unknown as typeof real;
  Object.assign(factory, real);
  return { default: factory };
});

describe("sanitize 的 hook 只在模組頂層註冊一次", () => {
  it("同一個輸入淨化兩次：屬性 hook 被呼叫的次數＝屬性數 × 2（不是越疊越多）", async () => {
    const { sanitizeSlideFragment } = await import("./sanitize");
    sanitizeSlideFragment('<p data-foo="1">x</p>');
    const once = calls.attr.length;
    expect(once).toBe(1);
    sanitizeSlideFragment('<p data-foo="1">x</p>');
    expect(calls.attr.length).toBe(2);
  });
});
