import { afterEach, describe, expect, it } from "vitest";
import { COLUMN_TYPE } from "@knotebook/shared";
import { IMG, P, mountEditor, row, withChildren, type PartialBlockLike } from "@/test/columns-fixtures";
import { columnKindOf, shouldStack, type PMNodeLike } from "./layout";

// 並排的欄寬與版面。

describe("L1 shouldStack：各欄最小寬度總和＋溝寬總和 > 可用寬度 → 堆疊", () => {
  it("兩欄文字：200+24+200＝424", () => {
    expect(shouldStack(["text", "text"], 423)).toBe(true);
    expect(shouldStack(["text", "text"], 424)).toBe(false);
  });
  it("兩欄圖片：96+24+96＝216", () => {
    expect(shouldStack(["image", "image"], 216)).toBe(false);
    expect(shouldStack(["image", "image"], 215)).toBe(true);
  });
  it("四欄文字：4×200+3×24＝872", () => {
    expect(shouldStack(["text", "text", "text", "text"], 872)).toBe(false);
    expect(shouldStack(["text", "text", "text", "text"], 871)).toBe(true);
  });
  it("可用寬度 0 或負數（未排版、隱藏）→ 不堆疊", () => {
    expect(shouldStack(["text", "text"], 0)).toBe(false);
    expect(shouldStack(["text", "text"], -5)).toBe(false);
  });
});

describe("L2 columnKindOf", () => {
  let destroy: (() => void) | undefined;
  afterEach(() => destroy?.());

  function columnsOf(cols: PartialBlockLike[][]): PMNodeLike[] {
    const mounted = mountEditor([P("x", "x0"), row(cols, "r"), P("z", "z9")]);
    destroy = mounted.destroy;
    const out: PMNodeLike[] = [];
    mounted.editor.prosemirrorView!.state.doc.descendants((node) => {
      if (node.type.name === COLUMN_TYPE) out.push(node as unknown as PMNodeLike);
    });
    return out;
  }

  it("全是圖片 → image；圖片＋段落 → text；單一空段落 → text", () => {
    const [allImages, mixed, empty] = columnsOf([[IMG("i1"), IMG("i2")], [IMG("i3"), P("t", "t1")], [P("", "e1")]]);
    expect(columnKindOf(allImages)).toBe("image");
    expect(columnKindOf(mixed)).toBe("text");
    expect(columnKindOf(empty)).toBe("text");
  });

  it("段落在前、圖片在後 → text（不只看第一顆）", () => {
    const [col] = columnsOf([[P("t", "t1"), IMG("i1")], [P("b", "b1")]]);
    expect(columnKindOf(col)).toBe("text");
  });

  it("圖片底下縮排了文字 → text（欄不是只含圖片）", () => {
    const [col] = columnsOf([[withChildren(IMG("i1"), [P("k", "k1")])], [P("b", "b1")]]);
    expect(columnKindOf(col)).toBe("text");
  });

  it("showPreview:false 的圖片（畫成檔案列，簡報匯出成 <a>）→ text", () => {
    const noPreview = { ...IMG("i1"), props: { ...IMG("i1").props, showPreview: false } } as PartialBlockLike;
    const [col, preview] = columnsOf([[noPreview], [IMG("i2")]]);
    expect(columnKindOf(col)).toBe("text");
    expect(columnKindOf(preview)).toBe("image");
  });
});
