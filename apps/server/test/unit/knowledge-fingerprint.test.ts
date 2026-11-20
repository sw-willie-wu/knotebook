/**
 * Documents written before headings carried knowledge props must keep every fingerprint (section, block, whole,
 * transfer, version) until someone actually writes knowledge data, otherwise stored `if_match` values and
 * pending bulk downloads would start failing after the upgrade.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { KNOWLEDGE_PROP_NAMES, YDOC_FRAGMENT, topLevelBlocks } from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession, forkFrom } from "../../src/notes/editing/session.js";
import { fingerprintOf, outlineOf, topLevelFingerprints } from "../../src/notes/editing/fingerprint.js";
import { prepareLinkConversion } from "../../src/notes/link-conversion.js";
import { versionFingerprint } from "../../src/notes/version-fingerprint.js";
import { sameCanonicalOf } from "../../src/transfer/same-canonical.js";
import type { ApplyDeps } from "../../src/notes/editing/apply.js";
import { buildPreUpgradeDoc, heading, paragraph, preUpgradeBlocks } from "../helpers/knowledge-docs.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();

interface Snap {
  headingAttrs: Record<string, string[]>;
  sections: Record<string, string>;
  whole: string;
  perBlock: Record<string, string>;
  version: string;
  same: Record<string, string>;
}

function measure(doc: Y.Doc): Snap {
  const frag = doc.getXmlFragment(YDOC_FRAGMENT);
  const { outline, whole } = outlineOf(frag);
  const tl = topLevelFingerprints(frag);
  const headingAttrs: Record<string, string[]> = {};
  const same: Record<string, string> = {};
  for (const c of topLevelBlocks(frag)) {
    const id = String(c.getAttribute("id"));
    const first = c.get(0);
    if (first instanceof Y.XmlElement && first.nodeName === "heading") headingAttrs[id] = Object.keys(first.getAttributes()).sort();
    same[id] = fingerprintOf(sameCanonicalOf(c));
  }
  return {
    headingAttrs,
    sections: Object.fromEntries(outline.map((o) => [o.sectionId, o.fingerprint])),
    whole,
    perBlock: Object.fromEntries(tl.ids.map((id, i) => [id, tl.fps[i]!])),
    version: versionFingerprint(frag),
    same,
  };
}

function diffSnap(base: Snap, now: Snap, skipIds: string[] = []) {
  const changed = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).filter((k) => !skipIds.includes(k) && a[k] !== b[k]);
  return {
    sectionsChanged: changed(base.sections, now.sections),
    perBlockChanged: changed(base.perBlock, now.perBlock),
    sameCanonChanged: changed(base.same, now.same),
    wholeChanged: base.whole !== now.whole,
    versionChanged: base.version !== now.version,
  };
}

function mergeDiff(base: Uint8Array, diff: Uint8Array): Y.Doc {
  const merged = new Y.Doc();
  Y.applyUpdate(merged, base);
  Y.applyUpdate(merged, diff);
  return merged;
}

const HEADING_IDS = ["hA", "hB", "hC", "hD", "hE"];

function headingElements(doc: Y.Doc): Y.XmlElement[] {
  const out: Y.XmlElement[] = [];
  for (const c of topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT))) {
    const first = c.get(0);
    if (first instanceof Y.XmlElement && first.nodeName === "heading") out.push(first);
  }
  return out;
}

describe("knowledge props do not change fingerprints of headings nobody touched", () => {
  it("opening a pre-upgrade document in an edit session without editing writes no heading attribute and changes no fingerprint", async () => {
    const old = buildPreUpgradeDoc(preUpgradeBlocks());
    const base = measure(old);
    const { fork, sv } = forkFrom(old);
    const s = await EditorSession.open(rt, fork);
    s.close();
    const diff = Y.encodeStateAsUpdate(fork, sv);
    const now = measure(mergeDiff(Y.encodeStateAsUpdate(old), diff));
    const d = diffSnap(base, now);
    expect(d.sectionsChanged).toEqual([]);
    expect(d.perBlockChanged).toEqual([]);
    expect(d.sameCanonChanged).toEqual([]);
    expect(d.wholeChanged).toBe(false);
    expect(d.versionChanged).toBe(false);
    for (const id of HEADING_IDS) expect(now.headingAttrs[id], id).toEqual(base.headingAttrs[id]);
  });

  it("an append leaves every earlier block's fingerprint and transfer canonical form unchanged", async () => {
    const old = buildPreUpgradeDoc(preUpgradeBlocks());
    const base = measure(old);
    const state = Y.encodeStateAsUpdate(old);
    const r = await rt.runDoc("u", { kind: "edit", state: new Uint8Array(state), op: "append", blocks: [{ type: "paragraph", content: "tail" }] as never });
    if (r === "too_complex" || !("ok" in r) || !r.ok) throw new Error(`edit ${JSON.stringify(r)}`);
    const now = measure(mergeDiff(state, r.post.diff));
    const newIds = Object.keys(now.perBlock).filter((id) => !(id in base.perBlock));
    expect(newIds).toHaveLength(1);
    const d = diffSnap(base, now, newIds);
    expect(d.perBlockChanged).toEqual([]);
    expect(d.sameCanonChanged).toEqual([]);
    // The level-2 heading hE belongs to hD's section, so the tail paragraph changes hD's section fingerprint and no earlier one.
    expect(d.sectionsChanged.filter((id) => id !== "hD")).toEqual([]);
    expect(d.versionChanged).toBe(true);
  });

  it("an if_match read before another section was rewritten is still accepted on the untouched section", async () => {
    const old = buildPreUpgradeDoc(preUpgradeBlocks());
    const state0 = Y.encodeStateAsUpdate(old);
    const o0 = await rt.runDoc("u", { kind: "outline", state: new Uint8Array(state0) });
    if (o0 === "too_complex") throw new Error("outline");
    const secA = o0.outline.find((x) => x.sectionId === "hA")!;
    const secB = o0.outline.find((x) => x.sectionId === "hB")!;
    const r1 = await rt.runDoc("u", {
      kind: "edit", state: new Uint8Array(state0), op: "replace_section", sectionId: "hA", ifMatch: secA.fingerprint,
      blocks: [heading("hA", 1, "A"), paragraph("a1", "one"), paragraph("a2", "two edited")] as never,
    });
    if (r1 === "too_complex" || !("ok" in r1) || !r1.ok) throw new Error(`edit1 ${JSON.stringify(r1)}`);
    const state1 = Y.encodeStateAsUpdate(mergeDiff(state0, r1.post.diff));
    const r2 = await rt.runDoc("u", {
      kind: "edit", state: new Uint8Array(state1), op: "replace_section", sectionId: "hB", ifMatch: secB.fingerprint,
      blocks: [heading("hB", 1, "B"), paragraph("b1", "three edited")] as never,
    });
    expect(r2 !== "too_complex" && "ok" in r2 && r2.ok === true, JSON.stringify(r2)).toBe(true);
  });

  it("a heading created under the new schema stores the seven knowledge attributes as empty strings", async () => {
    const doc = new Y.Doc();
    const s = await EditorSession.open(rt, doc);
    try {
      s.editor.replaceBlocks(s.editor.document, [heading("n1", 2, "new")] as never);
    } finally {
      s.close();
    }
    const [h] = headingElements(doc);
    const attrs = h!.getAttributes();
    for (const name of KNOWLEDGE_PROP_NAMES) expect(attrs[name], name).toBe("");
    expect(KNOWLEDGE_PROP_NAMES).toHaveLength(7);
  });

  it("replace_all with markdown that parses to the same content keeps every block id and every block fingerprint", async () => {
    // A coloured heading round-trips through markdown as raw HTML; isToggleable has no markdown form, so hC is not toggleable here.
    const plain = preUpgradeBlocks().map((b) => {
      const props = (b as { props?: { isToggleable?: boolean } }).props;
      return props?.isToggleable ? { ...(b as object), props: { ...props, isToggleable: false } } : b;
    });
    const old = buildPreUpgradeDoc(plain);
    const base = measure(old);
    const state = Y.encodeStateAsUpdate(old);
    const scratch = new Y.Doc();
    const s = await EditorSession.open(rt, scratch);
    let parsed: unknown[];
    try {
      parsed = s.editor.tryParseMarkdownToBlocks(["intro", "# A", "one", "two", '<h1 data-text-color="red">B</h1>', "three", "# C", "four", "# D", "five", "## E", "six"].join("\n\n")) as unknown[];
    } finally {
      s.close();
    }
    const o = await rt.runDoc("u", { kind: "outline", state: new Uint8Array(state) });
    if (o === "too_complex") throw new Error("outline");
    const r = await rt.runDoc("u", { kind: "edit", state: new Uint8Array(state), op: "replace_all", ifMatch: o.whole, blocks: parsed as never });
    if (r === "too_complex" || !("ok" in r) || !r.ok) throw new Error(`edit ${JSON.stringify(r)}`);
    const now = measure(mergeDiff(state, r.post.diff));
    const idsKept = Object.keys(base.perBlock).filter((id) => id in now.perBlock);
    expect(idsKept.sort()).toEqual(Object.keys(base.perBlock).sort());
    expect(idsKept.filter((id) => base.perBlock[id] !== now.perBlock[id])).toEqual([]);
    expect(idsKept.filter((id) => base.same[id] !== now.same[id])).toEqual([]);
  });

  it("empty knowledge attributes written into every heading change no section, block, transfer or version fingerprint", () => {
    const old = buildPreUpgradeDoc(preUpgradeBlocks());
    const base = measure(old);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(old));
    doc.transact(() => {
      for (const h of headingElements(doc)) for (const n of KNOWLEDGE_PROP_NAMES) h.setAttribute(n, "");
    });
    const now = measure(doc);
    expect(now.headingAttrs.hA).toEqual(expect.arrayContaining([...KNOWLEDGE_PROP_NAMES]));
    const d = diffSnap(base, now);
    expect(d.sectionsChanged).toEqual([]);
    expect(d.perBlockChanged).toEqual([]);
    expect(d.sameCanonChanged).toEqual([]);
    expect(d.wholeChanged).toBe(false);
    expect(d.versionChanged).toBe(false);
  });

  it("a non-empty knowledge attribute changes that heading's section, block and transfer fingerprints", () => {
    const old = buildPreUpgradeDoc(preUpgradeBlocks());
    const base = measure(old);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(old));
    doc.transact(() => {
      const hB = headingElements(doc).find((h) => (h.parent as Y.XmlElement).getAttribute("id") === "hB")!;
      hB.setAttribute("knowledgeWhen", "alice reads this");
    });
    const now = measure(doc);
    const d = diffSnap(base, now);
    expect(d.sectionsChanged).toEqual(["hB"]);
    expect(d.perBlockChanged).toEqual(["hB"]);
    expect(d.sameCanonChanged).toEqual(["hB"]);
    expect(d.wholeChanged).toBe(true);
    expect(d.versionChanged).toBe(true);
  });

  it("a link conversion that converts a link in one paragraph leaves every heading's fingerprint unchanged", async () => {
    const targetId = "11111111-1111-4111-8111-111111111111";
    const href = `/notes/${targetId}`;
    const blocks = preUpgradeBlocks().map((b) => ((b as { id: string }).id === "a1" ? { id: "a1", type: "paragraph", content: [{ type: "link", href, content: "to bob" }] } : b));
    const old = buildPreUpgradeDoc(blocks);
    const base = measure(old);
    const { fork, sv } = forkFrom(old);
    const resolved = new Map([[href, { id: targetId, title: "Bob" }]]);
    const prepared = await prepareLinkConversion({ editing: rt } as unknown as ApplyDeps, fork, sv, resolved, "http://localhost");
    expect(prepared.converted).toBe(1);
    const now = measure(mergeDiff(Y.encodeStateAsUpdate(old), prepared.diff));
    const d = diffSnap(base, now);
    expect(d.perBlockChanged).toEqual(["a1"]);
    expect(d.sameCanonChanged).toEqual(["a1"]);
    for (const id of HEADING_IDS) {
      expect(now.perBlock[id], id).toBe(base.perBlock[id]);
      expect(now.same[id], id).toBe(base.same[id]);
      expect(now.headingAttrs[id], id).toEqual(base.headingAttrs[id]);
    }
  });
});
