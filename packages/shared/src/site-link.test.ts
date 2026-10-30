import { describe, expect, it } from "vitest";
import {
  BLOCK_ANCHOR_RE,
  convertSiteLinks,
  escapeLinkText,
  linkText,
  mapInlineArrays,
  normalizeAnchor,
  parseSiteNoteHref,
  resolveFromList,
  targetFromList,
  wikilinkDisplayText,
  wikilinkHref,
  wikilinkPropsFromLink,
  wikilinkVisibleText,
  wikilinksToLinks,
  type SiteLinkCandidate,
} from "./site-link.js";

// spec 2026-10-13 site-links §6、§15.1 S1／S2。

const ORIGIN = "https://kb.example.com";
const GID = "AAAAAAAA-1111-4111-8111-111111111111";
const NOTE_ID = "11111111-2222-4333-8444-555555555555";

describe("S1 parseSiteNoteHref（唯一的站內網址判準）", () => {
  const ok = (href: string) => parseSiteNoteHref(href, ORIGIN);
  it("三形 × 相對", () => {
    expect(ok("/n/alice/my-note")).toEqual({ path: { kind: "n", handle: "alice", slug: "my-note" }, anchorBlockId: "" });
    expect(ok(`/g/${GID}/plan`)).toEqual({ path: { kind: "g", groupId: GID.toLowerCase(), slug: "plan" }, anchorBlockId: "" });
    expect(ok(`/notes/${NOTE_ID}`)).toEqual({ path: { kind: "ref", ref: NOTE_ID }, anchorBlockId: "" });
    expect(ok("/notes/old-vanity-slug")).toEqual({ path: { kind: "ref", ref: "old-vanity-slug" }, anchorBlockId: "" });
  });
  it("三形 × 同 origin 絕對；`HTTPS:`／`Http:` 大小寫都收", () => {
    expect(ok(`${ORIGIN}/n/alice/my-note`)?.path).toEqual({ kind: "n", handle: "alice", slug: "my-note" });
    expect(ok(`HTTPS://kb.example.com/g/${GID}/plan`)?.path).toEqual({ kind: "g", groupId: GID.toLowerCase(), slug: "plan" });
    expect(ok(`Https://kb.example.com/notes/${NOTE_ID}`)?.path).toEqual({ kind: "ref", ref: NOTE_ID });
  });
  it("handle 與 slug 正規化：handle 只做 ASCII 小寫、slug 做 NFC＋小寫", () => {
    expect(ok("/n/Alice/My-Note")?.path).toEqual({ kind: "n", handle: "alice", slug: "my-note" });
  });
  it("#b-<id>：合 BLOCK_ANCHOR_RE 的成為 anchorBlockId；壞 id、#/slide、其他 fragment → null；空 # 照收", () => {
    expect(ok("/n/alice/x#b-abc_DEF-123")?.anchorBlockId).toBe("abc_DEF-123");
    expect(ok(`/notes/${NOTE_ID}#b-${"a".repeat(64)}`)?.anchorBlockId).toBe("a".repeat(64));
    expect(ok(`/notes/${NOTE_ID}#b-${"a".repeat(65)}`)).toBeNull();
    expect(ok("/n/alice/x#b-壞")).toBeNull();
    expect(ok("/n/alice/x#b-")).toBeNull();
    expect(ok("/n/alice/x#/slide-1")).toBeNull();
    expect(ok("/n/alice/x#top")).toBeNull();
    expect(ok("/n/alice/x#")).toEqual({ path: { kind: "n", handle: "alice", slug: "x" }, anchorBlockId: "" });
  });
  it("拒絕：他 origin、`//x`、`/\\x`、首段大寫、結尾斜線、query、帳密、前後空白、相對路徑（不以 / 開頭）、其他 scheme", () => {
    for (const href of [
      "https://evil.example.com/n/alice/x",
      "http://kb.example.com/n/alice/x", // 不同 scheme ＝ 不同 origin
      "//kb.example.com/n/alice/x",
      "/\\kb.example.com/n/alice/x",
      "/N/alice/x",
      "/Notes/" + NOTE_ID,
      "/n/alice/x/",
      "/n/alice/x?present",
      "/n/alice/x?",
      "https://u:p@kb.example.com/n/alice/x",
      " /n/alice/x",
      "/n/alice/x ",
      "n/alice/x",
      "mailto:a@b.c",
      "javascript:alert(1)",
      "https:n/alice/x", // 帶 scheme 的相對網址：不是絕對網址
      "https:/n/alice/x",
      "HTTPS:../n/alice/x",
      "/p/alice/x",
      "/n/alice",
      "/n/alice/x/extra",
      "/g/not-a-uuid/x",
      "/notes",
      "",
    ]) {
      expect(ok(href), href).toBeNull();
    }
  });
  it("壞百分比編碼 → null（decodeURIComponent throw）", () => {
    expect(ok("/n/alice/%E0%A4%A")).toBeNull();
  });
  it("RF2：百分比編碼的 CJK slug 與 NFD slug 都還原成 NFC＋小寫", () => {
    expect(ok("/n/alice/%E4%B8%AD%E6%96%87")?.path).toEqual({ kind: "n", handle: "alice", slug: "中文" });
    const nfd = "Café"; // e + U+0301
    expect(ok(`/n/alice/${encodeURIComponent(nfd)}`)?.path).toEqual({ kind: "n", handle: "alice", slug: "café" });
  });
});

