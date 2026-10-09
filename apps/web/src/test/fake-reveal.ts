import { vi } from "vitest";

type Listener = (event: Event) => void;

/**
 * #229 overlay 測試用的 reveal 替身（`vi.mock("reveal.js", …)` 把 default 換成它）。
 * initialize() 預設在 microtask 裡 resolve；`FakeReveal.autoResolve = false` 時由測試 `resolveInit()`。
 * slide(h, v) 索引變了就送 slidechanged（currentSlide 依我們的 DOM 結構找）；pressKey 呼叫 config.keyboard 的對應函式。
 */
export class FakeReveal {
  static instances: FakeReveal[] = [];
  static autoResolve = true;
  static configOverride: Record<string, unknown> | null = null;

  static reset(): void {
    FakeReveal.instances = [];
    FakeReveal.autoResolve = true;
    FakeReveal.configOverride = null;
  }

  readonly el: HTMLElement;
  readonly config: Record<string, unknown>;
  indices = { h: 0, v: 0 };
  overview = false;
  private readonly listeners = new Map<string, Set<Listener>>();
  private resolver: (() => void) | null = null;

  readonly initialize = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        this.resolver = resolve;
        if (FakeReveal.autoResolve) queueMicrotask(resolve);
      }),
  );
  readonly destroy = vi.fn();
  readonly sync = vi.fn();
  readonly syncSlide = vi.fn();
  readonly slide = vi.fn((h: number, v = 0) => {
    const changed = h !== this.indices.h || v !== this.indices.v;
    this.indices = { h, v };
    if (changed) this.emitSlideChanged();
  });
  readonly toggleOverview = vi.fn((override?: boolean) => {
    this.overview = override ?? !this.overview;
  });
  readonly isOverview = vi.fn(() => this.overview);
  readonly getIndices = vi.fn(() => ({ ...this.indices, f: 0 }));
  readonly getConfig = vi.fn(() => ({ ...this.config, ...(FakeReveal.configOverride ?? {}) }));

  constructor(el: HTMLElement, config: Record<string, unknown>) {
    this.el = el;
    this.config = config;
    FakeReveal.instances.push(this);
  }

  on(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  off(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  resolveInit(): void {
    this.resolver?.();
  }

  /** controller 在 initialize resolve、核對通過之後才 on("slidechanged")——測試以它判斷「已就緒」。 */
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  currentSlideEl(): HTMLElement | null {
    const top = this.el.querySelectorAll<HTMLElement>(":scope > .slides > section")[this.indices.h];
    if (!top) return null;
    const inner = top.querySelectorAll<HTMLElement>(":scope > section");
    return inner.length > 0 ? (inner[this.indices.v] ?? null) : top;
  }

  emitSlideChanged(): void {
    const event = Object.assign(new Event("slidechanged"), {
      currentSlide: this.currentSlideEl(),
      indexh: this.indices.h,
      indexv: this.indices.v,
    });
    this.listeners.get("slidechanged")?.forEach((fn) => fn(event));
  }

  pressKey(keyCode: number): void {
    const binding = (this.config.keyboard as Record<number, (event: KeyboardEvent) => void>)[keyCode];
    binding?.(new KeyboardEvent("keydown"));
  }
}
