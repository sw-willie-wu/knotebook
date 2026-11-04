import { describe, it, expect } from "vitest";
import {
  buildLayout,
  casefoldKey,
  sanitizeSegment,
  sanitizeTitle,
  SEGMENT_MAX,
  type LayoutFolder,
  type LayoutGroup,
  type LayoutNote,
} from "../../src/transfer/paths.js";
import type { BulkRange } from "../../src/auth/transfer-token.js";

/** bulk transfer spec §6.2、§6.3；plan §0.1-5、-6。 */

const T0 = new Date("2026-01-01T00:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const note = (title: string, extra: Partial<LayoutNote> = {}): LayoutNote => ({
  id: uid(),
  title,
  createdAt: T0,
  space: "personal",
  groupId: null,
  folderId: null,
  ...extra,
});
const folder = (name: string, extra: Partial<LayoutFolder> = {}): LayoutFolder => ({
  id: uid(),
  name,
  parentId: null,
  createdAt: T0,
  space: { kind: "personal" },
  ...extra,
});
const group = (name: string, extra: Partial<LayoutGroup> = {}): LayoutGroup => ({ id: uid(), name, createdAt: T0, ...extra });
const ALL: BulkRange = { kind: "all" };

describe("sanitizeSegment 規則 1：非法字元 → _", () => {
  it.each([
    ["a<b", "a_b"],
    ["a>b", "a_b"],
    ["a:b", "a_b"],
    ['a"b', "a_b"],
    ["a/b", "a_b"],
    ["a\\b", "a_b"],
    ["a|b", "a_b"],
    ["a?b", "a_b"],
    ["a*b", "a_b"],
    ["a\u0000b", "a_b"],
    ["a\tb", "a_b"],
    ["a\u001fb", "a_b"],
    ["a\u007fb", "a_b"],
    ["a\u202ab", "a_b"],
    ["a\u202eb", "a_b"],
    ["a\u2066b", "a_b"],
    ["a\u2069b", "a_b"],
    ["a\u200bb", "a_b"],
    ["a\u200fb", "a_b"],
    ["a\ufeffb", "a_b"],
  ])("%j → %j", (raw, want) => {
    expect(sanitizeSegment(raw)).toBe(want);
  });
  it("N1（8000 探索測試）shell 在雙引號內仍會展開的 `$`、反引號、`!` → _；標題與資料夾名都是", () => {
    const shell = ["$", "`", "!"];
    for (const raw of ["$(touch x)", "`id`", "$HOME", "a!b", "${PATH}", "$(echo PWNED>>pwned.txt)"]) {
      for (const out of [sanitizeSegment(raw), sanitizeTitle(raw)]) for (const c of shell) expect(out, `${raw} → ${out}`).not.toContain(c);
    }
    expect(sanitizeTitle("$(touch x)")).toBe("_(touch x)");
    expect(sanitizeTitle("`id`")).toBe("_id_");
    expect(sanitizeTitle("$HOME")).toBe("_HOME");
    expect(sanitizeTitle("a!b")).toBe("a_b");
    // 整條匯出路徑（標題＋資料夾名）也不含這三個字元
    const f = folder("$(echo x)");
    const n1 = note("$(touch x)", { folderId: f.id });
    const n2 = note("`id`");
    const n3 = note("a!b $HOME");
    const { files, dirs } = buildLayout({ notes: [n1, n2, n3], folders: [f], groups: [], range: ALL });
    for (const p of [...files.values(), ...dirs.map(d => d.path)]) for (const c of shell) expect(p, p).not.toContain(c);
    expect(files.get(n1.id)).toBe("My notes/_(echo x)/_(touch x).md");
  });
  it("四個區間的外側鄰字不換（U+2029、U+202F、U+2065、U+206A、U+200A、U+2010、U+0080）", () => {
    expect(sanitizeSegment("a\u2029b\u202fb\u2065b\u206ab\u200ab\u2010b\u0080b~")).toBe("a\u2029b\u202fb\u2065b\u206ab\u200ab\u2010b\u0080b~");
  });
});

