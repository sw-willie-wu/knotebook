import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/` slash 選單裡的 mermaid 項。
 *
 * 這裡 mock 掉 BlockNote 的兩支 API，只驗**我們的組合邏輯**——尤其是
 * 「有沒有把預設項一起帶上」：接管 `/` 選單最典型的失效就是只回自己的項，
 * 靜默把整個內建選單換掉（比照 `collab/schema.ts` 對 `inlineContentSpecs`
 * 整組覆寫的同款雷）。
 *
 * ⚠ **假的預設項一定要帶 `group`**。第一版沒帶，於是 `lastIndexOf(group)` 永遠是 -1，
 * 五條測試全部走 `-1` 的 fallback 分支、生產環境走的卻是另一條——把整條組合邏輯換成
 * `return [item]`（＝上面說的那個最典型失效）測試照樣全綠（第 2 輪審查突變實測）。
 * 群組名與順序照 BlockNote 內建 en 字典的形狀（…Advanced → Media → Others）。
 */

const defaultItemsMock = vi.hoisted(() => vi.fn());
const insertMock = vi.hoisted(() => vi.fn());

vi.mock("@blocknote/react", () => ({ getDefaultReactSlashMenuItems: defaultItemsMock }));
vi.mock("@blocknote/core", () => ({ insertOrUpdateBlockForSlashMenu: insertMock }));

const { buildSlashMenuItems } = await import("./slashMenu");

/** 假 editor：本模組只把它轉交給被 mock 的兩支 API，不讀它的任何欄位。 */
const editor = {} as never;
/** 這個 app 的 `translate` 回的是翻譯後字串；測試用 key 當字串即可，但分組名要對得上假預設項。 */
const translate = (key: string): string => (key === "note.mermaid.slashGroup" ? "Advanced" : key);

/** 內建項的形狀：有 group，且我們的分組（Advanced）**後面還有別的分組**。 */
const DEFAULT_ITEMS = [
  { title: "Paragraph", group: "Basic blocks" },
  { title: "Heading 1", group: "Basic blocks" },
  { title: "Table", group: "Advanced" },
  { title: "Image", group: "Media" },
  { title: "Emoji", group: "Others" },
];

/** 分組標題序列（選單只在 group 換手時畫標題）。重複出現＝畫面上多一個同名標題。 */
function groupRuns(items: { group?: string }[]): string[] {
  return items.map((item) => item.group).filter((group, index, all) => group !== all[index - 1]) as string[];
}

beforeEach(() => {
  defaultItemsMock.mockReset();
  insertMock.mockReset();
  defaultItemsMock.mockReturnValue(DEFAULT_ITEMS.map((item) => ({ ...item })));
});

/** mermaid 那一項（不能用 `.at(-1)`：它插在自己的分組裡，後面還有 Media／Others）。 */
function mermaidItem() {
  return buildSlashMenuItems(editor, translate).find((item) => item.title === "note.mermaid.slashTitle");
}

describe("buildSlashMenuItems", () => {
  it("預設項全數保留、順序不變（接管 / 選單不得把內建選單換掉）", () => {
    const titles = buildSlashMenuItems(editor, translate).map((item) => item.title);
    expect(titles.filter((title) => title !== "note.mermaid.slashTitle")).toEqual(DEFAULT_ITEMS.map((item) => item.title));
  });

  it("mermaid 項插在同分組的最後一項之後（不是塞在整份清單最尾）", () => {
    const titles = buildSlashMenuItems(editor, translate).map((item) => item.title);
    expect(titles).toEqual(["Paragraph", "Heading 1", "Table", "note.mermaid.slashTitle", "Image", "Emoji"]);
  });

  it("不會多出第二個同名分組標題（塞在最尾就會）", () => {
    const runs = groupRuns(buildSlashMenuItems(editor, translate));
    expect(runs).toEqual(["Basic blocks", "Advanced", "Media", "Others"]);
  });

  it("分組名在內建清單裡不存在時，退回接在最後（不會整組不見）", () => {
    const titles = buildSlashMenuItems(editor, (key) => (key === "note.mermaid.slashGroup" ? "不存在的分組" : key)).map((i) => i.title);
    expect(titles).toEqual([...DEFAULT_ITEMS.map((item) => item.title), "note.mermaid.slashTitle"]);
  });

  it("mermaid 項有中英文別名（打 diagram 或 圖表 都找得到）", () => {
    expect(mermaidItem()?.aliases).toEqual(expect.arrayContaining(["mermaid", "diagram", "flowchart", "圖表"]));
  });

  it("點下去插入的是 type:\"mermaid\" 的 block", () => {
    mermaidItem()?.onItemClick();
    expect(insertMock).toHaveBeenCalledWith(editor, { type: "mermaid" });
  });

  it("插入的 block 不帶 code prop（讓 propSchema 的 default 生效，只有一處真相）", () => {
    mermaidItem()?.onItemClick();
    const [, block] = insertMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(block).not.toHaveProperty("props");
  });
});
