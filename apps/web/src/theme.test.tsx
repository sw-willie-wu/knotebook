import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { THEME_COLOR, ThemeProvider, useTheme } from "./theme";

const STORAGE_KEY = "knotebook:theme";
const ACCENT_STORAGE_KEY = "knotebook:accent";

function Probe() {
  const { theme, resolvedTheme, setTheme, accent, setAccent } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <span data-testid="accent">{accent}</span>
      <button onClick={() => setTheme("dark")}>dark</button>
      <button onClick={() => setTheme("light")}>light</button>
      <button onClick={() => setTheme("system")}>system</button>
      <button onClick={() => setAccent("teal")}>set-accent-teal</button>
    </div>
  );
}

interface InlineScriptResult {
  dark: boolean;
  /** 屬性字面值；防閃腳本對非法值不設屬性，此時為 null。 */
  accent: string | null;
}

/** 把 index.html <head> 裡那段 pre-hydration 腳本抓出來，在 jsdom 裡以指定的
 * storage 值與 OS 偏好執行，回傳它對 dark class 與 data-accent 屬性的判斷。
 * accent／theme 兩段防閃邏輯同擠在同一個 <script> 內（見 index.html 註解），
 * 這裡抓的是整段第一組 <script>...</script> 的原始碼。 */
function runInlineThemeScript(
  stored: string | null,
  prefersDark: boolean,
  storedAccent: string | null = null,
): InlineScriptResult {
  const html = readFileSync(`${process.cwd()}/index.html`, "utf8");
  const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
  const source = head.slice(head.indexOf("<script>") + "<script>".length, head.indexOf("</script>"));

  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-accent");
  window.localStorage.clear();
  if (stored !== null) window.localStorage.setItem(STORAGE_KEY, stored);
  if (storedAccent !== null) window.localStorage.setItem(ACCENT_STORAGE_KEY, storedAccent);
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: prefersDark && query.includes("dark") })) as unknown as typeof window.matchMedia;

  try {
    new Function(source)();
    return {
      dark: document.documentElement.classList.contains("dark"),
      accent: document.documentElement.getAttribute("data-accent"),
    };
  } finally {
    window.matchMedia = originalMatchMedia;
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-accent");
  }
}

/** 同樣的輸入交給真正的 ThemeProvider，回傳它掛載後對 dark class 與
 * data-accent 屬性的判斷。ThemeProvider 恆設 data-accent（indigo 也設）——與
 * 防閃腳本的「非法值不設屬性」不對稱，比對時不得直接比字面值，見呼叫端。 */
function renderThemeProvider(
  stored: string | null,
  prefersDark: boolean,
  storedAccent: string | null = null,
): InlineScriptResult {
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-accent");
  window.localStorage.clear();
  if (stored !== null) window.localStorage.setItem(STORAGE_KEY, stored);
  if (storedAccent !== null) window.localStorage.setItem(ACCENT_STORAGE_KEY, storedAccent);
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: prefersDark && query.includes("dark"),
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;

  try {
    const view = render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    const dark = document.documentElement.classList.contains("dark");
    const accent = document.documentElement.getAttribute("data-accent");
    view.unmount();
    return { dark, accent };
  } finally {
    window.matchMedia = originalMatchMedia;
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-accent");
  }
}

