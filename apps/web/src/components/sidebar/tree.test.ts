import { beforeEach, describe, expect, it } from "vitest";
import type { GroupDto, NoteDto, NotePermissions } from "@knotebook/shared";
import i18n from "@/i18n";
import { adminRole, EDITOR_PERMS, groupDto, OWNER_PERMS, VIEWER_PERMS } from "@/test/fixtures";
import { buildTabNodes, noteBucket, noteLocationLabel, partitionNotes, recentNotes } from "./tree";

function note(id: string, over: Partial<NoteDto> = {}): NoteDto {
  return {
    id,
    title: `Note ${id}`,
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: `note-${id}`,
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "owner-one",
    lastEdited: null,
    group: null,
    groupId: null,
    permissions: OWNER_PERMS,
    ...over,
  };
}

const GROUP_A: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" }, adminRole());
const GROUP_B: GroupDto = groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Workshop B" }, adminRole());

function groupNote(
  id: string,
  group: { id: string; name: string },
  role: "editor" | "viewer",
  perms: NotePermissions = { ...OWNER_PERMS, manageShares: false, moveToGroup: false },
): NoteDto {
  return note(id, { ownerId: null, ownerHandle: null, role, groupId: group.id, group, permissions: perms });
}

const OWNER_NOTE = note("owner");
const SHARED_NOTE = note("shared", { ownerId: "u9", role: "editor", ownerHandle: "owner-nine", permissions: EDITOR_PERMS });
const VIEWER_SHARED_NOTE = note("shared-viewer", { ownerId: "u9", role: "viewer", ownerHandle: "owner-nine", permissions: VIEWER_PERMS });
const MY_GROUP_NOTE = groupNote("mine-in-a", GROUP_A, "editor");
const ORPHAN_GROUP_NOTE = groupNote("orphan", { id: "99999999-9999-9999-9999-999999999999", name: "Gone" }, "editor", { ...EDITOR_PERMS });

// ── TR1：歸類（#175 spec §8.2 四列）──純函式，每列一案。
describe("partitionNotes／noteBucket（#175 §8.2）", () => {
  it("第 1 列：群組筆記且群組在 groups → 該群組段（不進我的筆記／與我共享）", () => {
    const parts = partitionNotes([MY_GROUP_NOTE], [GROUP_A]);
    expect(parts.byGroup.get(GROUP_A.id)?.map((n) => n.id)).toEqual([MY_GROUP_NOTE.id]);
    expect(parts.myNotes).toEqual([]);
    expect(parts.shared).toEqual([]);
  });

  it("第 2 列：群組筆記但群組不在 groups → 與我共享（兜底）", () => {
    const parts = partitionNotes([ORPHAN_GROUP_NOTE], [GROUP_A]);
    expect(parts.shared.map((n) => n.id)).toEqual([ORPHAN_GROUP_NOTE.id]);
    expect(parts.myNotes).toEqual([]);
    expect(parts.byGroup.get(GROUP_A.id)).toEqual([]);
  });

  it("第 3 列：role === owner（個人筆記）→ 我的筆記", () => {
    const parts = partitionNotes([OWNER_NOTE], [GROUP_A]);
    expect(parts.myNotes.map((n) => n.id)).toEqual([OWNER_NOTE.id]);
    expect(parts.shared).toEqual([]);
  });

  it("第 4 列：其餘（逐人分享給我的個人筆記）→ 與我共享", () => {
    const parts = partitionNotes([SHARED_NOTE], [GROUP_A]);
    expect(parts.shared.map((n) => n.id)).toEqual([SHARED_NOTE.id]);
    expect(parts.myNotes).toEqual([]);
  });

  it("回傳物件的鍵只有 byGroup／myNotes／shared（沒有 recent）", () => {
    expect(Object.keys(partitionNotes([OWNER_NOTE], [GROUP_A])).sort()).toEqual(["byGroup", "myNotes", "shared"]);
  });

  it("noteBucket：四列各回對應的桶", () => {
    const ids = new Set([GROUP_A.id]);
    expect(noteBucket(MY_GROUP_NOTE, ids)).toEqual({ kind: "group", groupId: GROUP_A.id });
    expect(noteBucket(ORPHAN_GROUP_NOTE, ids)).toEqual({ kind: "shared" });
    expect(noteBucket(OWNER_NOTE, ids)).toEqual({ kind: "myNotes" });
    expect(noteBucket(SHARED_NOTE, ids)).toEqual({ kind: "shared" });
  });
});

