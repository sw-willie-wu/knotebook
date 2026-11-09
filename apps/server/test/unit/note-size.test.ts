/**
 * 筆記大小上限（`notes/note-size.ts`）：依結果判斷的規則（`capBlocks`＋`measureTrial` 的四個數；API／MCP／批次寫回／撤回／套用版本／複製用）、
 * 審查 r6 的五種繞法與 r5 的兩種、設定。瀏覽器的協作更新不在 server 檢查（網頁編輯器自己擋）。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { loadConfig } from "../../src/config.js";
import {
  DEFAULT_NOTE_MAX_BYTES,
  SIZE_SLACK_BYTES,
  capBlocks,
  growsPastCap,
  liveContentBytes,
  measureTrial,
  noteTooLargeMessage,
  stateSize,
  type SizeMeasure,
} from "../../src/notes/note-size.js";

const MiB = 1024 * 1024;
const frag = (d: Y.Doc) => d.getXmlFragment(YDOC_FRAGMENT);
const para = (d: Y.Doc, i: number) => frag(d).get(i) as Y.XmlElement;
const text = (d: Y.Doc, i: number) => para(d, i).get(0) as Y.XmlText;
const mkPara = (s: string) => {
  const p = new Y.XmlElement("paragraph");
  const t = new Y.XmlText();
  t.insert(0, s);
  p.insert(0, [t]);
  return p;
};
/** 一篇筆記：本文 fragment 下每個字串一段。 */
function noteDoc(paras: string[]): Y.Doc {
  const d = new Y.Doc();
  d.transact(() => frag(d).insert(0, paras.map(mkPara)));
  return d;
}
/** 超過上限的筆記：第 0 段 100 000 字、另外 39 段各 200 字；上限＝狀態減 1 000。 */
function overCap() {
  const doc = noteDoc(Array.from({ length: 40 }, (_, i) => (i === 0 ? "y".repeat(100_000) : "x".repeat(200))));
  return { doc, cap: stateSize(doc) - 1_000 };
}
/** 一個協作用戶端（同瀏覽器）：先同步 server 那份，之後每次 `edit` 回傳那筆交易的 update（不套到 server 那份上）。 */
function client(server: Y.Doc) {
  const c = new Y.Doc();
  Y.applyUpdate(c, Y.encodeStateAsUpdate(server));
  const edit = (f: (d: Y.Doc) => void): Uint8Array => {
    let out: Uint8Array | null = null;
    const h = (u: Uint8Array) => (out = u);
    c.on("update", h);
    c.transact(() => f(c));
    c.off("update", h);
    return out ?? new Uint8Array([0, 0]);
  };
  return Object.assign(edit, { doc: c });
}
const measure = (doc: Y.Doc, u: Uint8Array) => measureTrial(Y.encodeStateAsUpdate(doc), u);
function varuint(n: number, out: number[]) {
  while (n > 127) {
    out.push((n & 127) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
}

describe("capBlocks：超過上限、比原本大，而且（還在的內容變多，或狀態一次長超過 SLACK）才擋", () => {
  const m = (stateBefore: number, stateAfter: number, liveBefore: number, liveAfter: number): SizeMeasure => ({ stateBefore, stateAfter, liveBefore, liveAfter });
  it.each([
    [m(100, 150, 10, 60), 200, false], // 上限內
    [m(100, 201, 10, 60), 200, true], // 長過上限、內容變多
    [m(300, 250, 50, 60), 200, false], // 已超過、狀態變小（即使內容變多）
    [m(300, 301, 50, 51), 200, true], // 已超過、加一個字
    [m(300, 343, 50, 50), 200, false], // 已超過、等量改寫（狀態多 43 B）→ 接受
    [m(300, 300 + SIZE_SLACK_BYTES, 50, 40), 200, false], // 內容變少、狀態長剛好 SLACK → 接受
    [m(300, 301 + SIZE_SLACK_BYTES, 50, 40), 200, true], // 內容變少、狀態長超過 SLACK → 擋（只長簿記的花招）
    [m(0, 200, 0, 100), 200, false], // 剛好等於上限
  ])("%o cap %i → %s", (mm, cap, expected) => {
    expect(capBlocks(mm, cap)).toBe(expected);
  });
  it("SLACK 4 KiB；growsPastCap（複製用）＝超過上限且比原本大", () => {
    expect(SIZE_SLACK_BYTES).toBe(4096);
    expect(growsPastCap(0, 201, 200)).toBe(true);
    expect(growsPastCap(300, 250, 200)).toBe(false);
  });
  it("413 訊息說的是實際規則：刪除與改短照樣接受，要加內容就拆筆記", () => {
    expect(noteTooLargeMessage(5)).toContain("Deleting and shortening are still accepted");
    expect(noteTooLargeMessage(5)).not.toMatch(/always accepted|adds no more than it removes/);
  });
});

describe("liveContentBytes／measureTrial：還在的內容用 Yjs 的編碼器量", () => {
  it("每一種內容都算到它的大小：文字、屬性（key＋值）、格式、embed、子文件的 guid／meta、XmlHook 的名稱、BigInt", () => {
    const N = 50_000;
    const cases: Array<[string, (d: Y.Doc) => void]> = [
      ["text", d => text(d, 0).insert(0, "a".repeat(N))],
      ["attr value", d => para(d, 0).setAttribute("v", "A".repeat(N))],
      ["attr key", d => para(d, 0).setAttribute("K".repeat(N), "1")],
      ["format", d => text(d, 0).format(0, 2, { link: { href: "q".repeat(N) } })],
      ["embed", d => text(d, 0).insertEmbed(0, { src: "e".repeat(N) })],
      ["subdoc meta", d => para(d, 0).setAttribute("d", new Y.Doc({ meta: "M".repeat(N) }) as never)],
      ["subdoc guid", d => para(d, 0).setAttribute("d", new Y.Doc({ guid: "G".repeat(N) }) as never)],
      ["xmlhook", d => para(d, 0).insert(1, [new Y.XmlHook("H".repeat(N)) as never])],
      ["bigint", d => para(d, 0).setAttribute("b", Array.from({ length: N / 8 }, (_, i) => BigInt(i) * 1_000_000_000_000n) as never)],
    ];
    for (const [name, f] of cases) {
      const doc = noteDoc(["hello"]);
      const before = liveContentBytes(doc);
      doc.transact(() => f(doc));
      expect(liveContentBytes(doc) - before, name).toBeGreaterThanOrEqual(N * 0.9);
    }
  });
  it("刪掉的不算；measureTrial 回前後四個數（在新文件上套用）", () => {
    const doc = noteDoc(["hello wonderful world"]);
    const u = client(doc)(d => text(d, 0).delete(6, 10));
    const r = measure(doc, u);
    expect(r.stateBefore).toBe(stateSize(doc));
    expect(r.liveAfter).toBe(r.liveBefore - 10); // 切成兩顆不多算長度前綴
    const applied = new Y.Doc();
    Y.applyUpdate(applied, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(applied, u);
    expect(r.stateAfter).toBe(stateSize(applied));
  });
});

describe("審查 r6 的五種繞法：在超過上限的筆記上一律擋", () => {
  it("1 重複的刪除範圍（同一段刪 40 次，聲稱刪了 4 MB）＋插入 1 MiB", () => {
    const { doc, cap } = overCap();
    let u = client(doc)(d => text(d, 5).insert(0, "Z".repeat(MiB)));
    expect(u[u.length - 1]).toBe(0); // 空的刪除集
    const item = text(doc, 0)._start!;
    const ds: number[] = [];
    varuint(1, ds);
    varuint(item.id.client, ds);
    varuint(40, ds);
    for (let i = 0; i < 40; i++) {
      varuint(item.id.clock, ds);
      varuint(item.length, ds);
    }
    u = new Uint8Array([...u.subarray(0, u.length - 1), ...ds]);
    expect(capBlocks(measure(doc, u), cap)).toBe(true);
  });

  it("2 同一筆裡設一個 1 MiB 的 key 再刪掉（內容是 ContentDeleted，key 留在狀態裡）：本文裡 → 大小擋；別的根 → 根型別擋", () => {
    const { doc, cap } = overCap();
    const K = "K".repeat(MiB);
    const inNote = client(doc)(d => {
      para(d, 3).setAttribute(K, "1");
      para(d, 3).removeAttribute(K);
    });
    const m = measure(doc, inNote);
    expect(m.liveAfter).toBe(m.liveBefore); // 內容沒變多：靠 SLACK 擋
    expect(m.stateAfter - m.stateBefore).toBeGreaterThan(MiB);
    expect(capBlocks(m, cap)).toBe(true);
    const foreign = client(doc)(d => {
      d.getMap("evil").set(K, 1);
      d.getMap("evil").delete(K);
    });
    expect(capBlocks(measure(doc, foreign), cap)).toBe(true);
  });

  it("3 子文件的 meta／guid 1 MiB（＋刪 3 個字）", () => {
    for (const opts of [{ meta: "M".repeat(MiB) }, { guid: "G".repeat(MiB) }]) {
      const { doc, cap } = overCap();
      const inNote = client(doc)(d => {
        para(d, 1).setAttribute("d", new Y.Doc(opts) as never);
        text(d, 1).delete(0, 3);
      });
      expect(capBlocks(measure(doc, inNote), cap)).toBe(true);
      const foreign = client(doc)(d => {
        d.getMap("evil").set("d", new Y.Doc(opts));
        text(d, 1).delete(0, 3);
      });
      expect(capBlocks(measure(doc, foreign), cap)).toBe(true);
    }
  });

  it("4 XmlHook 的名稱 1 MiB（＋刪 3 個字）", () => {
    const { doc, cap } = overCap();
    const inNote = client(doc)(d => {
      para(d, 1).insert(1, [new Y.XmlHook("H".repeat(MiB)) as never]);
      text(d, 1).delete(0, 3);
    });
    expect(capBlocks(measure(doc, inNote), cap)).toBe(true);
    const foreign = client(doc)(d => {
      d.getXmlFragment("evil").insert(0, [new Y.XmlHook("H".repeat(MiB)) as never]);
      text(d, 1).delete(0, 3);
    });
    expect(capBlocks(measure(doc, foreign), cap)).toBe(true);
  });

  it("5 ContentAny 裡的 BigInt（JSON 量不出來的值）", () => {
    const { doc, cap } = overCap();
    const big = () => Array.from({ length: 100_000 }, (_, i) => BigInt(i) * 1_000_000_000_000n);
    const inNote = client(doc)(d => para(d, 2).setAttribute("b", big() as never));
    expect(capBlocks(measure(doc, inNote), cap)).toBe(true);
    const foreign = client(doc)(d => d.getArray("evil").insert(0, [big()]));
    expect(capBlocks(measure(doc, foreign), cap)).toBe(true);
  });
});

describe("審查 r5 的兩種：刪 1 個字＋大屬性、大連結格式", () => {
  it("刪 1 個字＋設 4 MiB 的屬性 → 擋", () => {
    const { doc, cap } = overCap();
    const u = client(doc)(d => {
      text(d, 4).delete(0, 1);
      para(d, 4).setAttribute("x", "A".repeat(4 * MiB));
    });
    expect(capBlocks(measure(doc, u), cap)).toBe(true);
  });
  it("套一個 2 MiB 的連結格式 → 擋", () => {
    const { doc, cap } = overCap();
    const u = client(doc)(d => text(d, 4).format(0, 5, { link: { href: "https://e.com/" + "q".repeat(2 * MiB) } }));
    expect(capBlocks(measure(doc, u), cap)).toBe(true);
  });
});

describe("超過上限的筆記：正常的刪減與改寫照樣接受，加內容擋", () => {
  it("全選＋打一個字 → 接受（試套一次）", () => {
    const { doc, cap } = overCap();
    const u = client(doc)(d => {
      frag(d).delete(1, frag(d).length - 1);
      text(d, 0).delete(0, text(d, 0).length);
      text(d, 0).insert(0, "a");
    });
    expect(capBlocks(measure(doc, u), cap)).toBe(false);
  });
  it("等量改寫（abc → xyz）→ 接受", () => {
    const { doc, cap } = overCap();
    const u = client(doc)(d => {
      text(d, 6).delete(10, 3);
      text(d, 6).insert(10, "xyz");
    });
    const m = measure(doc, u);
    expect(m.stateAfter).toBeGreaterThan(m.stateBefore); // 狀態變大一點，內容沒變多
    expect(m.liveAfter).toBe(m.liveBefore);
    expect(capBlocks(measure(doc, u), cap)).toBe(false);
  });
  it("刪一大段＋打幾個字（審查 r6 m1）→ 接受", () => {
    const { doc, cap } = overCap();
    const u = client(doc)(d => {
      text(d, 0).delete(0, 90_000);
      text(d, 0).insert(0, "hi there");
    });
    expect(capBlocks(measure(doc, u), cap)).toBe(false);
  });
  it("選一個字、打一個較長的字取代（狀態只長幾十位元組，但內容變多）→ 擋", () => {
    const { doc, cap } = overCap();
    const u = client(doc)(d => {
      text(d, 6).delete(10, 3);
      text(d, 6).insert(10, "a longer word");
    });
    const m = measure(doc, u);
    expect(m.stateAfter - m.stateBefore).toBeLessThan(SIZE_SLACK_BYTES);
    expect(capBlocks(measure(doc, u), cap)).toBe(true);
  });
});

describe("NOTE_MAX_BYTES 設定", () => {
  const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", APP_SECRET: "a".repeat(64), PUBLIC_URL: "http://localhost:3000" };
  it("預設 5 MiB；正整數可設；空字串＝未設；0、負數、小數、非數字、超過 1 GiB → 開機失敗", () => {
    expect(DEFAULT_NOTE_MAX_BYTES).toBe(5_242_880);
    expect(loadConfig(base).noteMaxBytes).toBe(5_242_880);
    expect(loadConfig({ ...base, NOTE_MAX_BYTES: "1048576" }).noteMaxBytes).toBe(1_048_576);
    expect(loadConfig({ ...base, NOTE_MAX_BYTES: "" }).noteMaxBytes, "空字串＝未設").toBe(5_242_880);
    for (const bad of ["0", "-1", "1.5", "abc", String(1024 ** 3 + 1)]) expect(() => loadConfig({ ...base, NOTE_MAX_BYTES: bad }), bad).toThrow(/NOTE_MAX_BYTES/);
  });
});
