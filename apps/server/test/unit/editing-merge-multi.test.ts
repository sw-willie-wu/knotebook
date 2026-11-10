import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { checkExpectations, fingerprintForIds, fingerprintsOfGroups, topLevelSnapshot } from "../../src/notes/editing/fingerprint.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { docWith, withEditor } from "./fixtures/transfer-sync.js";

/** bulk transfer plan PR-2 §0.1-5、T7（MD1–MD6）：`mergeDiff` 多期望分支的純函式（直接吃 fragment，不經 `mergeDiff`，gate r1 m7）。 */

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const P = (t: string) => ({ type: "paragraph", content: t });
const frag = (d: Y.Doc) => d.getXmlFragment(YDOC_FRAGMENT);
const expectAll = (d: Y.Doc, ids: string[]) => {
  const s = topLevelSnapshot(frag(d));
  return ids.map(id => ({ id, fp: s.fps[s.ids.indexOf(id)]! }));
};

describe("MD1–MD4", () => {
  it("MD1 期望全符 → 通過；fingerprintsOfGroups 每組＝fingerprintForIds、空組 → null", async () => {
    const d = await docWith(rt, [P("a"), P("b"), P("c"), P("d")]);
    const ids = topLevelSnapshot(frag(d)).ids;
    expect(checkExpectations(frag(d), expectAll(d, [ids[1]!, ids[2]!]), [ids[0]!])).toBe(true);
    expect(fingerprintsOfGroups(frag(d), [[ids[0]!, ids[1]!], [ids[3]!], []])).toEqual([fingerprintForIds(frag(d), [ids[0]!, ids[1]!]), fingerprintForIds(frag(d), [ids[3]!]), null]);
    expect(fingerprintsOfGroups(frag(d), [[ids[1]!, ids[0]!], ["nope"]])).toEqual([null, null]); // 順序不符／不在頂層 → null
  });
  it("MD2 第二個倖存者被改 → 不符", async () => {
    const d = await docWith(rt, [P("a"), P("b"), P("c")]);
    const ids = topLevelSnapshot(frag(d)).ids;
    const exp = expectAll(d, [ids[0]!, ids[1]!]);
    await withEditor(rt, d, ed => ed.updateBlock(ids[1]!, { content: "B!" }));
    expect(checkExpectations(frag(d), exp, [])).toBe(false);
  });
  it("MD3 錨點被刪 → 不符", async () => {
    const d = await docWith(rt, [P("a"), P("b"), P("c")]);
    const ids = topLevelSnapshot(frag(d)).ids;
    const exp = expectAll(d, [ids[1]!]);
    await withEditor(rt, d, ed => ed.removeBlocks([ids[2]!]));
    expect(checkExpectations(frag(d), exp, [ids[0]!])).toBe(true);
    expect(checkExpectations(frag(d), exp, [ids[2]!])).toBe(false);
  });
  it("MD4 倖存者被拖亂順序 → 仍通過（逐顆比指紋、不比順序，§0.2 R9）", async () => {
    const d = await docWith(rt, [P("a"), P("b"), P("c")]);
    const ids = topLevelSnapshot(frag(d)).ids;
    const exp = expectAll(d, [ids[0]!, ids[1]!, ids[2]!]);
    await withEditor(rt, d, ed => {
      const c = ed.getBlock(ids[2]!)!;
      ed.removeBlocks([ids[2]!]);
      ed.insertBlocks([c], ids[0]!, "before");
    });
    expect(topLevelSnapshot(frag(d)).ids).toEqual([ids[2], ids[0], ids[1]]);
    expect(checkExpectations(frag(d), exp, [])).toBe(true);
  });
});

describe("MD6 效能", () => {
  it("2 000 顆倖存者 checkExpectations < 500 ms", async () => {
    const d = await docWith(rt, Array.from({ length: 2000 }, (_, i) => P(`p${i}`)));
    const ids = topLevelSnapshot(frag(d)).ids;
    const exp = expectAll(d, ids);
    const t0 = performance.now();
    expect(checkExpectations(frag(d), exp, [ids[0]!])).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500);
    const t1 = performance.now();
    expect(fingerprintsOfGroups(frag(d), [ids])[0]).not.toBeNull();
    expect(performance.now() - t1).toBeLessThan(500);
  }, 60_000);
});