describe("sanitizeSegment 規則 2–6", () => {
  it("P2 規則 2：尾端 . 與空白去掉；空了 → _", () => {
    expect(sanitizeSegment("a. ")).toBe("a");
    expect(sanitizeSegment("...")).toBe("_");
    expect(sanitizeSegment("   ")).toBe("_");
    expect(sanitizeSegment("a . .")).toBe("a");
  });
  it("P3 規則 3：保留名（不分大小寫、含帶副檔名形）前加 _；COM10 不是保留名", () => {
    expect(sanitizeSegment("CON")).toBe("_CON");
    expect(sanitizeSegment("con.md")).toBe("_con.md");
    expect(sanitizeSegment("Lpt9")).toBe("_Lpt9");
    expect(sanitizeSegment("aux.tar.gz")).toBe("_aux.tar.gz");
    expect(sanitizeSegment("COM10")).toBe("COM10");
    expect(sanitizeSegment("CONSOLE")).toBe("CONSOLE");
    // 規則 ② 去尾端空白之後才判保留名（Windows 也把 "CON " 當保留名）
    expect(sanitizeSegment("CON ")).toBe("_CON");
    expect(sanitizeSegment("aux  ")).toBe("_aux");
    expect(sanitizeSegment("nul.")).toBe("_nul");
  });
  it("P4 規則 4：開頭 . → _（只換第一個）", () => {
    expect(sanitizeSegment(".git")).toBe("_git");
    expect(sanitizeSegment(".")).toBe("_");
    // N9（8000 探索測試，docs/mcp.md 照這幾形寫）：`..` → `_`（第一個點換掉、尾端的點去掉）；`.knotebook` → `_knotebook`；
    // 標題 `.`、`..`、`...` 清洗後只剩 `_` → Untitled
    expect(sanitizeSegment("..")).toBe("_");
    expect(sanitizeSegment(".knotebook")).toBe("_knotebook");
    for (const t of [".", "..", "..."]) expect(sanitizeTitle(t), t).toBe("Untitled");
    // 同一層的 `.` 與 `..` 資料夾都清成 `_`，後建的那個拿 ` (2)`
    const a = folder(".", { createdAt: at(0) });
    const b = folder("..", { createdAt: at(1) });
    const { dirs } = buildLayout({ notes: [], folders: [a, b], groups: [], range: ALL });
    expect(dirs.filter(d => d.id === a.id || d.id === b.id).map(d => d.path)).toEqual(["My notes/_", "My notes/_ (2)"]);
  });
  it("P5 規則 5：NFC", () => {
    const out = sanitizeSegment("e\u0301");
    expect(out).toBe("\u00e9");
    expect(Array.from(out)).toHaveLength(1);
  });
  it("P6 規則 6：截到 64 code point（不切代理對），截完 trimEnd", () => {
    const astral = "\u{20BB7}".repeat(65);
    const out = sanitizeSegment(astral);
    expect(Array.from(out)).toHaveLength(SEGMENT_MAX);
    expect(out).toBe("\u{20BB7}".repeat(64));
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    const spaced = "a".repeat(63) + " " + "b".repeat(10);
    expect(sanitizeSegment(spaced)).toBe("a".repeat(63));
    expect(Array.from(sanitizeSegment("x".repeat(64)))).toHaveLength(64);
  });
});

describe("sanitizeTitle（規則 8）", () => {
  it("P7 清洗後空或只由 _ 組成 → Untitled；a_／_a 保留", () => {
    for (const t of ["", "   ", "_", "///", "...", "__"]) expect(sanitizeTitle(t), JSON.stringify(t)).toBe("Untitled");
    expect(sanitizeTitle("a_")).toBe("a_");
    expect(sanitizeTitle("_a")).toBe("_a");
    expect(sanitizeTitle("會議紀錄")).toBe("會議紀錄");
  });
});

