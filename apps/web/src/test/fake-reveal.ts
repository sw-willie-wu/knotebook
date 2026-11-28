import { vi } from "vitest";

type Listener = (event: Event) => void;

/**
 * A reveal stand-in for the overlay tests (`vi.mock("reveal.js", ...)` swaps the default for it).
 * initialize() resolves in a microtask by default; with `FakeReveal.autoResolve = false` the test calls `resolveInit()`.
 * slide(h, v) sends slidechanged when the index changes (currentSlide is found from our DOM structure); pressKey calls the matching function of config.keyboard.
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
  readonly left = vi.fn(() => {
    if (this.indices.h > 0) this.slide(this.indices.h - 1, 0);
  });
  readonly right = vi.fn(() => {
    const count = this.el.querySelectorAll(":scope > .slides > section").length;
    if (this.indices.h + 1 < count) this.slide(this.indices.h + 1, 0);
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
