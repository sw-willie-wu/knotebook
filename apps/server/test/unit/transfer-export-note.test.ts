import { stat } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { fingerprintForIds, topLevelFingerprints } from "../../src/notes/editing/fingerprint.js";
import { readNoteContentFromDoc } from "../../src/notes/editing/read.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { exportNoteForTransfer } from "../../src/transfer/export-note.js";
import { SHAPE_LINK_TARGET, SHAPE_TITLES, TRANSFER_SHAPES, type ShapeBlock } from "./fixtures/transfer-shapes.js";

/** bulk transfer spec §6.4-1、-5、-6、§6.6-4；plan T6（X1–X9）。 */

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
async function docWith(blocks: ShapeBlock[]): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, blocks as never);
  } finally {
    s.close();
  }
  return doc;
}
const frag = (doc: Y.Doc) => doc.getXmlFragment(YDOC_FRAGMENT);
const paras = (n: number): ShapeBlock[] => Array.from({ length: n }, (_, i) => ({ type: "paragraph", content: `p${i}` }));
const byName = (name: string) => {
  const s = TRANSFER_SHAPES.find(x => x.name === name);
  if (!s) throw new Error(`no shape ${name}`);
  return s;
};

describe("exportNoteForTransfer：129 形", () => {
  it("fixture 是 129 形（66＋35＋28）", () => {
    expect(TRANSFER_SHAPES).toHaveLength(129);
    expect(TRANSFER_SHAPES.filter(s => s.group === "66")).toHaveLength(66);
    expect(TRANSFER_SHAPES.filter(s => s.group === "35")).toHaveLength(35);
    expect(TRANSFER_SHAPES.filter(s => s.group === "spike")).toHaveLength(28);
  });

  it.each(TRANSFER_SHAPES.map(s => [`[${s.group}] ${s.name}`, s] as const))(
    "X1／X2／X3／X5 %s：段表與統計逐形等於 spike、本文＝MCP 讀出、指紋＝逐 id、一次 mount",
    async (_label, shape) => {
      const doc = await docWith(shape.blocks);
      const m0 = rt.mounts;
      const ex = await exportNoteForTransfer(rt, doc, SHAPE_TITLES);
      expect(rt.mounts - m0, "一篇只 mount 一次（含群組匯出）").toBe(1);
      expect(rt.inFlight).toBe(0);
      // X1
      expect(ex.segments).not.toBeNull();
      expect(ex.segments!.map(s => s.ids.map(id => ex.ids.indexOf(id)))).toEqual(shape.segs);
      expect(ex.stats.groupCalls).toBe(shape.groupCalls);
      expect(ex.stats.groupUsedWhilePerMatched).toBe(shape.groupUsedWhilePerMatched);
      for (const s of ex.segments!) expect(s.fps).toEqual(s.ids.map(id => ex.fps[ex.ids.indexOf(id)]));
      // X2：逐位元組等於 MCP 讀出
      const mcp = await readNoteContentFromDoc(rt, doc, undefined, SHAPE_TITLES);
      if (typeof mcp === "string" || !("markdown" in mcp)) throw new Error("unexpected read shape");
      expect(ex.body).toBe(mcp.markdown);
      // X3：一次走完的指紋＝逐 id 的 fingerprintForIds
      expect(ex.fps).toEqual(ex.ids.map(id => fingerprintForIds(frag(doc), [id])));
      expect(ex.ids).toEqual(topLevelContainers(frag(doc)).map(c => c.getAttribute("id")));
    },
  );

  it("X2b wikilink 目標看不到（titles 空）時本文仍＝MCP 讀出，而且與看得到時不同", async () => {
    const doc = await docWith(byName("wikilink in para + bullet").blocks);
    const hidden = await exportNoteForTransfer(rt, doc, new Map());
    const mcp = await readNoteContentFromDoc(rt, doc, undefined, new Map());
    if (typeof mcp === "string" || !("markdown" in mcp)) throw new Error("unexpected read shape");
    expect(hidden.body).toBe(mcp.markdown);
    const shown = await exportNoteForTransfer(rt, doc, SHAPE_TITLES);
    expect(shown.body).not.toBe(hidden.body);
    expect(shown.body).toContain("Other note");
    expect(SHAPE_TITLES.has(SHAPE_LINK_TARGET)).toBe(true);
  });
});