describe("ThemeProvider / useTheme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-accent");
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-accent");
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
    const metas = ["light", "dark"].map((scheme) => {
      const meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.setAttribute("media", `(prefers-color-scheme: ${scheme})`);
      meta.content = "#sentinel";
      document.head.append(meta);
      return meta;
    });

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
      for (const meta of metas) expect(meta.getAttribute("content")).toBe(THEME_COLOR.light);

      // 模擬 OS 切到深色：flip matches 後觸發 change listener（theme 本身沒變）。
      act(() => {
        fakeMql.matches = true;
        changeListener?.();
      });

      expect(screen.getByTestId("theme")).toHaveTextContent("system");
      expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      // theme 沒變、只有 OS 翻轉：theme-color meta 也得跟著（不能只在 theme 改變時才同步）。
      for (const meta of metas) expect(meta.getAttribute("content")).toBe(THEME_COLOR.dark);

      act(() => {
        fakeMql.matches = false;
        changeListener?.();
      });
      for (const meta of metas) expect(meta.getAttribute("content")).toBe(THEME_COLOR.light);
    } finally {
      for (const meta of metas) meta.remove();
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
   * 否則會閃一下白底）。那段腳本無法 import 本檔的常數，只能複製字面值。
   *
   * 這條把腳本真的抓出來執行，逐個 storage 值與 `ThemeProvider` 的結果對照：腳本一旦
   * 與 `readStoredTheme` + `resolveTheme` 不等價（例如把壞值當成淺色而不是 system），
   * 那些使用者的首屏就會一路閃到 React 掛載為止。
   */
  it.each([null, "dark", "light", "system", "", "Dark", "sepia", "auto"])(
    "pre-hydration 腳本對 storage 值 %o 的判斷與 ThemeProvider 等價（OS 深色與淺色各驗一次）",
    (stored) => {
      for (const prefersDark of [false, true]) {
        expect(runInlineThemeScript(stored, prefersDark).dark).toBe(
          renderThemeProvider(stored, prefersDark).dark,
        );
      }
    },
  );

  /**
   * 主題色（accent）防閃的等價案：防閃腳本對非法值「不設屬性」（getAttribute
   * 回 null），ThemeProvider 恆設屬性（indigo 也設）——兩者呈現同色是靠
   * index.css 的 :root/:root.dark 基底 fallback＝indigo 值撐住，不是屬性字面相等。
   * 唯一合法的比對法：兩邊都正規化成「屬性值 ?? "indigo"」再比較。
   */
  it.each([null, "", "indigo", "blue", "teal", "sage", "rose", "gold", "Teal", "cyan"])(
    "pre-hydration 腳本對 accent storage 值 %o 的判斷與 ThemeProvider 等價（正規化後比對）",
    (storedAccent) => {
      const scriptResult = runInlineThemeScript(null, false, storedAccent);
      const providerResult = renderThemeProvider(null, false, storedAccent);

      expect(scriptResult.accent ?? "indigo").toBe(providerResult.accent ?? "indigo");
    },
  );

  it("index.html 的 pre-hydration 腳本與 theme.tsx 用同一組 storage key 與 class", () => {
    // vitest 下的 `import.meta.url` 是 vite 的 http URL，不能餵給 fs——用 cwd
    // （跑 test 時一律是 apps/web）組路徑。
    const html = readFileSync(`${process.cwd()}/index.html`, "utf8");
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    // 只取 script 本體：head 裡另有 `<meta name="theme-color" media="(prefers-color-scheme: dark)">`（#336），
    // 對整段 head 比對會讓下面的 "prefers-color-scheme: dark" 斷言在 script 失去它時照樣綠。
    const inlineScript = head.slice(head.indexOf("<script>"), head.indexOf("</script>"));

    expect(inlineScript).toContain(STORAGE_KEY);
    expect(inlineScript).toContain("prefers-color-scheme: dark");
    expect(inlineScript).toMatch(/classList\.(add|toggle)\(\s*"dark"/);
    expect(inlineScript).toContain(ACCENT_STORAGE_KEY);
    expect(inlineScript).toMatch(/setAttribute\(\s*"data-accent"/);
  });

  it("defaults accent to 'indigo' and sets data-accent on <html>", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("accent")).toHaveTextContent("indigo");
    expect(document.documentElement.getAttribute("data-accent")).toBe("indigo");
  });

  it("reads a previously stored valid accent from localStorage on mount", () => {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, "teal");

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("accent")).toHaveTextContent("teal");
    expect(document.documentElement.getAttribute("data-accent")).toBe("teal");
  });

  it("falls back to 'indigo' when the stored accent is not one of the six valid names", () => {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, "chartreuse");

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("accent")).toHaveTextContent("indigo");
    expect(document.documentElement.getAttribute("data-accent")).toBe("indigo");
  });

  it("switching accent writes localStorage and updates data-accent on <html>", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    act(() => {
      screen.getByText("set-accent-teal").click();
    });

    expect(window.localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("teal");
    expect(document.documentElement.getAttribute("data-accent")).toBe("teal");
    expect(screen.getByTestId("accent")).toHaveTextContent("teal");
  });
});

