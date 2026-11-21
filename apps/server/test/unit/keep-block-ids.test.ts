/**
 * #551: `replace_section` / `replace_all` through the real edit job keep the ids of blocks that line up with an old block; version apply (no `keepIds`) does not.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession, forkFrom } from "../../src/notes/editing/session.js";
import { editOnFork, type EditDocResult } from "../../src/notes/editing/doc-jobs.js";
import { allBlockIds, topIds } from "./fixtures/block-ids.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();

const H = (id: string, t: string) => ({ id, type: "heading", props: { level: 1 }, content: t });
const P = (id: string, t: string) => ({ id, type: "paragraph", content: t });
const NH = (t: string) => ({ type: "heading", props: { level: 1 }, content: t });
const NP = (t: string) => ({ type: "paragraph", content: t });
const NB = (t: string, children: unknown[] = []) => ({ type: "bulletListItem", content: t, children });

async function build(blocks: unknown[]): Promise<Uint8Array> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, blocks as never);
  } finally {
    s.close();
  }
  return Y.encodeStateAsUpdate(doc);
}

const base = () => [H("hA", "A"), P("p1", "one"), P("p2", "two"), P("p3", "three"), H("hB", "B"), P("p4", "four")];

type EditOk = Extract<EditDocResult, { ok: true }>;

async function edit(state: Uint8Array, op: "replace_section" | "replace_all", heading: string | null, blocks: unknown[]) {
  const o = await rt.runDoc("u", { kind: "outline", state });
  if (o === "too_complex") throw new Error("outline");
  const sec = heading === null ? undefined : o.outline.find(x => x.heading === heading)!;
  const r = await rt.runDoc("u", {
    kind: "edit", noteId: "00000000-0000-4000-8000-000000000000",
    state: new Uint8Array(state),
    op,
    ...(sec ? { sectionId: sec.sectionId, ifMatch: sec.fingerprint } : { ifMatch: o.whole }),
    blocks: blocks as never,
  });
  if (r === "too_complex" || !("ok" in r) || !r.ok) throw new Error("edit " + JSON.stringify(r));
  const merged = new Y.Doc();
  Y.applyUpdate(merged, state);
  Y.applyUpdate(merged, r.post.diff);
  return { r: r as EditOk, merged };
}

const unique = (ids: string[]) => expect(new Set(ids).size).toBe(ids.length);

describe("edit ops keep block ids (#551)", () => {
  it("replace_section: the heading, unchanged paragraphs and the one edited paragraph keep their ids; afterIds and the reply outline use them", async () => {
    const st = await build(base());
    const { r, merged } = await edit(st, "replace_section", "A", [NH("A"), NP("one"), NP("two changed"), NP("three")]);
    expect(r.afterIds).toEqual(["hA", "p1", "p2", "p3"]);
    expect(topIds(merged)).toEqual(["hA", "p1", "p2", "p3", "hB", "p4"]);
    expect(r.post.outline[1]!.sectionId).toBe("hA");
    unique(allBlockIds(merged));
  });

  it("replace_section: a split paragraph and a type change get new ids; ids stay unique", async () => {
    const st = await build(base());
    const { r, merged } = await edit(st, "replace_section", "A", [NH("A"), NB("one"), NP("tw"), NP("o"), NP("three")]);
    const ids = topIds(merged);
    expect(ids[0]).toBe("hA");
    expect(ids[4]).toBe("p3");
    for (const id of ids.slice(1, 4)) expect(["p1", "p2", "p3", "hB", "p4"]).not.toContain(id);
    expect(r.afterIds).toEqual(ids.slice(0, 5));
    unique(allBlockIds(merged));
  });

  it("replace_all keeps unchanged blocks and a single edited block between them", async () => {
    const st = await build(base());
    const { merged } = await edit(st, "replace_all", null, [NH("A"), NP("one"), NP("two"), NP("three"), NH("B"), NP("four changed")]);
    expect(topIds(merged)).toEqual(["hA", "p1", "p2", "p3", "hB", "p4"]);
    unique(allBlockIds(merged));
  });

  it("nested: a list item whose child changed keeps its own id, the child gets a new one; an identical list item keeps its child's id", async () => {
    const st = await build([
      { id: "li", type: "bulletListItem", content: "item", children: [{ id: "ch", type: "bulletListItem", content: "child" }] },
      { id: "ls", type: "bulletListItem", content: "same", children: [{ id: "lk", type: "bulletListItem", content: "kid" }] },
    ]);
    const { merged } = await edit(st, "replace_all", null, [NB("item", [NB("child2")]), NB("same", [NB("kid")])]);
    const all = allBlockIds(merged);
    expect(all).toContain("li");
    expect(all).toContain("ls");
    expect(all).toContain("lk");
    expect(all).not.toContain("ch");
    expect(all).toHaveLength(4);
    unique(all);
  });

  it("a column list in the section survives a rewrite that changes another paragraph: the column list, its columns and their paragraphs keep their ids", async () => {
    const cols = (ids: boolean) => ({
      ...(ids ? { id: "cl" } : {}),
      type: "columnList",
      children: [
        { ...(ids ? { id: "c1" } : {}), type: "column", children: [{ ...(ids ? { id: "x1" } : {}), type: "paragraph", content: "x" }] },
        { ...(ids ? { id: "c2" } : {}), type: "column", children: [{ ...(ids ? { id: "y1" } : {}), type: "paragraph", content: "y" }] },
      ],
    });
    const st = await build([H("hA", "A"), cols(true), P("p2", "two"), H("hB", "B"), P("p4", "four")]);
    const { merged } = await edit(st, "replace_section", "A", [NH("A"), cols(false), NP("two changed")]);
    expect(allBlockIds(merged)).toEqual(["hA", "cl", "c1", "x1", "c2", "y1", "p2", "hB", "p4"]);
  });

  it("replace_all on a vacuum doc reuses no id", async () => {
    const st = Y.encodeStateAsUpdate(new Y.Doc());
    const { r, merged } = await edit(st, "replace_all", null, [NP("hello")]);
    expect(r.afterIds[0]).not.toBe("initialBlockId");
    expect(r.afterIds).toEqual(topIds(merged));
    unique(allBlockIds(merged));
  });

  it("revert of an id-keeping replace_section restores the old content, kept ids appear once, no duplicate ids", async () => {
    const st = await build(base());
    const { r, merged } = await edit(st, "replace_section", "A", [NH("A"), NP("one"), NP("two changed"), NP("three")]);
    const rr = await rt.runDoc("u", {
      kind: "revert",
      state: Y.encodeStateAsUpdate(merged),
      othersShareAnchor: false,
      row: { op: "replace_section", afterBlockIds: r.afterIds, afterFingerprint: r.post.afterFingerprint, beforeBlocks: r.beforeBlocks, anchor: r.anchor },
    } as never);
    if (rr === "too_complex" || !("ok" in rr) || !rr.ok) throw new Error("revert " + JSON.stringify(rr));
    const after = new Y.Doc();
    Y.applyUpdate(after, Y.encodeStateAsUpdate(merged));
    Y.applyUpdate(after, rr.post.diff);
    const read = async (d: Y.Doc) => {
      const m = await rt.runDoc("u", { kind: "read", state: Y.encodeStateAsUpdate(d), wantShown: false });
      if (m === "too_complex" || typeof m.result === "string" || !("markdown" in m.result)) throw new Error("read");
      return m.result.markdown;
    };
    const original = new Y.Doc();
    Y.applyUpdate(original, st);
    expect(await read(after)).toBe(await read(original));
    const ids = allBlockIds(after);
    unique(ids);
    for (const id of ["hA", "p1", "p2", "p3"]) expect(ids.filter(x => x === id)).toHaveLength(1);
  });

  const revertTwice = async (op: "replace_section" | "file_sync", blocks: unknown[]) => {
    const st = await build(base());
    const { r, merged } = await edit(st, "replace_section", "A", blocks);
    const row = { op, afterBlockIds: r.afterIds, afterFingerprint: r.post.afterFingerprint, beforeBlocks: r.beforeBlocks, anchor: r.anchor };
    const revert = async (state: Y.Doc) => {
      const rr = await rt.runDoc("u", { kind: "revert", state: Y.encodeStateAsUpdate(state), othersShareAnchor: false, row } as never);
      if (rr === "too_complex" || !("ok" in rr)) throw new Error("revert");
      if (!rr.ok) return { ok: false as const, code: rr.code, doc: state };
      const next = new Y.Doc();
      Y.applyUpdate(next, Y.encodeStateAsUpdate(state));
      Y.applyUpdate(next, rr.post.diff);
      return { ok: true as const, code: "", doc: next };
    };
    const first = await revert(merged);
    const second = await revert(first.doc);
    return { first, second, afterIds: r.afterIds };
  };

  it("a rewrite that only deletes paragraphs: reverting a second time (the record step failed) is stale and adds no duplicate", async () => {
    const { first, second, afterIds } = await revertTwice("replace_section", [NH("A"), NP("one")]);
    expect(afterIds).toEqual(["hA", "p1"]);
    expect(first.ok).toBe(true);
    expect(topIds(first.doc)).toEqual(["hA", "p1", "p2", "p3", "hB", "p4"]);
    expect(second).toMatchObject({ ok: false, code: "stale" });
    unique(allBlockIds(second.doc));
  });

  it("a file_sync rewrite region that only deletes paragraphs is stale after its revert", async () => {
    const { first, second } = await revertTwice("file_sync", [NH("A"), NP("one")]);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: "stale" });
    unique(allBlockIds(second.doc));
  });

  it("a rewrite that changed text reverts once and is then stale", async () => {
    const { first, second } = await revertTwice("replace_section", [NH("A"), NP("one"), NP("two changed"), NP("three")]);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: "stale" });
  });

  it("version apply (editOnFork without keepIds) still gives every replaced block a new id", async () => {
    const st = await build(base());
    const { fork, sv } = forkFrom(st);
    const r = await editOnFork(rt, fork, sv, { op: "replace_all", isEmptyDoc: false, section: undefined }, [NH("A"), NP("one"), NP("two"), NP("three"), NH("B"), NP("four")] as never);
    const old = ["hA", "p1", "p2", "p3", "hB", "p4"];
    expect(r.afterIds).toHaveLength(6);
    for (const id of r.afterIds) expect(old).not.toContain(id);
  });
});
