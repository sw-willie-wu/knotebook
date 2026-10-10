import { describe, expect, it } from "vitest";
import { bigramDice, diffBlocks, markOf, renderDiff, sideBySideMarks, splitRows, type DiffBlock, type SplitRow } from "./version-diff";

const p = (id: string, text: string, children: DiffBlock[] = []): DiffBlock => ({
  id,
  type: "paragraph",
  props: { textAlignment: "left" },
  content: [{ type: "text", text, styles: {} }],
  children,
});
const img = (id: string, url: string): DiffBlock => ({ id, type: "image", props: { url }, content: undefined, children: [] });

/** 只取一層的 (key, mark) 對，方便讀。 */
const marksOf = (a: DiffBlock[], b: DiffBlock[]) => diffBlocks(a, b).map((e) => [e.key, markOf(e)]);

describe("diffBlocks（spec §8.4）", () => {
  it("新增：只在 b 的區塊 → added，順序依 b", () => {
    expect(marksOf([p("A", "a")], [p("A", "a"), p("B", "b")])).toEqual([
      ["A", "context"],
      ["B", "added"],
    ]);
  });

  it("刪除：插在 a 裡它前一顆存活區塊之後；前面沒有存活的就放開頭；合成 id", () => {
    const out = marksOf([p("X", "x"), p("A", "a"), p("D", "d"), p("B", "b")], [p("A", "a"), p("B", "b")]);
    expect(out).toEqual([
      ["diff-del-1", "deleted"],
      ["A", "context"],
      ["diff-del-2", "deleted"],
      ["B", "context"],
    ]);
  });

  it("修改：同 id、去掉 children 後 JSON 不等 → changed；只改 children 的父不算 changed", () => {
    const a = [p("A", "舊字"), p("P", "同", [p("C", "子一")])];
    const b = [p("A", "新字"), p("P", "同", [p("C", "子二")])];
    const out = diffBlocks(a, b);
    expect(out.map(markOf)).toEqual(["changed", "context"]);
    expect(out[1].children.map(markOf)).toEqual(["changed"]);
  });

  it("搬動：LIS 外的才標 moved（[A,B,C] → [C,A,B] 只有 C）", () => {
    expect(marksOf([p("A", "a"), p("B", "b"), p("C", "c")], [p("C", "c"), p("A", "a"), p("B", "b")])).toEqual([
      ["C", "moved"],
      ["A", "context"],
      ["B", "context"],
    ]);
  });

  it("搬動＋修改並存：mark 是 changed、moved 旗標仍為 true", () => {
    const [first] = diffBlocks([p("A", "a"), p("B", "b")], [p("B", "b2"), p("A", "a")]);
    expect(first.key).toBe("B");
    expect(markOf(first)).toBe("changed");
    expect(first.moved).toBe(true);
  });

  it("父刪子升：跨層搬移顯示為刪除＋新增（§13-7）；P 前面沒有存活區塊 → 刪除放開頭（§8.4-2）；渲染 id 全部唯一", () => {
    const a = [p("P", "父", [p("C", "子")])];
    const b = [p("C", "子")];
    const entries = diffBlocks(a, b);
    expect(entries.map((e) => [e.key, markOf(e)])).toEqual([
      ["diff-del-1", "deleted"],
      ["C", "added"],
    ]);
    expect(entries[0].children.map((e) => [e.key, markOf(e)])).toEqual([["diff-del-2", "deleted"]]);
    const { blocks } = renderDiff(entries);
    const ids: string[] = [];
    const walk = (bs: DiffBlock[]) => bs.forEach((x) => (ids.push(x.id!), walk(x.children ?? [])));
    walk(blocks);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("非文字區塊（image）只標 changed、內容取 b、nonText 旗標", () => {
    const entries = diffBlocks([img("I", "/api/uploads/1")], [img("I", "/api/uploads/2")]);
    const { blocks, marks } = renderDiff(entries);
    expect(marks.get("I")).toEqual({ mark: "changed", moved: false, nonText: true });
    expect(blocks[0].props).toEqual({ url: "/api/uploads/2" });
  });

  it("inline 重組：equal／added 沿用 b 的樣式、removed 沿用 a 的樣式並加 strike＋紅底、added 加綠底", () => {
    const a: DiffBlock[] = [{ id: "A", type: "paragraph", props: {}, content: [{ type: "text", text: "舊 字", styles: { bold: true } }], children: [] }];
    const b: DiffBlock[] = [{ id: "A", type: "paragraph", props: {}, content: [{ type: "text", text: "新 字", styles: { italic: true } }], children: [] }];
    const { blocks } = renderDiff(diffBlocks(a, b));
    expect(blocks[0].content).toEqual([
      { type: "text", text: "舊", styles: { bold: true, strike: true, backgroundColor: "red" } },
      { type: "text", text: "新", styles: { italic: true, backgroundColor: "green" } },
      { type: "text", text: " 字", styles: { italic: true } },
    ]);
  });

  it("inline 重組：連結與非文字 inline（wikilink）保留原形", () => {
    const wl = { type: "wikilink", props: { targetNoteId: "n2", snapshotTitle: "T" } };
    const a: DiffBlock[] = [{ id: "A", type: "paragraph", props: {}, content: [wl, { type: "text", text: " 看", styles: {} }], children: [] }];
    const b: DiffBlock[] = [
      { id: "A", type: "paragraph", props: {}, content: [wl, { type: "text", text: " 看 ", styles: {} }, { type: "link", href: "https://x.test", content: [{ type: "text", text: "這", styles: {} }] }], children: [] },
    ];
    const { blocks } = renderDiff(diffBlocks(a, b));
    const content = blocks[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual(wl);
    expect(content).toContainEqual({ type: "link", href: "https://x.test", content: [{ type: "text", text: "這", styles: { backgroundColor: "green" } }] });
  });

  it("兩邊都空 → 一顆空 paragraph（initialContent 不可為空陣列）", () => {
    const { blocks, marks } = renderDiff(diffBlocks([], []));
    expect(blocks).toEqual([{ id: "diff-empty", type: "paragraph" }]);
    expect(marks.size).toBe(0);
  });

  it("v1 vs 空文件：全部 added（子孫也是）", () => {
    const entries = diffBlocks([], [p("A", "a", [p("C", "c")])]);
    expect(entries.map(markOf)).toEqual(["added"]);
    expect(entries[0].children.map(markOf)).toEqual(["added"]);
  });

  it("只看差異：連續 context 折成一顆合成段落，子樹有變更的 context 不折", () => {
    const a = [p("A", "a"), p("B", "b"), p("C", "c"), p("D", "d", [p("E", "e")])];
    const b = [p("A", "a"), p("B", "b"), p("C", "c2"), p("D", "d", [p("E", "e2")])];
    const { blocks, marks } = renderDiff(diffBlocks(a, b), { onlyChanges: true, collapsedText: (n) => `… ${n} …` });
    expect(blocks.map((x) => x.id)).toEqual(["diff-ctx-1", "C", "D"]);
    expect(blocks[0].content).toEqual([{ type: "text", text: "… 2 …", styles: {} }]);
    expect(marks.get("diff-ctx-1")?.mark).toBe("collapsed");
  });

  it("並排標記：左邊標 deleted／changed、右邊標 added／changed／moved", () => {
    const { left, right } = sideBySideMarks(diffBlocks([p("A", "a"), p("D", "d"), p("M", "m")], [p("M", "m"), p("A", "a2"), p("N", "n")]));
    expect(Object.fromEntries(left)).toEqual({ A: "changed", D: "deleted" });
    expect(Object.fromEntries(right)).toEqual({ M: "moved", A: "changed", N: "added" });
  });

  it("RF1：缺 id 與同一層重複的 id 不 throw；同一層重複出現的 id **全部**不配對（含第一次出現的那顆），渲染 id 全唯一", () => {
    const noId: DiffBlock = { type: "paragraph", props: {}, content: [], children: [] };
    const a = [p("A", "a"), p("A", "a 重複"), noId];
    const b = [p("A", "a"), p("A", "又重複"), { ...noId }];
    const entries = diffBlocks(a, b);
    const { blocks } = renderDiff(entries);
    const ids = blocks.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(entries.filter((e) => markOf(e) === "context")).toHaveLength(0);
    expect(entries.filter((e) => markOf(e) === "added")).toHaveLength(3);
    expect(entries.filter((e) => markOf(e) === "deleted")).toHaveLength(3);
  });

  it("RF1 對照：同一個 id 只在一側重複時，另一側那顆也不配對（重複判定是逐側、逐層）", () => {
    const entries = diffBlocks([p("A", "a")], [p("A", "a"), p("A", "a2")]);
    expect(entries.map(markOf).sort()).toEqual(["added", "added", "deleted"]);
  });
});

/** 決定性的亂字（小寫字母）：同一個 seed 永遠同一串；不同 seed 的 bigram 幾乎不重疊（Dice 遠低於 0.5）。 */
const gibberish = (seed: number, len = 40): string => {
  // mulberry32：各 seed 的序列彼此獨立（線性同餘的不同 seed 只是同一條序列錯位，會偶發撞出相似字串）。
  let x = seed >>> 0;
  let s = "";
  for (let i = 0; i < len; i += 1) {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), x | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    s += "abcdefghijklmnopqrstuvwxyz"[((t ^ (t >>> 14)) >>> 0) % 26];
  }
  return s;
};
/** 決定性的亂句：n 個 5 字母的亂字、空白分隔（token bigram 才有 n−1 個；單一長串只算一個 token）。 */
const words = (seed: number, n = 8): string => (gibberish(seed, 5 * n).match(/.{5}/g) ?? []).join(" ");
const h =(id: string, text: string): DiffBlock => ({ id, type: "heading", props: { level: 1 }, content: [{ type: "text", text, styles: {} }], children: [] });

describe("diffBlocks 配對的內容後備（spec rev 11 §8.4 規則 1a／1b／1c）", () => {
  it("1a 讓位＋1b：在區塊開頭按 Enter（舊 id 留在新的空白區塊、原文字換新 id）→ 只有新區塊是 added，原文字 context、沒有 deleted", () => {
    const entries = diffBlocks([p("id1", "first"), p("id2", "hello")], [p("id1", "first"), p("id2", "new"), p("id3", "hello")]);
    expect(entries.map((e) => [e.key, markOf(e)])).toEqual([
      ["id1", "context"],
      ["id2", "added"],
      ["id3", "context"],
    ]);
    expect(entries[2].before?.id).toBe("id2");
  });

  it("1b：整篇貼上（所有 id 都換新、文字不變）→ 全部 unchanged、沒有 moved", () => {
    const texts = ["one", "two", "three", "four", "five"];
    const entries = diffBlocks(
      texts.map((t, i) => p(`id${i + 1}`, t)),
      texts.map((t, i) => p(`id${i + 6}`, t)),
    );
    expect(entries.map((e) => [e.key, e.status, e.moved])).toEqual(texts.map((_, i) => [`id${i + 6}`, "unchanged", false]));
  });

  it("1b＋LIS：整篇貼上且第 2、3 顆對調 → 恰一顆 moved，其餘 context", () => {
    const texts = ["one", "two", "three", "four", "five"];
    const swapped = [texts[0], texts[2], texts[1], texts[3], texts[4]];
    const entries = diffBlocks(
      texts.map((t, i) => p(`id${i + 1}`, t)),
      swapped.map((t, i) => p(`id${i + 6}`, t)),
    );
    expect(entries.every((e) => e.status === "unchanged")).toBe(true);
    expect(entries.map(markOf).filter((m) => m === "moved")).toHaveLength(1);
    expect(entries.map(markOf).filter((m) => m === "context")).toHaveLength(4);
  });

  it("1c：整篇貼上且第 3 顆改了一個詞（相似度 > 0.5）→ 該顆 changed 且 inline 有刪／增片段，其餘 context", () => {
    const texts = ["Alpha beta gamma delta", "Lorem ipsum dolor sit amet", "The quick brown fox jumps over the lazy dog", "Pack my box with five dozen", "Sphinx of black quartz judge"];
    const after = [...texts];
    after[2] = "The quick brown cat jumps over the lazy dog";
    const entries = diffBlocks(
      texts.map((t, i) => p(`id${i + 1}`, t)),
      after.map((t, i) => p(`id${i + 6}`, t)),
    );
    expect(entries.map(markOf)).toEqual(["context", "context", "changed", "context", "context"]);
    expect(entries[2].before?.id).toBe("id3");
    const { blocks } = renderDiff(entries);
    const inline = blocks[2].content as Array<{ text: string; styles: Record<string, unknown> }>;
    expect(inline).toContainEqual({ type: "text", text: "fox", styles: { strike: true, backgroundColor: "red" } });
    expect(inline).toContainEqual({ type: "text", text: "cat", styles: { backgroundColor: "green" } });
  });

  it("1c 門檻：同 type 但相似度不足 0.5 → 不配對（刪除＋新增）", () => {
    expect(marksOf([p("id1", "完全不同的內容")], [p("id2", "another thing entirely different here")])).toEqual([
      ["diff-del-1", "deleted"],
      ["id2", "added"],
    ]);
  });

  // 以下兩段取自 docs/known-limitations.md：同主題、措辭相近但講的是兩件事。字元 bigram Dice 0.603（舊定義會誤配），
  // token bigram Dice 0.415——是該檔 229 段兩兩配對中最高的一對（review I-1／M-3：守門檻與 token 化）。
  const SIGNIN_SERVICE =
    "Turning a sign-in service off doesn't sign anyone out. People who signed in through it keep their session until it expires, and their API tokens and connected apps keep working (a token created without an expiry keeps working until it's revoked). Deleting the service doesn't change that either. To cut someone off right away, disable their account in Site admin → Users — that stops their sessions and tokens too.";
  const SIGNIN_PASSWORD =
    "Turning password sign-in off doesn't sign anyone out. Existing sessions, API tokens, connected apps and MCP clients keep working. To cut someone off right away, disable their account in Site admin → Users.";

  it("1c 門檻（token bigram）：刪掉一段、原處寫一段同主題但不相關的英文 → 不配對（刪除＋新增）", () => {
    expect(bigramDice(SIGNIN_SERVICE, SIGNIN_PASSWORD)).toBeGreaterThan(0.4);
    expect(bigramDice(SIGNIN_SERVICE, SIGNIN_PASSWORD)).toBeLessThan(0.5);
    expect(marksOf([p("k0", "Kept first paragraph stays here"), p("k1", SIGNIN_SERVICE), p("k2", "Kept last paragraph stays here")], [p("k0", "Kept first paragraph stays here"), p("n1", SIGNIN_PASSWORD), p("k2", "Kept last paragraph stays here")])).toEqual([
      ["k0", "context"],
      ["diff-del-1", "deleted"],
      ["n1", "added"],
      ["k2", "context"],
    ]);
  });

  it("1c 門檻（token bigram）：整篇貼上後同一段只改一個詞 → 仍配對（changed）", () => {
    const edited = SIGNIN_SERVICE.replace("connected apps", "connected tools");
    expect(bigramDice(SIGNIN_SERVICE, edited)).toBeGreaterThanOrEqual(0.5);
    const entries = diffBlocks([p("id1", SIGNIN_SERVICE)], [p("id2", edited)]);
    expect(entries.map((e) => [e.key, markOf(e), e.before?.id])).toEqual([["id2", "changed", "id1"]]);
  });

  it("1c 只比 token ≥ 4 的區塊：3 個詞的短段改一個詞 → 不配對（只靠 1b 的完全相等）", () => {
    expect(marksOf([p("id1", "alpha beta gamma")], [p("id2", "alpha beta delta")])).toEqual([
      ["diff-del-1", "deleted"],
      ["id2", "added"],
    ]);
  });

  it("非文字型只做精確配對：image props 相同 → unchanged；url 不同 → 刪除＋新增（不走 1c）", () => {
    expect(marksOf([img("id1", "/api/uploads/1")], [img("id2", "/api/uploads/1")])).toEqual([["id2", "context"]]);
    expect(marksOf([img("id1", "/api/uploads/1")], [img("id2", "/api/uploads/2")])).toEqual([
      ["diff-del-1", "deleted"],
      ["id2", "added"],
    ]);
  });

  it("1b：同一層重複的相同內容依出現順序一一配（id3↔id1、id4↔id2）", () => {
    const entries = diffBlocks([p("id1", "x"), p("id2", "x")], [p("id3", "x"), p("id4", "x")]);
    expect(entries.map((e) => [e.key, e.status, e.before?.id])).toEqual([
      ["id3", "unchanged", "id1"],
      ["id4", "unchanged", "id2"],
    ]);
  });

  it("1c 候選帶：a 前面 5 顆被刪、b 前面插 40 顆新區塊、其後 100 顆換 id 且各改了尾巴 → 100 顆仍全部配到（changed）", () => {
    const a = [...Array.from({ length: 5 }, (_, i) => p(`gone${i}`, words(1000 + i))), ...Array.from({ length: 100 }, (_, i) => p(`a${i}`, words(i)))];
    const b = [
      ...Array.from({ length: 40 }, (_, i) => p(`new${i}`, words(2000 + i))),
      ...Array.from({ length: 100 }, (_, i) => p(`b${i}`, `${words(i).slice(0, -5)}xyzzy`)), // 換掉最後一個字：Dice 6/7
    ];
    const entries = diffBlocks(a, b);
    const paired = entries.filter((e) => e.status === "changed");
    expect(paired.map((e) => [e.key, e.before?.id, e.moved])).toEqual(Array.from({ length: 100 }, (_, i) => [`b${i}`, `a${i}`, false]));
    expect(entries.filter((e) => e.status === "added")).toHaveLength(40);
    expect(entries.filter((e) => e.status === "deleted")).toHaveLength(5);
  });

  it("1a 不讓位：同 id 的一對內容不同、但對側沒有內容相等的未配對區塊 → 仍是這一對 changed", () => {
    const entries = diffBlocks([p("id1", "abc")], [p("id1", "abd")]);
    expect(entries.map((e) => [e.key, markOf(e), e.before?.id])).toEqual([["id1", "changed", "id1"]]);
  });

  it("RF1 不變：b 側兩顆同 id 同文字、缺 id 的同文字區塊 → 文字相同也不配對", () => {
    const dup = diffBlocks([p("id1", "same text")], [p("id9", "same text"), p("id9", "same text")]);
    expect(dup.map(markOf).sort()).toEqual(["added", "added", "deleted"]);
    const noId: DiffBlock = { type: "paragraph", props: { textAlignment: "left" }, content: [{ type: "text", text: "same text", styles: {} }], children: [] };
    const missing = diffBlocks([p("id1", "same text")], [noId]);
    expect(missing.map(markOf).sort()).toEqual(["added", "deleted"]);
    const missingA = diffBlocks([{ ...noId }], [p("id1", "same text")]);
    expect(missingA.map(markOf).sort()).toEqual(["added", "deleted"]);
  });

  it("型別守衛：paragraph 與 heading 文字相同 → 1b（shallow 含 type）與 1c（type 須相同）都不配 → 刪除＋新增", () => {
    // 文字 ≥ 4 個 token，1c 真的會比到（不看 type 的話 Dice＝1 就配了；fix2 review M-B2）。
    const text = "The quick brown fox jumps over the lazy dog";
    expect(marksOf([p("id1", text)], [h("id2", text)])).toEqual([
      ["diff-del-1", "deleted"],
      ["id2", "added"],
    ]);
  });

  it("1a 讓位（b 側方向）：id 對子的新內容在 a 的未配對區塊裡有完全相同者 → 讓位，b 配給那顆、a 的舊那顆刪除", () => {
    const entries = diffBlocks([p("id1", "t"), p("id5", "t2")], [p("id1", "t2")]);
    expect(entries.map((e) => [e.key, markOf(e), e.before?.id])).toEqual([
      ["diff-del-1", "deleted", "id1"],
      ["id1", "context", "id5"],
    ]);
  });

  it("1a 讓位連鎖：後面那對讓位後釋出的內容才讓前面那對讓位（要重跑到不再有新的讓位）", () => {
    // 第一輪：id2（w→x）的舊內容 w 在 b 池（id3）→ 讓位，b 池多了 x；第二輪：id1（x→y）的舊內容 x 這時才在 b 池 → 讓位。
    const entries = diffBlocks([p("id1", "x"), p("id2", "w")], [p("id1", "y"), p("id2", "x"), p("id3", "w")]);
    expect(entries.map((e) => [e.key, markOf(e), e.before?.id])).toEqual([
      ["id1", "added", undefined],
      ["id2", "context", "id1"],
      ["id3", "context", "id2"],
    ]);
  });

  it("1a 讓位比個數：同層有重複內容、己側還有別顆能接走時不讓位 → 不交叉配對、沒有假 moved（review M-1）", () => {
    const entries = diffBlocks([p("id1", "hello world"), p("id5", "hello world")], [p("id1", "hello world!"), p("id6", "hello world")]);
    expect(entries.map((e) => [e.key, e.status, e.moved, e.before?.id])).toEqual([
      ["id1", "changed", false, "id1"],
      ["id6", "unchanged", false, "id5"],
    ]);
  });

  it("空的文字型區塊照常配對但不標 moved：刪一顆空行＋別處新增空行 → 兩顆空行配成 unchanged、moved=false（review M-2／修正輪 2）", () => {
    const entries = diffBlocks([p("id1", ""), p("id2", "alpha"), p("id3", "beta")], [p("id2", "alpha"), p("id3", "beta"), p("id9", "")]);
    expect(entries.map((e) => [e.key, e.status, e.moved, e.before?.id])).toEqual([
      ["id2", "unchanged", false, "id2"],
      ["id3", "unchanged", false, "id3"],
      ["id9", "unchanged", false, "id1"],
    ]);
  });

  it("在文末空段落打字（BlockNote 補一顆新的空段落）→ 新字 added、空段落 unchanged 且不 moved、沒有 deleted（修正輪 2）", () => {
    const entries = diffBlocks([p("id1", "hello"), p("id2", "")], [p("id1", "hello"), p("id2", "new text"), p("id3", "")]);
    expect(entries.map((e) => [e.key, e.status, e.moved, e.before?.id])).toEqual([
      ["id1", "unchanged", false, "id1"],
      ["id2", "added", false, undefined],
      ["id3", "unchanged", false, "id2"],
    ]);
  });

  it("空行對子先排除再算 LIS：空行移到前面不會把唯一的非空對子擠出 LIS 標成 moved（fix2 review M-B1）", () => {
    // 若空行也進 LIS（a 索引序列 [1, 2, 0]），LIS 是兩顆空行、x 會被標 moved；先排除則 x 單獨成 LIS。
    const entries = diffBlocks([p("x", "keep me"), p("e", ""), p("f", "")], [p("e2", ""), p("f2", ""), p("x", "keep me")]);
    expect(entries.map((e) => [e.key, e.status, e.moved, e.before?.id])).toEqual([
      ["e2", "unchanged", false, "e"],
      ["f2", "unchanged", false, "f"],
      ["x", "unchanged", false, "x"],
    ]);
  });

  it("刪除錨點跳過靠內容配起來的空行：刪掉「空行＋下一段」、別處新增空行 → 被刪段落仍在原處（Title 之後），不跑到文末（fix2 review I-A）", () => {
    const a = [p("h", "Title"), p("e1", ""), p("d", "This paragraph gets deleted"), p("k1", "keep one"), p("k2", "keep two"), p("t", "")];
    const b = [p("h", "Title"), p("k1", "keep one"), p("k2", "keep two"), p("n", ""), p("t", "")];
    expect(diffBlocks(a, b).map((e) => [e.key, e.status, e.before?.id])).toEqual([
      ["h", "unchanged", "h"],
      ["diff-del-1", "deleted", "d"],
      ["k1", "unchanged", "k1"],
      ["k2", "unchanged", "k2"],
      ["n", "unchanged", "e1"],
      ["t", "unchanged", "t"],
    ]);
  });

  it("真實的區塊開頭按 Enter（舊 id 那顆變成空行）→ 空行 added、原文字 context", () => {
    const entries = diffBlocks([p("id1", "first"), p("id2", "hello")], [p("id1", "first"), p("id2", ""), p("id3", "hello")]);
    expect(entries.map((e) => [e.key, markOf(e), e.before?.id])).toEqual([
      ["id1", "context", "id1"],
      ["id2", "added", undefined],
      ["id3", "context", "id2"],
    ]);
  });

  it("bigramDice：token bigram（拉丁字母／數字連成一個 token、其他字元各一個、空白標點是分隔）、多重集合交集", () => {
    expect(bigramDice("a b c d", "a b c e")).toBeCloseTo(4 / 6);
    expect(bigramDice("x x x", "x x")).toBeCloseTo(2 / 3);
    expect(bigramDice("hello, world!", "hello world")).toBe(1);
    expect(bigramDice("abc def", "abc deg")).toBe(0); // 拉丁字母連成一個 token：def ≠ deg
    expect(bigramDice("中文字", "中文字")).toBe(1);
    expect(bigramDice("v2 release", "v3 release")).toBe(0);
    expect(bigramDice("abcd", "abcd")).toBe(0); // 只有一個 token → 沒有 bigram
  });

  it("bigramDice 以 code point 切：代理對 emoji 是一個 token（以 UTF-16 code unit 切會得 0.5）", () => {
    expect(bigramDice("a😀", "a😁")).toBe(0);
    expect(bigramDice("a😀", "a😀")).toBe(1);
  });

  it("效能（只印不斷言時間）：2000 顆對 2000 顆、全新 id、文字各異且互不相似 → 全部刪＋增", () => {
    const a = Array.from({ length: 2000 }, (_, i) => p(`a${i}`, words(i)));
    const b = Array.from({ length: 2000 }, (_, i) => p(`b${i}`, words(10000 + i)));
    const t0 = performance.now();
    const entries = diffBlocks(a, b);
    const ms = performance.now() - t0;
    console.log(`[version-diff 案 12] diffBlocks 2000×2000 全不相似：${ms.toFixed(1)} ms`);
    expect(entries.filter((e) => e.status === "added")).toHaveLength(2000);
    expect(entries.filter((e) => e.status === "deleted")).toHaveLength(2000);
  });
});

describe("splitRows（spec rev 12 §8.4 並排逐區塊對齊）", () => {
  const rowsOf = (a: DiffBlock[], b: DiffBlock[]) => splitRows(a, b, diffBlocks(a, b));
  const textOfP = (blk: DiffBlock) => (blk.content as Array<{ text: string }>)[0].text;
  /** 不變量：left／right 各自（忽略 null）嚴格遞增，且 a、b 每個索引各恰出現一次。 */
  const checkInvariants = (a: DiffBlock[], b: DiffBlock[], rows: SplitRow[]) => {
    const ls = rows.map((r) => r.left).filter((x): x is number => x !== null);
    const rs = rows.map((r) => r.right).filter((x): x is number => x !== null);
    expect(ls).toEqual(a.map((_, i) => i));
    expect(rs).toEqual(b.map((_, i) => i));
    expect(rows.every((r) => r.left !== null || r.right !== null)).toBe(true);
  };

  it("中間插入：a=[p1,p2]、b=[p1,new,p2] → 左 2 與右 3 同列", () => {
    const a = [p("A", "one"), p("B", "two")];
    const b = [p("A", "one"), p("N", "new"), p("B", "two")];
    expect(rowsOf(a, b)).toEqual([
      { left: 0, right: 0 },
      { left: null, right: 1 },
      { left: 1, right: 2 },
    ]);
  });

  it("刪除：左單側列", () => {
    const a = [p("A", "one"), p("D", "gone"), p("B", "two")];
    const b = [p("A", "one"), p("B", "two")];
    expect(rowsOf(a, b)).toEqual([
      { left: 0, right: 0 },
      { left: 1, right: null },
      { left: 2, right: 1 },
    ]);
  });

  it("修改：changed 仍同列", () => {
    const a = [p("A", "one"), p("B", "two")];
    const b = [p("A", "one changed"), p("B", "two")];
    expect(rowsOf(a, b)).toEqual([
      { left: 0, right: 0 },
      { left: 1, right: 1 },
    ]);
  });

  it("moved 對子不對齊：左右各佔一列、不同列", () => {
    const a = [p("A", "a"), p("B", "b"), p("C", "c")];
    const b = [p("C", "c"), p("A", "a"), p("B", "b")];
    expect(diffBlocks(a, b).find((e) => e.key === "C")?.moved).toBe(true);
    const rows = rowsOf(a, b);
    expect(rows).toEqual([
      { left: null, right: 0 },
      { left: 0, right: 1 },
      { left: 1, right: 2 },
      { left: 2, right: null },
    ]);
    checkInvariants(a, b, rows);
  });

  it("刪增交錯：a 刪 2、b 增 3 → 兩列兩側並排、一列只有右側", () => {
    const a = [p("A", "head"), p("D1", "x"), p("D2", "y"), p("B", "tail")];
    const b = [p("A", "head"), p("N1", "p"), p("N2", "q"), p("N3", "r"), p("B", "tail")];
    expect(rowsOf(a, b)).toEqual([
      { left: 0, right: 0 },
      { left: 1, right: 1 },
      { left: 2, right: 2 },
      { left: null, right: 3 },
      { left: 3, right: 4 },
    ]);
  });

  it("錨列交叉降級：兩側皆空文字的對子 moved=false 但 a 索引倒退 → 當成兩側未對齊", () => {
    const a = [p("e1", ""), p("X", "x")];
    const b = [p("X", "x"), p("e2", "")];
    const entries = diffBlocks(a, b);
    // 前提：空行對子確實配上了、且 moved 恆 false（否則這案沒有鑑別力）
    const blank = entries.find((e) => e.before === a[0]);
    expect(blank?.after).toBe(b[1]);
    expect(blank?.moved).toBe(false);
    const rows = splitRows(a, b, entries);
    expect(rows).toEqual([
      { left: 0, right: null },
      { left: 1, right: 0 },
      { left: null, right: 1 },
    ]);
    checkInvariants(a, b, rows);
  });

  it("review I-1：第一段開頭按 Enter＋文末空段打字 → 遠處配到的空行對子不搶錨列，alpha／beta／gamma 各自左右同列", () => {
    // a＝存版時：三段＋文末空段 T；b＝現在：第一段開頭按 Enter（舊 id 1 留在空段、alpha 換新 id X）、在 T 打字、又多一個空段 M。
    const a = [p("1", "alpha"), p("2", "beta"), p("3", "gamma"), p("T", "")];
    const b = [p("1", ""), p("X", "alpha"), p("2", "beta"), p("3", "gamma"), p("T", "tail"), p("M", "")];
    const entries = diffBlocks(a, b);
    // 前提（真 diffBlocks）：a 的空段 T 與 b 開頭的空段配成對子、moved=false，且在 entries 裡排第一（舊寫法會先拿它當錨）。
    expect(entries[0].before).toBe(a[3]);
    expect(entries[0].after).toBe(b[0]);
    expect(entries[0].moved).toBe(false);
    const rows = splitRows(a, b, entries);
    for (const [ai, bi] of [
      [0, 1],
      [1, 2],
      [2, 3],
    ]) {
      expect(rows, `a[${ai}] 與 b[${bi}] 同列`).toContainEqual({ left: ai, right: bi });
    }
    expect(rows).toEqual([
      { left: null, right: 0 },
      { left: 0, right: 1 },
      { left: 1, right: 2 },
      { left: 2, right: 3 },
      { left: 3, right: 4 },
      { left: null, right: 5 },
    ]);
    checkInvariants(a, b, rows);
  });

  it("空行對子夾在相鄰兩錨列之間 → 升格為錨列（同列）", () => {
    // a 多一顆只在左側的 D：不升格的話降級逐顆並排會把 D 與 b 的空行排同列，空行對子與 Y 都錯開。
    const a = [p("X", "x"), p("D", "gone"), p("e1", ""), p("Y", "y")];
    const b = [p("X", "x"), p("e2", ""), p("Y", "y")];
    const entries = diffBlocks(a, b);
    expect(entries.some((e) => e.before === a[2] && e.after === b[1])).toBe(true);
    expect(splitRows(a, b, entries)).toEqual([
      { left: 0, right: 0 },
      { left: 1, right: null },
      { left: 2, right: 1 },
      { left: 3, right: 2 },
    ]);
  });

  it("空側：a 為空 → 全是右側單側列；b 為空 → 全是左側單側列", () => {
    const b = [p("A", "a"), p("B", "b")];
    expect(rowsOf([], b)).toEqual([
      { left: null, right: 0 },
      { left: null, right: 1 },
    ]);
    expect(rowsOf(b, [])).toEqual([
      { left: 0, right: null },
      { left: 1, right: null },
    ]);
  });

  it("巢狀子區塊不另成列：只看頂層", () => {
    const a = [p("A", "a", [p("A1", "child")])];
    const b = [p("A", "a", [p("A1", "child"), p("A2", "new child")]), p("B", "b")];
    expect(rowsOf(a, b)).toEqual([
      { left: 0, right: 0 },
      { left: null, right: 1 },
    ]);
  });

  it("不變量：多組亂數編輯（刪、增、改、搬、空行、換 id）每列兩側索引嚴格遞增、a／b 每個索引恰出現一次", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const words = ["alpha", "beta", "gamma", "delta", "", "", "epsilon zeta eta theta", "iota kappa lambda mu nu"];
    for (let round = 0; round < 200; round += 1) {
      const n = Math.floor(rnd() * 8);
      const a = Array.from({ length: n }, (_, i) => p(`a${i}`, words[Math.floor(rnd() * words.length)]));
      let b = a.filter(() => rnd() > 0.25).map((blk) => (rnd() < 0.2 ? p(rnd() < 0.5 ? blk.id! : `r${round}-${blk.id}`, `${textOfP(blk)} more`) : blk));
      const adds = Math.floor(rnd() * 4);
      for (let k = 0; k < adds; k += 1) b.splice(Math.floor(rnd() * (b.length + 1)), 0, p(`n${round}-${k}`, words[Math.floor(rnd() * words.length)]));
      if (rnd() < 0.3 && b.length > 1) b = [...b.slice(1), b[0]];
      checkInvariants(a, b, splitRows(a, b, diffBlocks(a, b)));
    }
  });
});
