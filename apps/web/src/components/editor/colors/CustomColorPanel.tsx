import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import { isCustomColor } from "@knotebook/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readRecentColors } from "@/lib/recent-colors";
import { parseHexInput } from "./hex-input";
import type { PanelRequest } from "./types";

const ColorfulPicker = lazy(() => import("./ColorfulPicker"));

interface CustomColorPanelProps {
  request: PanelRequest;
  onBack(): void;
  onApply(hex: string): void;
  /** dropdown 外面還有一層會在重繪時重新搶焦點的 focus trap（格式工具列）時設為 true，見 `usePinnedFocus`。 */
  pinFocus?: boolean;
  ref?: Ref<HTMLDivElement>;
}

const AUTOFOCUS = "data-autofocus";

/**
 * 讓外層 Mantine `useFocusTrap` 重新聚焦時落在面板裡目前有焦點的元素上。
 *
 * BlockNote 格式工具列的根節點用 `useFocusTrap`，工具列每次重繪都換一個合併 ref，trap 因此先收到 null 再收到節點；
 * 收到 null 只是清掉記住的節點，每次收到節點就排一個 `focusNode`：把焦點移到工具列內第一個 `[data-autofocus]`（沒有就是第一個可 Tab 的元素）。共編者在選取之前打字會讓選取重映射、
 * 工具列跟著重繪，焦點就從色碼框被移走，之後打的字不會進色碼框。`focusNode` 先找 `[data-autofocus]`，
 * 所以把這個屬性放在目前有焦點的元素上，搶焦點就變成對同一個元素 `.focus()`，焦點與游標位置都不動。
 * 選單 dropdown 自己的初始聚焦佔位元素也帶這個屬性，而且排在面板前面，面板有焦點時要先拿掉它，離開面板或卸載時放回。
 * 拖曳把手與表格把手的選單不在這種 trap 裡，不需要這段。
 */
function usePinnedFocus(enabled: boolean, rootRef: { current: HTMLDivElement | null }) {
  const state = useRef<{ marked: HTMLElement | null; stripped: HTMLElement[] }>({ marked: null, stripped: [] });

  const release = useCallback(() => {
    const { marked, stripped } = state.current;
    marked?.removeAttribute(AUTOFOCUS);
    for (const el of stripped) el.setAttribute(AUTOFOCUS, "true");
    state.current = { marked: null, stripped: [] };
  }, []);

  useEffect(() => release, [release]);

  if (!enabled) return {};
  return {
    onFocus: (e: FocusEvent<HTMLDivElement>) => {
      const root = rootRef.current;
      const target = e.target;
      if (!root) return;
      const s = state.current;
      if (s.marked && s.marked !== target) s.marked.removeAttribute(AUTOFOCUS);
      root
        .closest("[data-menu-dropdown]")
        ?.querySelectorAll<HTMLElement>(`[${AUTOFOCUS}]`)
        .forEach((el) => {
          if (root.contains(el)) return;
          el.removeAttribute(AUTOFOCUS);
          s.stripped.push(el);
        });
      target.setAttribute(AUTOFOCUS, "");
      s.marked = target;
    },
    onBlur: (e: FocusEvent<HTMLDivElement>) => {
      if (!rootRef.current?.contains(e.relatedTarget as Node | null)) release();
    },
  };
}

/** 面板裡依 Tab 順序可取得焦點的元素（停用的鈕不算；面板根節點的 tabIndex 是 -1，也不算）。 */
function panelTabbables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")).filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled,
  );
}

/** 開面板時色碼框的初始值：目前的自訂色，沒有就用上次套用的，再沒有就只放 `#`。 */
function initialHex(current: string): string {
  if (isCustomColor(current)) return current;
  return readRecentColors()[0] ?? "#";
}

/**
 * 根選單 dropdown 裡的自訂色面板：飽和度方塊與色相（lazy 載入）、預覽、色碼框、「套用」、最近用過。
 * 拖曳或輸入只改面板裡的預覽；按「套用」、在色碼框按 Enter、點最近用過的色塊才呼叫 `onApply`。
 * 按鈕都是一般 `<button>`，不是 Menu.Item：Menu.Item 的 tabIndex 是 -1，Tab 走不到。
 */