// ── TR2：最近
describe("recentNotes", () => {
  it("依 lastEdited.at ?? updatedAt 新到舊交錯排序", () => {
    const a = note("A", { updatedAt: "2026-10-01T00:00:00.000Z", lastEdited: { at: "2026-10-05T00:00:00.000Z", byHandle: "x", agentLabel: null } });
    const b = note("B", { updatedAt: "2026-10-07T00:00:00.000Z", lastEdited: null });
    const c = note("C", { updatedAt: "2026-10-01T00:00:00.000Z", lastEdited: { at: "2026-10-06T00:00:00.000Z", byHandle: "x", agentLabel: null } });
    expect(recentNotes([a, b, c]).map((n) => n.id)).toEqual(["B", "C", "A"]);
  });

  it("同 key 保持輸入順序；無法解析的時間排最後", () => {
    const same = "2026-10-05T00:00:00.000Z";
    const bad = note("bad", { updatedAt: "2026-12-01T00:00:00.000Z", lastEdited: { at: "not-a-date", byHandle: "x", agentLabel: null } });
    const p = note("p", { updatedAt: same });
    const q = note("q", { updatedAt: same });
    const r = note("r", { updatedAt: same });
    expect(recentNotes([bad, q, p, r]).map((n) => n.id)).toEqual(["q", "p", "r", "bad"]);
  });

  it("25 篇 → 20 篇且是 key 最大的 20 篇；輸入陣列不被就地排序", () => {
    const notes = Array.from({ length: 25 }, (_, i) =>
      note(`n${String(i).padStart(2, "0")}`, { updatedAt: new Date(Date.UTC(2026, 0, 1 + ((i * 7) % 25))).toISOString() }),
    );
    const before = [...notes];
    const out = recentNotes(notes);
    expect(out).toHaveLength(20);
    expect(notes).toEqual(before);
    const top = [...notes].sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt)).slice(0, 20);
    expect(out.map((n) => n.id)).toEqual(top.map((n) => n.id));
  });
});

// ── TR3：節點樹
describe("buildTabNodes", () => {
  const notes = [OWNER_NOTE, SHARED_NOTE, MY_GROUP_NOTE, ORPHAN_GROUP_NOTE];
  const groups = [GROUP_A, GROUP_B];

  it("recent／myNotes／shared 各回對應筆記的 note 節點", () => {
    const old = note("old", { updatedAt: "2026-01-01T00:00:00.000Z" });
    const fresh = note("fresh", { updatedAt: "2026-02-01T00:00:00.000Z" });
    expect(buildTabNodes("recent", [old, fresh], groups)).toMatchObject([
      { kind: "note", id: "fresh" },
      { kind: "note", id: "old" },
    ]);
    expect(buildTabNodes("myNotes", notes, groups)).toMatchObject([{ kind: "note", id: OWNER_NOTE.id }]);
    expect(buildTabNodes("shared", notes, groups)).toMatchObject([
      { kind: "note", id: SHARED_NOTE.id },
      { kind: "note", id: ORPHAN_GROUP_NOTE.id },
    ]);
  });

  it("workspace：group 節點順序同 groups，空群組 children 為 []", () => {
    const nodes = buildTabNodes("workspace", notes, groups);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ kind: "group", id: GROUP_A.id, children: [{ kind: "note", id: MY_GROUP_NOTE.id }] });
    expect(nodes[1]).toMatchObject({ kind: "group", id: GROUP_B.id, children: [] });
  });

  it("孤兒群組筆記只出現在 shared", () => {
    const where = (tab: "recent" | "myNotes" | "shared" | "workspace") =>
      JSON.stringify(buildTabNodes(tab, [ORPHAN_GROUP_NOTE], groups)).includes(ORPHAN_GROUP_NOTE.id);
    expect(where("shared")).toBe(true);
    expect(where("myNotes")).toBe(false);
    expect(where("workspace")).toBe(false);
  });
});

// ── TR4：位置標籤
describe("noteLocationLabel", () => {
  const ids = new Set([GROUP_A.id]);
  const label = (n: NoteDto) => noteLocationLabel(n, ids, (k, o) => i18n.t(k, o));

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("en：個人／群組／共享（editor、viewer）／孤兒群組", () => {
    expect(label(OWNER_NOTE)).toBe("My notes");
    expect(label(MY_GROUP_NOTE)).toBe("Workspace › Workshop A");
    expect(label(SHARED_NOTE)).toBe("Shared with me · Editor");
    expect(label(VIEWER_SHARED_NOTE)).toBe("Shared with me · Viewer");
    expect(label(ORPHAN_GROUP_NOTE)).toBe("Shared with me · Editor");
  });

  it("zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      expect(label(MY_GROUP_NOTE)).toBe("工作坊 › Workshop A");
      expect(label(SHARED_NOTE)).toBe("與我共享 · 可編輯");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