describe("建構器、anchor 正規化、顯示文字", () => {
  it("wikilinkHref", () => {
    expect(wikilinkHref(NOTE_ID, "")).toBe(`/notes/${NOTE_ID}`);
    expect(wikilinkHref(NOTE_ID, "b1")).toBe(`/notes/${NOTE_ID}#b-b1`);
  });
  it("normalizeAnchor：不合 BLOCK_ANCHOR_RE 一律當空", () => {
    expect(BLOCK_ANCHOR_RE.source).toBe("^[A-Za-z0-9_-]{1,64}$");
    expect(normalizeAnchor("ok_1")).toBe("ok_1");
    expect(normalizeAnchor("壞")).toBe("");
    expect(normalizeAnchor(42)).toBe("");
    expect(normalizeAnchor(undefined)).toBe("");
  });
  it("wikilinkDisplayText（§4.2）與 wikilinkVisibleText（永不為空）", () => {
    expect(wikilinkDisplayText({ label: "L", snapshotTitle: "S" }, "Live")).toBe("L");
    expect(wikilinkDisplayText({ label: "", snapshotTitle: "S" }, "Live")).toBe("Live");
    expect(wikilinkDisplayText({ label: "", snapshotTitle: "S" })).toBe("S");
    expect(wikilinkDisplayText({ snapshotTitle: "" })).toBe("");
    expect(wikilinkVisibleText({ targetNoteId: NOTE_ID, label: "", snapshotTitle: "", anchorBlockId: "b2" })).toBe(`/notes/${NOTE_ID}#b-b2`);
    expect(wikilinkVisibleText({ targetNoteId: NOTE_ID, label: "", snapshotTitle: "", anchorBlockId: "壞" })).toBe(`/notes/${NOTE_ID}`);
  });
});