export function CustomColorPanel({ request, onBack, onApply, pinFocus = false, ref }: CustomColorPanelProps) {
  const { t } = useTranslation();
  const errorId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => initialHex(request.current));
  const [shown, setShown] = useState<string | undefined>(() => parseHexInput(text) ?? undefined);
  const [recent] = useState(readRecentColors);
  const parsed = parseHexInput(text);
  // 只有 `#` 或空白時是還沒輸入，不標錯；但仍不能套用。
  const invalid = parsed === null && text.trim() !== "" && text.trim() !== "#";
  const pinned = usePinnedFocus(pinFocus, rootRef);

  // 被點的「自訂…」隨項目列表卸載，焦點會掉到 body；根選單把 dropdown 外的 keydown 當成點外面而關閉，
  // 所以掛上時一定把焦點放進面板。滑鼠、觸控板或鍵盤開啟時放到色碼框；觸控時放在面板根，不叫出螢幕鍵盤。
  useLayoutEffect(() => {
    const fine = window.matchMedia?.("(pointer: fine)").matches ?? false;
    const target = fine || request.byKeyboard ? inputRef.current : rootRef.current;
    target?.focus({ preventScroll: true });
    // 只在掛上時決定一次焦點
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 固定的 callback ref：每次 render 換一個新函式，React 會先以 null 再以節點重呼叫一次
  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const update = (value: string) => {
    setText(value);
    const hex = parseHexInput(value);
    if (hex) setShown(hex);
  };

  // Mantine 的 MenuDropdown 會對 ArrowUp／ArrowDown preventDefault 並把焦點移到選單項，色碼框的游標就動不了，
  // 所以只擋這兩個鍵。其他鍵（Tab、Escape）一定要放行：stopPropagation 會讓事件到不了 document，
  // 而 dropdown 的 Tab 繞回、工具列的 focus trap 與點外面關選單都掛在 document 上。
  //
  // Tab 的繞回由面板自己先做：在最後一個元素按 Tab 移到第一個、在第一個按 Shift+Tab 移到最後一個。只靠 document 上的
  // trap 時，若面板的最後一個元素同時是整條格式工具列的最後一個（例如選取表格儲存格，顏色鈕之後沒有可用的鈕），工具列的
  // trap 會把焦點繞到工具列第一顆鈕，下一鍵就關掉選單。這裡先移好焦點，document 上的 trap 看到焦點已不在端點就不介入。
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.stopPropagation();
      return;
    }
    if (e.key !== "Tab" || e.defaultPrevented) return;
    const items = panelTabbables(rootRef.current);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (!e.shiftKey && e.target === last) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && e.target === first) {
      e.preventDefault();
      last.focus();
    }
  };

  const previewAttr = request.section === "text" ? { "data-text-color": shown } : { "data-background-color": shown };

  return (
    <div
      ref={setRootRef}
      // 寬度＝react-colorful 固定的 200px 加左右 p-1；背景與字色自己吃 BlockNote 選單的變數，不依賴外框
      className="kb-color-panel flex w-[208px] flex-col gap-2 bg-(--bn-colors-menu-background) p-1 text-(--bn-colors-menu-text) outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      {...pinned}
    >
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <span aria-hidden="true">←</span>
        {t("colors.back")}
      </Button>
      <Suspense fallback={<div data-kb-color-picker-fallback="" className="h-[200px] w-[200px]" />}>
        <ColorfulPicker
          color={shown}
          onChange={update}
          saturationLabel={t("colors.saturation_label")}
          hueLabel={t("colors.hue_label")}
        />
      </Suspense>
      <div className="flex items-center gap-2">
        <span
          {...previewAttr}
          aria-hidden="true"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-input text-sm"
        >
          Aa
        </span>
        <Input
          ref={inputRef}
          value={text}
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            // 輸入法選字時的 Enter 是確認選字，不是套用
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (parsed) onApply(parsed);
          }}
          aria-label={t("colors.hex_label")}
          placeholder={t("colors.hex_placeholder")}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? errorId : undefined}
          spellCheck={false}
          autoComplete="off"
          className={invalid ? "min-w-0 flex-1 border-destructive" : "min-w-0 flex-1"}
        />
      </div>
      {invalid && (
        <p id={errorId} className="text-xs text-destructive">
          {t("colors.hex_invalid")}
        </p>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="border border-input"
        disabled={parsed === null}
        onClick={() => {
          if (parsed) onApply(parsed);
        }}
      >
        {t("colors.apply")}
      </Button>
      {recent.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="px-1 text-xs text-muted-foreground">{t("colors.recent")}</div>
          <div className="flex flex-wrap gap-0.5">
            {recent.map((hex) => (
              <Button key={hex} type="button" variant="ghost" size="icon" aria-label={hex} onClick={() => onApply(hex)}>
                <span data-background-color={hex} className="h-5 w-5 rounded-sm border border-input" />
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
