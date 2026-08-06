import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ThemeProvider, useTheme } from "./theme";

const STORAGE_KEY = "knotebook:theme";

function Probe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button onClick={() => setTheme("dark")}>dark</button>
      <button onClick={() => setTheme("light")}>light</button>
      <button onClick={() => setTheme("system")}>system</button>
    </div>
  );
}

describe("ThemeProvider / useTheme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  it("defaults to 'system' and does not add .dark when the OS prefers light", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("theme")).toHaveTextContent("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("switching to 'dark' writes localStorage and adds the .dark class to <html>", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    act(() => {
      screen.getByText("dark").click();
    });

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
  });

  it("switching to 'light' writes localStorage and removes the .dark class", () => {
    window.localStorage.setItem(STORAGE_KEY, "dark");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    act(() => {
      screen.getByText("light").click();
    });

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("reads a previously stored theme from localStorage on mount", () => {
    window.localStorage.setItem(STORAGE_KEY, "dark");

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("updates resolvedTheme when the OS theme flips while theme === 'system'", () => {
    // jsdom 沒有實作 matchMedia，補一個最小假的 MediaQueryList：可變的
    // `matches`、記錄 change listener，讓測試能手動觸發「OS 切換深色模式」。
    let changeListener: (() => void) | undefined;
    const fakeMql = {
      matches: false,
      addEventListener: (event: string, listener: () => void) => {
        if (event === "change") changeListener = listener;
      },
      removeEventListener: (event: string, listener: () => void) => {
        if (event === "change" && changeListener === listener) changeListener = undefined;
      },
    };
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = (() => fakeMql) as unknown as typeof window.matchMedia;

    try {
      render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );

      // 初始：theme='system'、OS 回報淺色 → resolvedTheme='light'、無 .dark。
      expect(screen.getByTestId("theme")).toHaveTextContent("system");
      expect(screen.getByTestId("resolved")).toHaveTextContent("light");
      expect(document.documentElement.classList.contains("dark")).toBe(false);

      // 模擬 OS 切到深色：flip matches 後觸發 change listener（theme 本身沒變）。
      act(() => {
        fakeMql.matches = true;
        changeListener?.();
      });

      expect(screen.getByTestId("theme")).toHaveTextContent("system");
      expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("throws when useTheme() is used outside a ThemeProvider", () => {
    function Bare() {
      useTheme();
      return null;
    }
    // React 18+ 在開發模式下對未捕捉的 render error 會多印一次 console.error，
    // 這裡只關心會 throw，用 expect(...).toThrow 已經足夠不需要額外消音。
    expect(() => render(<Bare />)).toThrow(/ThemeProvider/);
  });
});