describe("casefoldKey", () => {
  it("NFC → toUpperCase → toLowerCase（ß 與 SS 同鍵；\u00e9 兩種寫法同鍵）", () => {
    expect(casefoldKey("ß")).toBe(casefoldKey("SS"));
    expect(casefoldKey("e\u0301")).toBe(casefoldKey("\u00c9"));
    expect(casefoldKey("Abc")).toBe("abc");
  });
});

describe("buildLayout 判重（規則 7、9）", () => {
  it("P8 同目錄 A／a：createdAt 早的拿原名，晚的 (2)", () => {
    const late = note("A", { createdAt: at(10) });
    const early = note("a", { createdAt: at(1) });
    const L = buildLayout({ notes: [late, early], folders: [], groups: [], range: { kind: "personal" } });
    expect(L.files.get(early.id)).toBe("My notes/a.md");
    expect(L.files.get(late.id)).toBe("My notes/A (2).md");
  });
  it("P8 清洗後撞名（a:b／a_b）、ß／SS、第三個拿 (3)", () => {
    const n1 = note("a:b", { createdAt: at(1) });
    const n2 = note("a_b", { createdAt: at(2) });
    const n3 = note("a|b", { createdAt: at(3) });
    const s1 = note("ß", { createdAt: at(4) });
    const s2 = note("SS", { createdAt: at(5) });
    const L = buildLayout({ notes: [n3, s2, n2, s1, n1], folders: [], groups: [], range: { kind: "personal" } });
    expect([n1, n2, n3, s1, s2].map(n => L.files.get(n.id))).toEqual([
      "My notes/a_b.md",
      "My notes/a_b (2).md",
      "My notes/a_b (3).md",
      "My notes/ß.md",
      "My notes/SS (2).md",
    ]);
  });
  it("P8 createdAt 相同時以 id 排", () => {
    const hi = { ...note("x"), id: "ffffffff-0000-4000-8000-000000000000" };
    const lo = { ...note("X"), id: "00000000-ffff-4000-8000-000000000000" };
    const L = buildLayout({ notes: [hi, lo], folders: [], groups: [], range: { kind: "personal" } });
    expect(L.files.get(lo.id)).toBe("My notes/X.md");
    expect(L.files.get(hi.id)).toBe("My notes/x (2).md");
  });
  it("P8 尾碼找第一個空位：已有「a (2)」標題時第二個 a 拿 (3)", () => {
    const a1 = note("a", { createdAt: at(1) });
    const a2lit = note("a (2)", { createdAt: at(2) });
    const a3 = note("A", { createdAt: at(3) });
    const L = buildLayout({ notes: [a3, a2lit, a1], folders: [], groups: [], range: { kind: "personal" } });
    expect([a1, a2lit, a3].map(n => L.files.get(n.id))).toEqual(["My notes/a.md", "My notes/a (2).md", "My notes/A (3).md"]);
  });
  it("P9 規則 9：資料夾 x.md 與筆記 x 同層 → 檔 x.md、資料夾 x.md (2)（即使資料夾較早）", () => {
    const f = folder("x.md", { createdAt: at(0) });
    const n = note("x", { createdAt: at(5) });
    const inF = note("inside", { folderId: f.id });
    const L = buildLayout({ notes: [n, inF], folders: [f], groups: [], range: { kind: "personal" } });
    expect(L.files.get(n.id)).toBe("My notes/x.md");
    expect(L.files.get(inF.id)).toBe("My notes/x.md (2)/inside.md");
    expect(L.dirs.map(d => d.path)).toContain("My notes/x.md (2)");
  });
  it("資料夾之間同層撞名也加尾碼（清洗後 a/b 與 a_b）", () => {
    const f1 = folder("a/b", { createdAt: at(1) });
    const f2 = folder("a_b", { createdAt: at(2) });
    const L = buildLayout({ notes: [], folders: [f2, f1], groups: [], range: { kind: "personal" } });
    expect(L.dirs.find(d => d.id === f1.id)!.path).toBe("My notes/a_b");
    expect(L.dirs.find(d => d.id === f2.id)!.path).toBe("My notes/a_b (2)");
  });
});