describe("exportNoteForTransfer：其他", () => {
  it("零顆文件：本文空字串、零段、不 mount", async () => {
    const doc = new Y.Doc();
    const m0 = rt.mounts;
    const ex = await exportNoteForTransfer(rt, doc, new Map());
    expect(rt.mounts - m0).toBe(0);
    expect(ex).toMatchObject({ body: "", lines: [], ids: [], fps: [], types: [], segments: [], lineKinds: [] });
  });

  it("X4 2 000 顆段落：topLevelFingerprints < 500 ms，結果＝逐 id", async () => {
    const doc = await docWith(paras(2000));
    const t0 = performance.now();
    const { ids, fps } = topLevelFingerprints(frag(doc));
    const ms = performance.now() - t0;
    expect(ids).toHaveLength(2000);
    expect(ms).toBeLessThan(500);
    for (const k of [0, 999, 1999]) expect(fps[k]).toBe(fingerprintForIds(frag(doc), [ids[k]!]));
  }, 120_000);

  it("topLevelFingerprints：頂層 block 缺 id → 丟錯（同 outlineOf）", async () => {
    const doc = await docWith(paras(2));
    topLevelContainers(frag(doc))[1]!.removeAttribute("id");
    expect(() => topLevelFingerprints(frag(doc))).toThrow(/缺 id/);
  });

  it("mount 前後頂層 id 不一致 → 降級：本文照出（＝MCP 讀出）、segments null、lineKinds 全 0、lease 已還（重複 id 的文件：mount 時 BlockNote 會改掉重複的 id）", async () => {
    const doc = await docWith(paras(3));
    const cs = topLevelContainers(frag(doc));
    cs[1]!.setAttribute("id", cs[0]!.getAttribute("id")!);
    expect(topLevelFingerprints(frag(doc)).ids[0]).toBe(topLevelFingerprints(frag(doc)).ids[1]);
    const m0 = rt.mounts;
    const ex = await exportNoteForTransfer(rt, doc, new Map());
    expect(rt.mounts - m0).toBe(1);
    expect(rt.inFlight).toBe(0);
    expect(ex.segments).toBeNull();
    expect(ex.lines).toEqual(["p0", "", "p1", "", "p2"]);
    expect(ex.lineKinds).toEqual([0, 0, 0, 0, 0]);
    const mcp = await readNoteContentFromDoc(rt, doc, undefined, new Map());
    if (typeof mcp === "string" || !("markdown" in mcp)) throw new Error("unexpected read shape");
    expect(ex.body).toBe(mcp.markdown);
  });

  it("X6 一篇之內讓出（計數）：mount 後、整篇匯出後各 1 次＋120 顆每 50 顆 2 次＝4 次；讓出時仍持 lease（inFlight 1）；結束後歸零", async () => {
    const doc = await docWith(paras(120));
    const seen: number[] = [];
    const ex = await exportNoteForTransfer(rt, doc, new Map(), {
      yieldEveryBlocks: 50,
      yieldAfterMs: Infinity,
      yieldFn: async () => {
        seen.push(rt.inFlight);
      },
    });
    expect(ex.stats.yields).toBe(4);
    expect(seen).toEqual([1, 1, 1, 1]);
    expect(rt.inFlight).toBe(0);
    expect(ex.segments).toHaveLength(120);
  }, 60_000);

  it("X6b 一篇之內讓出（時間）：yieldAfterMs 0 → 每顆都讓出（另加 mount 後、整篇匯出後各 1 次）", async () => {
    const doc = await docWith(paras(120));
    let n = 0;
    const ex = await exportNoteForTransfer(rt, doc, new Map(), { yieldEveryBlocks: Infinity, yieldAfterMs: 0, yieldFn: async () => void n++ });
    expect(ex.stats.yields).toBeGreaterThanOrEqual(122);
    expect(n).toBe(ex.stats.yields);
  }, 60_000);

  it("預設讓出函式是 setImmediate（真的讓出事件迴圈）；60 顆＝mount 後＋整篇後＋第 50 顆＝3 次", async () => {
    const doc = await docWith(paras(60));
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    const before = ticked;
    const ex = await exportNoteForTransfer(rt, doc, new Map(), { yieldEveryBlocks: 50, yieldAfterMs: Infinity });
    expect(before).toBe(false);
    expect(ex.stats.yields).toBe(3);
    expect(ticked).toBe(true);
  }, 60_000);

  it("X7 forceUnmergeable → segments null、lineKinds 全 0、本文照常", async () => {
    const doc = await docWith(byName("numbered start 5").blocks);
    const normal = await exportNoteForTransfer(rt, doc, new Map());
    const forced = await exportNoteForTransfer(rt, doc, new Map(), { forceUnmergeable: true });
    expect(forced.segments).toBeNull();
    expect(forced.lineKinds).toEqual(forced.lines.map(() => 0));
    expect(forced.body).toBe(normal.body);
    expect(normal.lineKinds.some(k => k === 1)).toBe(true);
  });

  it("X8 numbered 段的行 lineKinds 為 1、其餘 0（numbered start 5、12 項、numbered／para／numbered）", async () => {
    for (const name of ["numbered start 5", "numbered 12 items w/ child on 10"]) {
      const ex = await exportNoteForTransfer(rt, await docWith(byName(name).blocks), new Map());
      expect(ex.lines.length, name).toBeGreaterThan(0);
      expect(ex.lineKinds, name).toEqual(ex.lines.map(() => 1));
    }
    const ex = await exportNoteForTransfer(rt, await docWith(byName("numbered, para, numbered").blocks), new Map());
    const want = new Array<number>(ex.lines.length).fill(0);
    for (const s of ex.segments!) {
      const t = ex.types[ex.ids.indexOf(s.ids[0]!)];
      for (let k = s.start; k < s.start + s.count; k++) want[k] = t === "numberedListItem" ? 1 : 0;
    }
    expect(ex.lineKinds).toEqual(want);
    expect(want).toContain(0);
    expect(want).toContain(1);
  });

  it("X9 k26（行內色＋表格，佔位符位數）對齊：表格那顆自成一段", async () => {
    const shape = TRANSFER_SHAPES.find(s => s.name.startsWith("k26 "))!;
    const ex = await exportNoteForTransfer(rt, await docWith(shape.blocks), new Map());
    expect(ex.segments).not.toBeNull();
    expect(ex.segments!.map(s => s.ids.length)).toEqual(shape.segs.map(s => s.length));
  });

  it("lines／types／ids 一致：lines＝bodyLines(normalizeBody(body))、types 照頂層", async () => {
    const ex = await exportNoteForTransfer(rt, await docWith(byName("heading->bullet->heading").blocks), new Map());
    expect(ex.types).toEqual(["heading", "bulletListItem", "heading"]);
    expect(ex.lines).toEqual(ex.body.replace(/\n+$/, "").split("\n"));
  });
});

