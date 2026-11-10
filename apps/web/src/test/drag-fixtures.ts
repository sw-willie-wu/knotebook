import { vi, type Mock } from "vitest";
import { DRAG_POINTER_QUERY } from "@/components/sidebar/drag-zone";

/**
 * 側欄拖曳的測試工具（資料夾 PR-3c T4 起）。jsdom 沒有 DataTransfer：以 `fireEvent.dragStart／dragOver／drop／dragEnd(el, { dataTransfer })`
 * 帶這個假物件。`setData` 會把型別推進 `types`（型別已在就不重複），所以接手後同一個物件的後續 `dragOver` 看得到自訂型別。
 */
export interface FakeDataTransfer {
  types: string[];
  setData: Mock<(type: string, value: string) => void>;
  getData: Mock<(type: string) => string>;
  clearData: Mock<(type?: string) => void>;
  effectAllowed: DataTransfer["effectAllowed"];
  dropEffect: DataTransfer["dropEffect"];
  /** 只有 `{ store: true }` 時才有：編輯器內拖曳（core 的 ⋮⋮、copyExtension）會呼叫。 */
  setDragImage?: Mock<(image: Element, x: number, y: number) => void>;
  items?: unknown[];
  files?: File[];
}

/**
 * `store: true`：`setData`／`getData` 以 Map 存取、`clearData` 清掉資料與型別，另帶 `setDragImage`、空的 `items`／`files`。
 * core SideMenu 的根層 dragstart 要讀得回 ⋮⋮ 自己 `setData` 的 `blocknote/html` 才會設 `view.dragging`。預設行為不變。
 */
export function createFakeDataTransfer(initialTypes: readonly string[] = [], opts: { store?: boolean } = {}): FakeDataTransfer {
  const types = [...initialTypes];
  if (!opts.store) {
    return {
      types,
      setData: vi.fn((type: string) => {
        if (!types.includes(type)) types.push(type);
      }),
      getData: vi.fn(() => ""),
      clearData: vi.fn(),
      effectAllowed: "uninitialized",
      dropEffect: "none",
    };
  }
  const data = new Map<string, string>();
  return {
    types,
    setData: vi.fn((type: string, value: string) => {
      data.set(type, value);
      if (!types.includes(type)) types.push(type);
    }),
    getData: vi.fn((type: string) => data.get(type) ?? ""),
    clearData: vi.fn((type?: string) => {
      for (const t of type === undefined ? [...data.keys()] : [type]) {
        data.delete(t);
        const i = types.indexOf(t);
        if (i >= 0) types.splice(i, 1);
      }
    }),
    effectAllowed: "uninitialized",
    dropEffect: "none",
    setDragImage: vi.fn(),
    items: [],
    files: [],
  };
}

/** 覆寫 `matchMedia`：只有 `DRAG_POINTER_QUERY` 依 `fine` 回報，其餘查詢恆不符合（同 `test/setup.ts`）。呼叫端 `vi.unstubAllGlobals()` 還原。 */
export function mockFinePointer(fine: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: fine && query === DRAG_POINTER_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}