describe("buildLayout 配置（P10–P12）", () => {
  function world() {
    seq = 1000;
    const g1 = group("團隊", { createdAt: at(1) });
    const g2 = group("團隊", { createdAt: at(2) });
    const gEmpty = group("沒有筆記", { createdAt: at(3) });
    const gSlash = group("a/b", { createdAt: at(4) });
    const gDots = group("..", { createdAt: at(5) });
    const gCon = group("CON", { createdAt: at(6) });
    // 個人：5 層巢狀＋空資料夾
    const p1 = folder("L1");
    const p2 = folder("L2", { parentId: p1.id });
    const p3 = folder("L3", { parentId: p2.id });
    const p4 = folder("L4", { parentId: p3.id });
    const p5 = folder("L5", { parentId: p4.id });
    const pEmpty = folder("空的");
    const pSlash = folder("x/y");
    // 群組資料夾、我的 shared 資料夾
    const gf = folder("規格", { space: { kind: "group", groupId: g1.id } });
    const sf = folder("別人的", { space: { kind: "shared" } });
    const nPersonal = note("個人");
    const nDeep = note("深", { folderId: p5.id });
    const nG1 = note("g1 頂層", { space: "group", groupId: g1.id });
    const nG1f = note("g1 規格", { space: "group", groupId: g1.id, folderId: gf.id });
    const nG2 = note("g2 頂層", { space: "group", groupId: g2.id });
    const nShTop = note("分享頂層", { space: "shared" });
    const nShF = note("分享放好", { space: "shared", folderId: sf.id });
    const nLost = note("找不到資料夾", { folderId: "deadbeef-0000-4000-8000-000000000000" });
    const nSlashG = note("在 a_b 群組", { space: "group", groupId: gSlash.id });
    return { g1, g2, gEmpty, gSlash, gDots, gCon, p1, p2, p3, p4, p5, pEmpty, pSlash, gf, sf, nPersonal, nDeep, nG1, nG1f, nG2, nShTop, nShF, nLost, nSlashG };
  }

  it("P10 三空間＋巢狀＋空資料夾＋shared placement 有無＋同名群組＋沒有筆記的群組；dirs 的 id／space", () => {
    const w = world();
    const L = buildLayout({
      notes: [w.nPersonal, w.nDeep, w.nG1, w.nG1f, w.nG2, w.nShTop, w.nShF, w.nLost, w.nSlashG],
      folders: [w.p1, w.p2, w.p3, w.p4, w.p5, w.pEmpty, w.pSlash, w.gf, w.sf],
      groups: [w.g1, w.g2, w.gEmpty, w.gSlash, w.gDots, w.gCon],
      range: ALL,
    });
    expect(Object.fromEntries([...L.files].map(([id, p]) => [id, p]))).toEqual({
      [w.nPersonal.id]: "My notes/個人.md",
      [w.nDeep.id]: "My notes/L1/L2/L3/L4/L5/深.md",
      [w.nG1.id]: "Groups/團隊/g1 頂層.md",
      [w.nG1f.id]: "Groups/團隊/規格/g1 規格.md",
      [w.nG2.id]: "Groups/團隊 (2)/g2 頂層.md",
      [w.nShTop.id]: "Shared with me/分享頂層.md",
      [w.nShF.id]: "Shared with me/別人的/分享放好.md",
      [w.nLost.id]: "My notes/找不到資料夾.md",
      [w.nSlashG.id]: "Groups/a_b/在 a_b 群組.md",
    });
    expect(L.dirs).toEqual([
      { path: "Groups", id: null, space: null },
      { path: "Groups/_", id: null, space: { kind: "group", groupId: w.gDots.id } },
      { path: "Groups/_CON", id: null, space: { kind: "group", groupId: w.gCon.id } },
      { path: "Groups/a_b", id: null, space: { kind: "group", groupId: w.gSlash.id } },
      { path: "Groups/團隊", id: null, space: { kind: "group", groupId: w.g1.id } },
      { path: "Groups/團隊 (2)", id: null, space: { kind: "group", groupId: w.g2.id } },
      { path: "Groups/團隊/規格", id: w.gf.id, space: { kind: "group", groupId: w.g1.id } },
      { path: "Groups/沒有筆記", id: null, space: { kind: "group", groupId: w.gEmpty.id } },
      { path: "My notes", id: null, space: null },
      { path: "My notes/L1", id: w.p1.id, space: { kind: "personal" } },
      { path: "My notes/L1/L2", id: w.p2.id, space: { kind: "personal" } },
      { path: "My notes/L1/L2/L3", id: w.p3.id, space: { kind: "personal" } },
      { path: "My notes/L1/L2/L3/L4", id: w.p4.id, space: { kind: "personal" } },
      { path: "My notes/L1/L2/L3/L4/L5", id: w.p5.id, space: { kind: "personal" } },
      { path: "My notes/x_y", id: w.pSlash.id, space: { kind: "personal" } },
      { path: "My notes/空的", id: w.pEmpty.id, space: { kind: "personal" } },
      { path: "Shared with me", id: null, space: null },
      { path: "Shared with me/別人的", id: w.sf.id, space: { kind: "shared" } },
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
  });

  it("P12 dirs 依完整路徑 code unit 序（Groups/… < My notes/… < Shared with me/…）", () => {
    const w = world();
    const L = buildLayout({ notes: [], folders: [w.sf, w.pEmpty, w.gf], groups: [w.g1], range: ALL });
    const paths = L.dirs.map(d => d.path);
    expect(paths).toEqual(["Groups", "Groups/團隊", "Groups/團隊/規格", "My notes", "My notes/空的", "Shared with me", "Shared with me/別人的"]);
    expect([...paths].sort()).toEqual(paths);
  });

  it("P11 範圍縮小（personal、資料夾）：輸入是完整集合，輸出只有範圍內、路徑逐字等於全部範圍", () => {
    const w = world();
    const input = {
      notes: [w.nPersonal, w.nDeep, w.nG1, w.nShTop],
      folders: [w.p1, w.p2, w.p3, w.p4, w.p5, w.pEmpty, w.gf, w.sf],
      groups: [w.g1],
    };
    const full = buildLayout({ ...input, range: ALL });
    const personal = buildLayout({ ...input, range: { kind: "personal" } });
    expect([...personal.files.keys()].sort()).toEqual([w.nPersonal.id, w.nDeep.id].sort());
    expect(personal.files.get(w.nDeep.id)).toBe(full.files.get(w.nDeep.id));
    expect(personal.dirs).toEqual(full.dirs.filter(d => d.path === "My notes" || d.path.startsWith("My notes/")));
    // 資料夾範圍：祖先鏈（含頂層）＋子樹
    const sub = buildLayout({ ...input, range: { kind: "folder", folderId: w.p3.id } });
    expect([...sub.files.values()]).toEqual(["My notes/L1/L2/L3/L4/L5/深.md"]);
    expect(sub.dirs.map(d => d.path)).toEqual(["My notes", "My notes/L1", "My notes/L1/L2", "My notes/L1/L2/L3", "My notes/L1/L2/L3/L4", "My notes/L1/L2/L3/L4/L5"]);
  });

  it("群組名清洗（gate r1 m10）：/ 不多一層、.. → _、CON → _CON；資料夾名 a/b 不多一層", () => {
    const w = world();
    const L = buildLayout({ notes: [w.nSlashG], folders: [w.pSlash], groups: [w.gSlash, w.gDots, w.gCon], range: ALL });
    expect(L.files.get(w.nSlashG.id)).toBe("Groups/a_b/在 a_b 群組.md");
    for (const d of L.dirs) expect(d.path.split("/").length, d.path).toBeLessThanOrEqual(2);
    expect(L.dirs.map(d => d.path)).toEqual(expect.arrayContaining(["Groups/_", "Groups/_CON", "Groups/a_b", "My notes/x_y"]));
    expect(L.dirs.map(d => d.path)).not.toContain("Groups/..");
  });

  it("標題清洗進檔名：空標題 → Untitled.md；兩篇空標題 → Untitled (2).md", () => {
    const a = note("", { createdAt: at(1) });
    const b = note("///", { createdAt: at(2) });
    const L = buildLayout({ notes: [a, b], folders: [], groups: [], range: { kind: "personal" } });
    expect([L.files.get(a.id), L.files.get(b.id)]).toEqual(["My notes/Untitled.md", "My notes/Untitled (2).md"]);
  });
});

describe("buildLayout 範圍縮小：命名在完整集合上算、再依範圍篩（spec §6.2；T1–T6 審查 I1）", () => {
  /** 會讓「只看範圍內的同層」算出不同名字的三形：同名群組、清洗後撞名的資料夾、規則 9（祖先層的筆記 x 與資料夾 x.md）。 */
  function world() {
    seq = 5000;
    const gA = group("Team", { createdAt: at(1) });
    const gB = group("Team", { createdAt: at(2) });
    const gC = group("Other", { createdAt: at(3) });
    const fAB1 = folder("a:b", { createdAt: at(1) });
    const fAB2 = folder("a_b", { createdAt: at(2) });
    const fXmd = folder("x.md", { createdAt: at(0) });
    const fXmdKid = folder("kid", { parentId: fXmd.id });
    const gAf = folder("spec", { space: { kind: "group", groupId: gA.id } });
    const gBf = folder("spec", { space: { kind: "group", groupId: gB.id } });
    const sf = folder("放這", { space: { kind: "shared" } });
    const notes = [
      note("x", { createdAt: at(5) }),
      note("in a", { folderId: fAB1.id }),
      note("in b", { folderId: fAB2.id }),
      note("inside", { folderId: fXmd.id }),
      note("deep", { folderId: fXmdKid.id }),
      note("A 頂層", { space: "group", groupId: gA.id }),
      note("A spec", { space: "group", groupId: gA.id, folderId: gAf.id }),
      note("B 頂層", { space: "group", groupId: gB.id }),
      note("B spec", { space: "group", groupId: gB.id, folderId: gBf.id }),
      note("C 頂層", { space: "group", groupId: gC.id }),
      note("分享頂層", { space: "shared" }),
      note("分享放好", { space: "shared", folderId: sf.id }),
    ];
    const folders = [fAB1, fAB2, fXmd, fXmdKid, gAf, gBf, sf];
    const groups = [gA, gB, gC];
    return { gA, gB, gC, fAB1, fAB2, fXmd, fXmdKid, gAf, gBf, sf, notes, folders, groups };
  }

  it("每一種範圍：files 與 dirs 都 ⊂ 全部範圍那份，而且逐字相同", () => {
    const w = world();
    const full = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: ALL });
    expect(full.files.size).toBe(w.notes.length);
    const ranges: BulkRange[] = [
      { kind: "personal" },
      { kind: "shared" },
      ...w.groups.map(g => ({ kind: "group" as const, groupId: g.id })),
      ...w.folders.map(f => ({ kind: "folder" as const, folderId: f.id })),
    ];
    const fullDirs = new Map(full.dirs.map(d => [d.path, d]));
    for (const range of ranges) {
      const L = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range });
      const tag = JSON.stringify(range);
      for (const [id, path] of L.files) expect(path, `${tag} ${id}`).toBe(full.files.get(id));
      for (const d of L.dirs) expect(fullDirs.get(d.path), `${tag} ${d.path}`).toEqual(d);
      expect(L.dirs.length, tag).toBeGreaterThan(0);
    }
  });

  it("同名群組：只抓第二個 Team 時仍是 Groups/Team (2)/…，不會落到第一個 Team 的路徑；目錄只有 Groups 與這個群組", () => {
    const w = world();
    const L = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "group", groupId: w.gB.id } });
    expect([...L.files.values()].sort()).toEqual(["Groups/Team (2)/B 頂層.md", "Groups/Team (2)/spec/B spec.md"]);
    expect(L.dirs.map(d => d.path)).toEqual(["Groups", "Groups/Team (2)", "Groups/Team (2)/spec"]);
  });

  it("清洗後撞名的資料夾：資料夾範圍 a_b (2) 的路徑同全部範圍；祖先鏈只有頂層目錄", () => {
    const w = world();
    const L = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "folder", folderId: w.fAB2.id } });
    expect([...L.files.values()]).toEqual(["My notes/a_b (2)/in b.md"]);
    expect(L.dirs.map(d => d.path)).toEqual(["My notes", "My notes/a_b (2)"]);
  });

  it("規則 9 在祖先層：資料夾範圍 kid（在 x.md (2) 底下）路徑同全部範圍；祖先層的筆記 x 不在輸出裡", () => {
    const w = world();
    const L = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "folder", folderId: w.fXmdKid.id } });
    expect([...L.files.values()]).toEqual(["My notes/x.md (2)/kid/deep.md"]);
    expect(L.dirs.map(d => d.path)).toEqual(["My notes", "My notes/x.md (2)", "My notes/x.md (2)/kid"]);
  });

  it("群組資料夾範圍：祖先鏈含 Groups 與群組目錄；shared 資料夾範圍取讀者 placement 在子樹裡的筆記", () => {
    const w = world();
    const g = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "folder", folderId: w.gBf.id } });
    expect(g.dirs.map(d => d.path)).toEqual(["Groups", "Groups/Team (2)", "Groups/Team (2)/spec"]);
    expect([...g.files.values()]).toEqual(["Groups/Team (2)/spec/B spec.md"]);
    const s = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "folder", folderId: w.sf.id } });
    expect(s.dirs.map(d => d.path)).toEqual(["Shared with me", "Shared with me/放這"]);
    expect([...s.files.values()]).toEqual(["Shared with me/放這/分享放好.md"]);
  });

  it("personal／shared 範圍：只有該頂層目錄與其下；群組目錄不寫", () => {
    const w = world();
    const p = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "personal" } });
    expect(p.dirs.every(d => d.path === "My notes" || d.path.startsWith("My notes/"))).toBe(true);
    expect([...p.files.values()].every(v => v.startsWith("My notes/"))).toBe(true);
    expect(p.files.size).toBe(5);
    const s = buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "shared" } });
    expect(s.dirs.map(d => d.path)).toEqual(["Shared with me", "Shared with me/放這"]);
    expect(s.files.size).toBe(2);
  });

  it("範圍所指的群組／資料夾不在輸入裡 → 丟錯（呼叫端先判 403）", () => {
    const w = world();
    expect(() => buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "group", groupId: uid() } })).toThrow();
    expect(() => buildLayout({ notes: w.notes, folders: w.folders, groups: w.groups, range: { kind: "folder", folderId: uid() } })).toThrow();
  });

  it("同名群組的輸入順序不影響命名（依 createdAt、id）", () => {
    const w = world();
    const a = buildLayout({ notes: w.notes, folders: w.folders, groups: [w.gA, w.gB, w.gC], range: ALL });
    const b = buildLayout({ notes: w.notes, folders: w.folders, groups: [w.gC, w.gB, w.gA], range: ALL });
    expect([...b.files].sort()).toEqual([...a.files].sort());
    expect(b.dirs).toEqual(a.dirs);
    expect(a.dirs.find(d => d.space?.kind === "group" && d.space.groupId === w.gA.id && d.id === null)!.path).toBe("Groups/Team");
  });
});

describe("檔名開頭的空白（known-limitations；8000 探索測試 I）", () => {
  it("開頭的空白保留、結尾的空白去掉", () => {
    expect(sanitizeTitle("  前後空白  ")).toBe("  前後空白");
  });
});