describe("label 規則（§6.3，三支各一案＋snapshotTitle 取原文字）", () => {
  const target = { id: NOTE_ID.toUpperCase(), title: "Target Title" };
  const href = `/notes/${NOTE_ID}`;
  it("文字空 → label 空、snapshotTitle 取目標標題", () => {
    expect(wikilinkPropsFromLink({ text: "", href, target, anchorBlockId: "" })).toEqual({
      targetNoteId: NOTE_ID, snapshotTitle: "Target Title", label: "", anchorBlockId: "",
    });
  });
  it("文字＝目標標題 → label 空、snapshotTitle 取原文字", () => {
    expect(wikilinkPropsFromLink({ text: "Target Title", href, target, anchorBlockId: "x1" })).toEqual({
      targetNoteId: NOTE_ID, snapshotTitle: "Target Title", label: "", anchorBlockId: "x1",
    });
  });
  it("文字＝href（裸網址）→ label 空、snapshotTitle 取原文字（A3：不把讀者看不到的目標標題寫進文件）", () => {
    expect(wikilinkPropsFromLink({ text: href, href, target, anchorBlockId: "" })).toEqual({
      targetNoteId: NOTE_ID, snapshotTitle: href, label: "", anchorBlockId: "",
    });
  });
  it("其他文字 → label＝文字（逐字：不 trim、不轉大小寫）", () => {
    expect(wikilinkPropsFromLink({ text: " target title ", href, target, anchorBlockId: "" })).toEqual({
      targetNoteId: NOTE_ID, snapshotTitle: " target title ", label: " target title ", anchorBlockId: "",
    });
  });
  it("targetNoteId 一律轉小寫（NOTE_ID 全是數字、toUpperCase 不變，所以另用含字母的 id 量）", () => {
    const mixed = { id: "ABCDEF00-0000-4000-8000-00000000000A", title: "T" };
    expect(wikilinkPropsFromLink({ text: "", href, target: mixed, anchorBlockId: "" }).targetNoteId).toBe("abcdef00-0000-4000-8000-00000000000a");
  });
});

const CANDIDATES: SiteLinkCandidate[] = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", title: "Mine", slug: "mine", groupId: null, ownerHandle: "alice" },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", title: "Group Note", slug: "plan", groupId: GID.toLowerCase(), ownerHandle: null },
  { id: "aaaaaaaa-0000-4000-8000-000000000003", title: "中文", slug: "中文", groupId: null, ownerHandle: "alice" },
];

describe("resolveFromList（server 預取清單與 web 快取共用）", () => {
  it("n：個人筆記、handle＋slug；群組筆記不會被 /n/ 命中", () => {
    expect(resolveFromList({ kind: "n", handle: "alice", slug: "mine" }, CANDIDATES)?.title).toBe("Mine");
    expect(resolveFromList({ kind: "n", handle: "bob", slug: "mine" }, CANDIDATES)).toBeNull();
    expect(resolveFromList({ kind: "n", handle: "alice", slug: "plan" }, CANDIDATES)).toBeNull();
  });
  it("n：群組筆記即使 ownerHandle 與 slug 都相符也不命中（groupId 必須為 null）", () => {
    const groupOwned: SiteLinkCandidate[] = [
      { id: "aaaaaaaa-0000-4000-8000-000000000004", title: "Group Owned", slug: "same", groupId: GID.toLowerCase(), ownerHandle: "alice" },
    ];
    expect(resolveFromList({ kind: "n", handle: "alice", slug: "same" }, groupOwned)).toBeNull();
  });
  it("g：群組 id＋slug", () => {
    expect(resolveFromList({ kind: "g", groupId: GID.toLowerCase(), slug: "plan" }, CANDIDATES)?.title).toBe("Group Note");
    expect(resolveFromList({ kind: "g", groupId: GID.toLowerCase(), slug: "mine" }, CANDIDATES)).toBeNull();
  });
  it("ref：uuid（大小寫不拘）與 vanity-uuid 尾碼；legacy slug 不命中（留給 server 後備）", () => {
    expect(resolveFromList({ kind: "ref", ref: "AAAAAAAA-0000-4000-8000-000000000001" }, CANDIDATES)?.title).toBe("Mine");
    expect(resolveFromList({ kind: "ref", ref: "my-old-title-aaaaaaaa-0000-4000-8000-000000000002" }, CANDIDATES)?.title).toBe("Group Note");
    expect(resolveFromList({ kind: "ref", ref: "mine" }, CANDIDATES)).toBeNull();
  });
  it("RF2：剖析後的編碼 CJK slug 命中 NFC slug 的那篇", () => {
    const parsed = parseSiteNoteHref("/n/alice/%E4%B8%AD%E6%96%87", ORIGIN)!;
    expect(resolveFromList(parsed.path, CANDIDATES)?.title).toBe("中文");
  });
});

