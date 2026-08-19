import { readFileSync } from "node:fs";
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

  /**
   * 首屏的深色底色由 `index.html` 內嵌的同步腳本負責（React 掛載前就要打上 class，
   * 否則會閃一下白底）。那段腳本無法 import 本檔的常數，只能複製字面值——這條測試
   * 就是那份複製的釘子：storage key 或 class 名一改而 index.html 沒跟上就會紅。
   */
  it("index.html 的 pre-hydration 腳本與 theme.tsx 用同一組 storage key 與 class", () => {
    // vitest 下的 `import.meta.url` 是 vite 的 http URL，不能餵給 fs——用 cwd
    // （跑 test 時一律是 apps/web）組路徑。
    const html = readFileSync(`${process.cwd()}/index.html`, "utf8");
    const inlineScript = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));

    expect(inlineScript).toContain(STORAGE_KEY);
    expect(inlineScript).toContain("prefers-color-scheme: dark");
    expect(inlineScript).toMatch(/classList\.(add|toggle)\(\s*"dark"/);
  });
});
