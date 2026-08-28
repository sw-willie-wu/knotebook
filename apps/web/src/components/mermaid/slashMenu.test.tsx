import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/` slash 選單裡的 mermaid 項。
 *
 * 這裡 mock 掉 BlockNote 的兩支 API，只驗**我們的組合邏輯**——尤其是
 * 「有沒有把預設項一起帶上」：接管 `/` 選單最典型的失效就是只回自己的項，
 * 靜默把整個內建選單換掉（比照 `collab/schema.ts` 對 `inlineContentSpecs`
 * 整組覆寫的同款雷）。
 */

const defaultItemsMock = vi.hoisted(() => vi.fn());
const insertMock = vi.hoisted(() => vi.fn());

vi.mock("@blocknote/react", () => ({ getDefaultReactSlashMenuItems: defaultItemsMock }));
vi.mock("@blocknote/core", () => ({ insertOrUpdateBlockForSlashMenu: insertMock }));

const { buildSlashMenuItems } = await import("./slashMenu");

/** 假 editor：本模組只把它轉交給被 mock 的兩支 API，不讀它的任何欄位。 */
const editor = {} as never;
const translate = (key: string): string => key;

beforeEach(() => {
  defaultItemsMock.mockReset();
  insertMock.mockReset();
  defaultItemsMock.mockReturnValue([{ title: "Paragraph" }, { title: "Heading 1" }, { title: "Table" }]);
});

describe("buildSlashMenuItems", () => {
  it("預設項全數保留（接管 / 選單不得把內建選單換掉）", () => {
    const titles = buildSlashMenuItems(editor, translate).map((item) => item.title);
    expect(titles).toEqual(expect.arrayContaining(["Paragraph", "Heading 1", "Table"]));
  });

  it("預設項在前、自訂項在後（使用者按 / 最先看到的仍是常用 block）", () => {
    const items = buildSlashMenuItems(editor, translate);
    expect(items.slice(0, 3).map((i) => i.title)).toEqual(["Paragraph", "Heading 1", "Table"]);
    expect(items.at(-1)?.title).toBe("note.mermaid.slashTitle");
  });

  it("mermaid 項有中英文別名（打 diagram 或 圖表 都找得到）", () => {
    const mermaid = buildSlashMenuItems(editor, translate).at(-1);
    expect(mermaid?.aliases).toEqual(expect.arrayContaining(["mermaid", "diagram", "flowchart", "圖表"]));
  });

  it("點下去插入的是 type:\"mermaid\" 的 block", () => {
    buildSlashMenuItems(editor, translate).at(-1)?.onItemClick();
    expect(insertMock).toHaveBeenCalledWith(editor, { type: "mermaid" });
  });

  it("插入的 block 不帶 code prop（讓 propSchema 的 default 生效，只有一處真相）", () => {
    buildSlashMenuItems(editor, translate).at(-1)?.onItemClick();
    const [, block] = insertMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(block).not.toHaveProperty("props");
  });
});