describe("targetFromList（PF-C13：server 寫入、web 快取、站內 AI 共用的「命中 → { id, title }」）", () => {
  it("命中只回 { id, title }（不帶 slug／groupId／ownerHandle）；未命中回 undefined", () => {
    expect(targetFromList({ kind: "g", groupId: GID.toLowerCase(), slug: "plan" }, CANDIDATES)).toEqual({
      id: "aaaaaaaa-0000-4000-8000-000000000002", title: "Group Note",
    });
    expect(targetFromList({ kind: "ref", ref: "AAAAAAAA-0000-4000-8000-000000000001" }, CANDIDATES)).toEqual({
      id: "aaaaaaaa-0000-4000-8000-000000000001", title: "Mine",
    });
    expect(targetFromList({ kind: "n", handle: "alice", slug: "plan" }, CANDIDATES)).toBeUndefined();
  });
});

/** 只認候選清單的同步解析（同 server 寫入路徑的用法）。 */
const resolveByList = (_href: string, parsed: { path: Parameters<typeof resolveFromList>[0] }) => targetFromList(parsed.path, CANDIDATES) ?? null;

describe("S2 convertSiteLinks（inline、巢狀、表格兩種 cell、樣式丟棄、未解析計數、不改寫輸入）", () => {
  const link = (href: string, ...content: unknown[]) => ({ type: "link", href, content });
  const t = (text: string, styles: Record<string, unknown> = {}) => ({ type: "text", text, styles });

  it("inline：可解 → wikilink（label 規則＋anchor）；外站與不可解原封不動並計 unresolved", () => {
    const blocks = [{ type: "paragraph", content: [
      t("see "),
      link("/n/alice/mine#b-h1", t("Mine")),
      t(" and "),
      link("https://other.example.com/x", t("ext")),
      t(" and "),
      link("/n/alice/missing", t("gone")),
    ], children: [] }];
    const before = JSON.stringify(blocks);
    const [out, stats] = convertSiteLinks(blocks, resolveByList, ORIGIN);
    expect(JSON.stringify(blocks)).toBe(before); // 不改寫輸入
    expect(stats).toEqual({ converted: 1, unresolved: 1 });
    const content = (out[0] as { content: unknown[] }).content;
    expect(content[1]).toEqual({ type: "wikilink", props: { targetNoteId: CANDIDATES[0]!.id, snapshotTitle: "Mine", label: "", anchorBlockId: "h1" } });
    expect(content[3]).toEqual(link("https://other.example.com/x", t("ext")));
    expect(content[5]).toEqual(link("/n/alice/missing", t("gone")));
  });

  it("RF3：多個樣式片段串成一個 label（樣式丟棄）；同 href 兩個連結各自轉、各自保留 label", () => {
    const blocks = [{ type: "paragraph", content: [
      link("/n/alice/mine", t("粗", { bold: true }), t("體")),
      t(" / "),
      link("/n/alice/mine", t("另一段")),
    ] }];
    const [out, stats] = convertSiteLinks(blocks, resolveByList, ORIGIN);
    expect(stats.converted).toBe(2);
    const content = (out[0] as { content: Array<{ type: string; props?: { label: string } }> }).content;
    expect(content.map((n) => n.type)).toEqual(["wikilink", "text", "wikilink"]);
    expect(content[0]!.props!.label).toBe("粗體");
    expect(content[2]!.props!.label).toBe("另一段");
  });

  it("巢狀 children 也轉；沒有站內連結的 block 維持同一個物件（copy-on-write）", () => {
    const untouched = { type: "paragraph", content: [t("plain")], children: [] };
    const blocks = [{ type: "bulletListItem", content: [t("a")], children: [
      untouched,
      { type: "paragraph", content: [link(`/g/${GID}/plan`, t("Group Note"))], children: [] },
    ] }];
    const [out] = convertSiteLinks(blocks, resolveByList, ORIGIN);
    const kids = (out[0] as { children: Array<{ content: Array<{ type: string }> }> }).children;
    expect(kids[0]).toBe(untouched);
    expect(kids[1]!.content[0]!.type).toBe("wikilink");
  });

  it("表格：cell 是陣列、cell 是 {type:tableCell, content} 兩種形都轉", () => {
    const blocks = [{ type: "table", content: { type: "tableContent", columnWidths: [null, null], rows: [
      { cells: [[link("/n/alice/mine", t("Mine"))], { type: "tableCell", props: {}, content: [link(`/notes/${CANDIDATES[1]!.id}`, t("G"))] }] },
    ] }, children: [] }];
    const [out, stats] = convertSiteLinks(blocks, resolveByList, ORIGIN);
    expect(stats.converted).toBe(2);
    const rows = (out[0] as { content: { rows: Array<{ cells: unknown[] }> } }).content.rows;
    expect((rows[0]!.cells[0] as Array<{ type: string }>)[0]!.type).toBe("wikilink");
    const cell = rows[0]!.cells[1] as { type: string; props: unknown; content: Array<{ type: string; props: { label: string } }> };
    expect(cell.type).toBe("tableCell");
    expect(cell.props).toEqual({});
    expect(cell.content[0]).toMatchObject({ type: "wikilink", props: { label: "G" } });
  });

  it("SL-COL1（並排 §11.11）：欄內段落的站內連結也轉成 wikilink", () => {
    const blocks = [{ type: "columnList", children: [
      { type: "column", props: { width: 1 }, children: [{ type: "paragraph", content: [link("/n/alice/mine", t("Mine"))], children: [] }] },
      { type: "column", props: { width: 1 }, children: [{ type: "paragraph", content: [t("plain")], children: [] }] },
    ] }];
    const [out, stats] = convertSiteLinks(blocks, resolveByList, ORIGIN);
    expect(stats).toEqual({ converted: 1, unresolved: 0 });
    const para = (out[0] as { children: Array<{ children: Array<{ content: unknown[] }> }> }).children[0]!.children[0]!;
    expect(para.content[0]).toEqual({ type: "wikilink", props: { targetNoteId: CANDIDATES[0]!.id, snapshotTitle: "Mine", label: "", anchorBlockId: "" } });
  });

  it("linkText：字串與 StyledText 陣列都收", () => {
    expect(linkText("abc")).toBe("abc");
    expect(linkText([t("a"), t("b", { bold: true })])).toBe("ab");
    expect(linkText(undefined)).toBe("");
  });
});