/** 接著在 poll 階段（I/O 回呼裡 resolve 的 microtask）跑——生產上 mount 前一步是 `linkTitlesFor` 的 DB 查詢，同此。 */
const fromIoCallback = () => new Promise<void>(r => stat(".", () => r()));
const busy = (ms: number) => {
  const t = performance.now();
  while (performance.now() - t < ms) {
    /* 讓 timer 到期／讓 I/O 抵達 */
  }
};
/** 第一次查 titles＝整篇匯出開始的那一刻（wikilink 無 label → `titles.get`）。 */
function probeTitles(onFirstGet: () => void): ReadonlyMap<string, string> {
  let first = true;
  return new (class extends Map<string, string> {
    override get(k: string) {
      if (first) {
        first = false;
        onFirstGet();
      }
      return super.get(k);
    }
  })(SHAPE_TITLES);
}

describe("預設讓出真的跨過 timers＋poll（m3 的兩次 setImmediate）", () => {
  it("Y1 從 I/O 回呼接著跑：mount 後第一次讓出期間，事先到期的 setTimeout(0) 先跑（在整篇匯出之前）", async () => {
    const doc = await docWith(byName("wikilink in para + bullet").blocks);
    let fired = false;
    let firedBeforeFull: boolean | undefined;
    const titles = probeTitles(() => {
      firedBeforeFull = fired;
    });
    await fromIoCallback();
    setTimeout(() => {
      fired = true;
    }, 0);
    busy(5);
    await exportNoteForTransfer(rt, doc, titles, { yieldEveryBlocks: Infinity, yieldAfterMs: Infinity });
    expect(firedBeforeFull).toBe(true);
  }, 60_000);

  it("Y2 從 I/O 回呼接著跑：mount 後第一次讓出期間，已抵達的 socket 資料先處理（在整篇匯出之前）", async () => {
    const doc = await docWith(byName("wikilink in para + bullet").blocks);
    let peer: Socket | undefined;
    const srv = createServer(s => {
      peer = s;
    });
    await new Promise<void>(r => srv.listen(0, "127.0.0.1", () => r()));
    const cli = connect((srv.address() as { port: number }).port, "127.0.0.1");
    try {
      await new Promise<void>(r => cli.once("connect", () => r()));
      while (peer === undefined) await new Promise(r => setTimeout(r, 1));
      let got = false;
      let gotBeforeFull: boolean | undefined;
      peer.on("data", () => {
        got = true;
      });
      const titles = probeTitles(() => {
        gotBeforeFull = got;
      });
      await fromIoCallback();
      cli.write("x");
      busy(20);
      await exportNoteForTransfer(rt, doc, titles, { yieldEveryBlocks: Infinity, yieldAfterMs: Infinity });
      expect(gotBeforeFull).toBe(true);
    } finally {
      cli.destroy();
      peer?.destroy();
      srv.close();
    }
  }, 60_000);
});