/**
 * #336 審查要求：<meta name="theme-color"> 要跟 app 內選的主題，而不是只跟裝置設定
 * （index.html 的兩個 meta 靠 media 查詢，只認 OS）。測試自己在 head 建兩個 meta，測完清掉。
 */
describe("ThemeProvider 同步 <meta name=\"theme-color\">", () => {
  let lightMeta: HTMLMetaElement;
  let darkMeta: HTMLMetaElement;
  const originalMatchMedia = window.matchMedia;

  function fakeSystem(prefersDark: boolean) {
    window.matchMedia = ((query: string) => ({
      matches: prefersDark && query.includes("dark"),
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  }

  function renderProvider() {
    return render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
  }

  function expectBoth(color: string) {
    expect(lightMeta.getAttribute("content")).toBe(color);
    expect(darkMeta.getAttribute("content")).toBe(color);
  }

  beforeEach(() => {
    window.localStorage.clear();
    lightMeta = document.createElement("meta");
    lightMeta.name = "theme-color";
    lightMeta.setAttribute("media", "(prefers-color-scheme: light)");
    lightMeta.content = "#sentinel-light";
    darkMeta = document.createElement("meta");
    darkMeta.name = "theme-color";
    darkMeta.setAttribute("media", "(prefers-color-scheme: dark)");
    darkMeta.content = "#sentinel-dark";
    document.head.append(lightMeta, darkMeta);
  });

  afterEach(() => {
    lightMeta.remove();
    darkMeta.remove();
    window.matchMedia = originalMatchMedia;
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-accent");
  });

  it("THEME_COLOR 是淺 #f3f4f6／深 #0e1013", () => {
    expect(THEME_COLOR).toEqual({ light: "#f3f4f6", dark: "#0e1013" });
  });

  it("系統淺色、app 選深色：兩個 meta 都是深色頁底色", () => {
    fakeSystem(false);
    window.localStorage.setItem(STORAGE_KEY, "dark");
    renderProvider();
    expectBoth(THEME_COLOR.dark);
  });

  it("系統深色、app 選淺色：兩個 meta 都是淺色頁底色", () => {
    fakeSystem(true);
    window.localStorage.setItem(STORAGE_KEY, "light");
    renderProvider();
    expectBoth(THEME_COLOR.light);
  });

  it("app 選 system：跟著系統（深色系統→深色，淺色系統→淺色）", () => {
    fakeSystem(true);
    window.localStorage.setItem(STORAGE_KEY, "system");
    const dark = renderProvider();
    expectBoth(THEME_COLOR.dark);
    dark.unmount();

    fakeSystem(false);
    renderProvider();
    expectBoth(THEME_COLOR.light);
  });

  it("主題切換後兩個 meta 都跟著更新（淺→深→淺）", () => {
    fakeSystem(false);
    renderProvider();
    expectBoth(THEME_COLOR.light);

    act(() => {
      screen.getByText("dark").click();
    });
    expectBoth(THEME_COLOR.dark);

    act(() => {
      screen.getByText("light").click();
    });
    expectBoth(THEME_COLOR.light);
  });

  it("head 裡沒有 theme-color meta 時不拋錯", () => {
    lightMeta.remove();
    darkMeta.remove();
    fakeSystem(false);
    window.localStorage.setItem(STORAGE_KEY, "dark");
    expect(() => renderProvider()).not.toThrow();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    // 放回去，讓 afterEach 的 remove 對已卸下的節點也是安全的
    document.head.append(lightMeta, darkMeta);
  });

  it("只動 theme-color：同在 head 的其他 meta 不受影響", () => {
    const other = document.createElement("meta");
    other.name = "description";
    other.content = "keep-me";
    document.head.append(other);
    try {
      fakeSystem(false);
      window.localStorage.setItem(STORAGE_KEY, "dark");
      renderProvider();
      expect(other.getAttribute("content")).toBe("keep-me");
    } finally {
      other.remove();
    }
  });
});