describe("mapInlineArrays（rebindWikilinks 與 convertSiteLinks 共用的走訪器）", () => {
  it("isInlineType 只管一般 block；表格格子一律走", () => {
    const seen: string[] = [];
    const blocks = [
      { type: "codeBlock", content: [{ type: "text", text: "code" }] },
      { type: "paragraph", content: [{ type: "text", text: "p" }] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: [[{ type: "text", text: "c" }]] }] } },
    ];
    mapInlineArrays(blocks, (inline) => {
      seen.push(String((inline[0] as { text: string }).text));
      return inline;
    }, (type) => type === "paragraph");
    expect(seen).toEqual(["p", "c"]);
  });
});

describe("wikilinksToLinks（MCP 讀與站內 AI 的匯出副本改寫）", () => {
  const wl = (props: Record<string, string>) => ({ type: "wikilink", props: { targetNoteId: NOTE_ID, snapshotTitle: "Snap", label: "", anchorBlockId: "", ...props } });
  it("label 優先；label 空取 titleOf；查不到取 snapshotTitle；錨點進 href；表格也改；輸入不變", () => {
    const blocks = [
      { type: "paragraph", content: [wl({ label: "L" }), wl({}), wl({ targetNoteId: "aaaaaaaa-0000-4000-8000-00000000000f" }), wl({ snapshotTitle: "", anchorBlockId: "b9" })] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: [[wl({})]] }] } },
    ];
    const before = JSON.stringify(blocks);
    const out = wikilinksToLinks(blocks, (id) => (id === NOTE_ID ? "Live" : undefined));
    expect(JSON.stringify(blocks)).toBe(before);
    const p = (out[0] as { content: unknown[] }).content;
    expect(p[0]).toEqual({ type: "link", href: `/notes/${NOTE_ID}`, content: [{ type: "text", text: "L", styles: {} }] });
    expect(p[1]).toEqual({ type: "link", href: `/notes/${NOTE_ID}`, content: [{ type: "text", text: "Live", styles: {} }] });
    expect(p[2]).toEqual({ type: "link", href: "/notes/aaaaaaaa-0000-4000-8000-00000000000f", content: [{ type: "text", text: "Snap", styles: {} }] });
    expect(p[3]).toEqual({ type: "link", href: `/notes/${NOTE_ID}#b-b9`, content: [{ type: "text", text: "Live", styles: {} }] });
    const cell = (out[1] as { content: { rows: Array<{ cells: unknown[][] }> } }).content.rows[0]!.cells[0]!;
    expect(cell[0]).toMatchObject({ type: "link", href: `/notes/${NOTE_ID}` });
  });

  // RF1（#269 Task 6）：BlockNote 的 markdown 匯出不跳脫文字，跳脫由 `escapeLinkText` 做——但只在真正變成 markdown 的那一步
  // （note-markdown-read.ts 的 markdown 分支）。`wikilinksToLinks` 本身**不跳脫**：它的輸出在讀路徑上也會走上色區塊的原始 HTML
  // 輸出，那裡跳脫會讓反斜線每往返一次多一層（審查 r0 I1）。`<`、`&` 刻意不收（見 escapeLinkText）。
  it("RF1：escapeLinkText 跳脫 \\ ` * _ [ ] ~、< 與 & 不動；wikilinksToLinks 段落與表格 cell 都輸出原文（不跳脫）", () => {
    expect(escapeLinkText("[Draft] Plan *v2*")).toBe("\\[Draft\\] Plan \\*v2\\*");
    expect(escapeLinkText("a]b\\")).toBe("a\\]b\\\\");
    expect(escapeLinkText("a_b_ `c` ~~s~~ x|y")).toBe("a\\_b\\_ \\`c\\` \\~\\~s\\~\\~ x|y");
    expect(escapeLinkText("C:\\path\\")).toBe("C:\\\\path\\\\");
    expect(escapeLinkText("![img] #h")).toBe("!\\[img\\] #h");
    expect(escapeLinkText("foo]bar")).toBe("foo\\]bar");
    expect(escapeLinkText("a <d> &amp; b")).toBe("a <d> &amp; b");
    const blocks = [
      { type: "paragraph", content: [wl({ label: "a]b\\" })] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: [[wl({})]] }] } },
    ];
    const out = wikilinksToLinks(blocks, () => "[Draft] Plan *v2*");
    expect((out[0] as { content: unknown[] }).content[0]).toEqual({ type: "link", href: `/notes/${NOTE_ID}`, content: [{ type: "text", text: "a]b\\", styles: {} }] });
    const cell = (out[1] as { content: { rows: Array<{ cells: unknown[][] }> } }).content.rows[0]!.cells[0]!;
    expect(cell[0]).toEqual({ type: "link", href: `/notes/${NOTE_ID}`, content: [{ type: "text", text: "[Draft] Plan *v2*", styles: {} }] });
  });
});
