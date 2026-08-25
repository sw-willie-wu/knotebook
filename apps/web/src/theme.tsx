import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark" | "system";

export type Accent = "indigo" | "blue" | "teal" | "sage" | "rose" | "gold";

export const ACCENTS: Accent[] = ["indigo", "blue", "teal", "sage", "rose", "gold"];

const STORAGE_KEY = "knotebook:theme";
const ACCENT_STORAGE_KEY = "knotebook:accent";

interface ThemeContextValue {
  /** 使用者選擇的模式，含 'system'。 */
  theme: Theme;
  /** 'system' 展開後實際套用的模式，供 UI 顯示目前是亮/暗。 */
  resolvedTheme: "light" | "dark";
  setTheme: (theme: Theme) => void;
  /** 使用者選擇的主題色，六選一，預設 'indigo'。 */
  accent: Accent;
  setAccent: (accent: Accent) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveTheme(theme: Theme): "light" | "dark" {
  return theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
}

function applyResolvedTheme(resolved: "light" | "dark"): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

function readStoredAccent(): Accent {
  if (typeof window === "undefined") return "indigo";
  const stored = window.localStorage.getItem(ACCENT_STORAGE_KEY);
  return (ACCENTS as string[]).includes(stored ?? "") ? (stored as Accent) : "indigo";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  // resolvedTheme 是 state（不是從 theme 衍生的 useMemo）：theme === 'system' 時
  // 它可能在 theme 本身沒變的情況下改變（OS 切換 prefers-color-scheme），
  // 一定要是 state 才能觸發用到它的元件重渲染。
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() => resolveTheme(theme));

  // theme 改變（含初始掛載）時，依當下的 theme 重新算一次 resolvedTheme。
  useEffect(() => {
    setResolvedTheme(resolveTheme(theme));
  }, [theme]);

  useEffect(() => {
    applyResolvedTheme(resolvedTheme);
  }, [resolvedTheme]);

  // theme === 'system' 時追隨作業系統切換（例如使用者在系統設定切換深色模式）：
  // 直接讀 change 事件當下的 media.matches 寫回 state，而不是重新呼叫
  // resolveTheme('system')（兩者理論上同值，但直接用事件值更貼近「這次事件告訴我們什麼」）。
  useEffect(() => {
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => setResolvedTheme(media.matches ? "dark" : "light");
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const [accent, setAccentState] = useState<Accent>(() => readStoredAccent());

  // 屬性存在語意：恆設 data-accent（indigo 也設），與防閃腳本「非法值不設屬性」
  // 不對稱——兩者在 indigo 情況下呈現同色（基底 fallback＝indigo 值），見 index.css
  // 與防閃腳本上方註解。
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute("data-accent", accent);
  }, [accent]);

  const setAccent = useCallback((next: Accent) => {
    setAccentState(next);
    window.localStorage.setItem(ACCENT_STORAGE_KEY, next);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme, accent, setAccent }),
    [theme, resolvedTheme, setTheme, accent, setAccent],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
