import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// migration 鏈守衛（純檔案檢查，不需 DB，故放 unit）。
// 多支並行 PR 各自 `drizzle-kit generate` 時，後合併者若沿用自己分支上產生的舊檔，
// 會悄悄壞掉：journal `when` 較舊 → migrator 靜默跳過；snapshot 鏈分岔 → 下一次 generate 算錯 diff。

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const ZERO_ID = "00000000-0000-0000-0000-000000000000";

type JournalEntry = { idx: number; when: number; tag: string };
type Snapshot = { id: string; prevId: string };
type Reserved = { idx: number; tag: string; when: number };

/**
 * 跨分支刻意跳過的號：目前沒有保留號（feat/trash 的 0035 與 feat/folders 的 0034_folders 已合流）；機制留著給下次跨分支跳號。
 * 只准跳這裡登記的號；被跳的號兩側 `when` 必須夾住登記的 `when`（合流後 journal 仍單調）；登記的號一旦出現在 journal（＝已合流）就紅，
 * 要求刪掉這一筆。drizzle migrator 只看 `when` 不看 idx（drizzle-orm@0.44.7 migrator.js、pg-core/dialect.js:62）。
 */
const RESERVED: ReadonlyArray<Reserved> = [];

const pad = (idx: number) => String(idx).padStart(4, "0");

/** 回傳所有違規訊息（空陣列＝通過）；純函式，變異驗證與負向案例都餵改過的副本。 */
function checkMigrationChain(
  input: {
    entries: JournalEntry[];
    sqlFiles: string[]; // drizzle/*.sql 檔名
    snapshotFiles: string[]; // drizzle/meta/*_snapshot.json 檔名
    snapshots: Record<string, Snapshot>; // 檔名 → 內容
  },
  reserved: ReadonlyArray<Reserved> = RESERVED,
): string[] {
  const errors: string[] = [];
  const { entries, sqlFiles, snapshotFiles, snapshots } = input;

  // 0. 保留號：已出現在 journal → 合流完成，例外要刪；還沒出現 → 兩側 when 要夾住登記的 when
  const present = new Set(entries.map(e => e.idx));
  for (const r of reserved) {
    if (present.has(r.idx)) {
      const tag = entries.find(e => e.idx === r.idx)!.tag;
      errors.push(`保留號 ${pad(r.idx)} 已在 journal（tag ${tag}），合流完成請刪掉 RESERVED 的這一筆`);
    }
    const before = entries.filter(e => e.idx < r.idx).at(-1);
    const after = entries.find(e => e.idx > r.idx);
    if ((before && !(before.when < r.when)) || (after && !(r.when < after.when)))
      errors.push(`when 夾不住保留號 ${pad(r.idx)}：${before?.tag}(${before?.when}) < ${r.when} < ${after?.tag}(${after?.when}) 不成立`);
  }

  // 1. idx 從 0 連號（只准跳過還沒出現的保留號）；每筆都有 .sql 與 snapshot，且沒有未列入 journal 的多餘檔
  const skip = new Set(reserved.map(r => r.idx).filter(idx => !present.has(idx)));
  let want = 0;
  entries.forEach((e, i) => {
    while (skip.has(want)) want++;
    if (e.idx !== want) errors.push(`idx 不連號：第 ${i} 筆的 idx 是 ${e.idx}（應為 ${want}）`);
    want++;
  });
  // tag 前綴須等於零補位的 idx（擋住只改 idx 或只改檔名的半套重新編號）
  for (const e of entries) {
    const prefix = `${String(e.idx).padStart(4, "0")}_`;
    if (!e.tag.startsWith(prefix)) errors.push(`tag ${e.tag} 不是以 ${prefix} 開頭（idx ${e.idx}）`);
  }
  const wantSql = new Set(entries.map(e => `${e.tag}.sql`));
  const wantSnap = new Set(entries.map(e => `${String(e.idx).padStart(4, "0")}_snapshot.json`));
  for (const f of wantSql) if (!sqlFiles.includes(f)) errors.push(`journal 有 ${f} 但檔案不存在`);
  for (const f of wantSnap) if (!snapshotFiles.includes(f)) errors.push(`journal 有對應的 ${f} 但檔案不存在`);
  for (const f of sqlFiles) if (!wantSql.has(f)) errors.push(`多餘的 ${f}（journal 沒列）`);
  for (const f of snapshotFiles) if (!wantSnap.has(f)) errors.push(`多餘的 ${f}（journal 沒列）`);

  // 2. `when` 嚴格遞增。drizzle migrator 只套用 `lastDbMigration.created_at < migration.folderMillis` 者
  //    （drizzle-orm@0.44.7 pg-core/dialect.js:62），`when` 不大於前一支的 migration 會被靜默跳過。
  for (let i = 1; i < entries.length; i++) {
    if (!(entries[i]!.when > entries[i - 1]!.when))
      errors.push(`when 未嚴格遞增：${entries[i - 1]!.tag}(${entries[i - 1]!.when}) → ${entries[i]!.tag}(${entries[i]!.when})`);
  }

  // 3. snapshot 鏈：第 0 支 prevId 為全零 UUID，之後每支的 prevId 等於前一支的 id
  entries.forEach((e, i) => {
    const name = `${String(e.idx).padStart(4, "0")}_snapshot.json`;
    const cur = snapshots[name];
    if (!cur) return; // 缺檔已在 1. 報告
    const expected = i === 0 ? ZERO_ID : snapshots[`${String(entries[i - 1]!.idx).padStart(4, "0")}_snapshot.json`]?.id;
    if (cur.prevId !== expected) errors.push(`${name} 的 prevId(${cur.prevId}) 不等於 ${i === 0 ? "全零 UUID" : "前一支的 id"}(${expected})`);
  });

  return errors;
}

function loadReal() {
  const meta = path.join(drizzleDir, "meta");
  const journal = JSON.parse(readFileSync(path.join(meta, "_journal.json"), "utf8")) as { entries: JournalEntry[] };
  const sqlFiles = readdirSync(drizzleDir).filter(f => f.endsWith(".sql"));
  const snapshotFiles = readdirSync(meta).filter(f => f.endsWith("_snapshot.json"));
  const snapshots = Object.fromEntries(
    snapshotFiles.map(f => [f, JSON.parse(readFileSync(path.join(meta, f), "utf8")) as Snapshot]),
  );
  return { entries: journal.entries, sqlFiles, snapshotFiles, snapshots };
}

describe("migration 鏈守衛", () => {
  it("真實的 drizzle/ 目錄通過全部檢查", () => {
    const real = loadReal();
    expect(real.entries.length).toBeGreaterThan(0);
    expect(checkMigrationChain(real)).toEqual([]);
  });

  // 以下用真實資料的深拷貝注入違規，證明三類檢查各自會變紅（不碰真實檔案）。
  const mutated = (mutate: (c: ReturnType<typeof loadReal>) => void) => {
    const c = structuredClone(loadReal());
    mutate(c);
    return checkMigrationChain(c);
  };

  // 保留號機制用合成的小 journal 測（0000 → 0001 → 〔0002 保留〕→ 0003），一律顯式傳 reserved、不依賴真實目錄與
  // RESERVED 的現值：合流後刪掉 RESERVED 那一筆即全綠，永久跳號（feat/trash 先進 main）也照樣有測試。
  describe("保留號（合成 fixture：0002 保留）", () => {
    const R2: Reserved = { idx: 2, tag: "0002_c", when: 3000 };
    const fixture = () => {
      const entries: JournalEntry[] = [
        { idx: 0, tag: "0000_a", when: 1000 },
        { idx: 1, tag: "0001_b", when: 2000 },
        { idx: 3, tag: "0003_d", when: 4000 },
      ];
      const ids = ["a0000000-0000-4000-8000-000000000000", "b0000000-0000-4000-8000-000000000000", "d0000000-0000-4000-8000-000000000000"];
      const snapshots: Record<string, Snapshot> = {
        "0000_snapshot.json": { id: ids[0]!, prevId: ZERO_ID },
        "0001_snapshot.json": { id: ids[1]!, prevId: ids[0]! },
        "0003_snapshot.json": { id: ids[2]!, prevId: ids[1]! },
      };
      return {
        entries,
        sqlFiles: entries.map(e => `${e.tag}.sql`),
        snapshotFiles: Object.keys(snapshots),
        snapshots,
      };
    };
    const check = (mutate: (c: ReturnType<typeof fixture>) => void, reserved: ReadonlyArray<Reserved> = [R2]) => {
      const c = fixture();
      mutate(c);
      return checkMigrationChain(c, reserved);
    };

    it("跳的是登記過的號、兩側 when 夾住 → 通過", () => {
      expect(check(() => {})).toEqual([]);
    });

    it("reserved 為空陣列 → idx 不連號（證明例外確實在起作用）", () => {
      expect(check(() => {}, [])).toEqual([expect.stringContaining("idx 不連號")]);
    });

    it("跳了沒登記的號 → idx 不連號", () => {
      expect(
        check(c => {
          c.entries[2] = { idx: 4, tag: "0004_d", when: 4000 };
          c.sqlFiles[2] = "0004_d.sql";
          c.snapshotFiles[2] = "0004_snapshot.json";
          c.snapshots["0004_snapshot.json"] = c.snapshots["0003_snapshot.json"]!;
          delete c.snapshots["0003_snapshot.json"];
        }),
      ).toEqual([expect.stringContaining("idx 不連號")]);
    });

    it("保留號已出現在 journal（＝已合流）→ 只報「請刪掉 RESERVED 的這一筆」", () => {
      const errors = check(c => {
        c.entries.splice(2, 0, { idx: 2, tag: "0002_c", when: 3000 });
        c.sqlFiles.push("0002_c.sql");
        c.snapshotFiles.push("0002_snapshot.json");
        c.snapshots["0002_snapshot.json"] = { id: "c0000000-0000-4000-8000-000000000000", prevId: c.snapshots["0001_snapshot.json"]!.id };
        c.snapshots["0003_snapshot.json"]!.prevId = "c0000000-0000-4000-8000-000000000000";
      });
      expect(errors).toEqual([expect.stringContaining("保留號 0002 已在 journal")]);
    });

    it("後一支的 when 等於登記的 when → when 夾不住（等號也算夾不住）", () => {
      expect(check(c => { c.entries[2]!.when = 3000; })).toEqual([expect.stringContaining("when 夾不住保留號 0002")]);
    });

    it("登記的 when 等於前一支的 when → when 夾不住（前一側也有檢查）", () => {
      expect(check(() => {}, [{ ...R2, when: 2000 }])).toEqual([expect.stringContaining("when 夾不住保留號 0002")]);
    });
  });

  it("idx 缺號、缺 .sql、缺 snapshot、多餘檔都會被抓到", () => {
    expect(mutated(c => { c.entries[3]!.idx = 7; })).toEqual(expect.arrayContaining([expect.stringContaining("idx 不連號")]));
    expect(mutated(c => { c.sqlFiles.pop(); })).toEqual(expect.arrayContaining([expect.stringContaining("檔案不存在")]));
    expect(mutated(c => { c.snapshotFiles.pop(); })).toEqual(expect.arrayContaining([expect.stringContaining("檔案不存在")]));
    expect(mutated(c => { c.sqlFiles.push("9999_x.sql"); })).toEqual(expect.arrayContaining([expect.stringContaining("多餘的")]));
    expect(mutated(c => { c.snapshotFiles.push("9999_snapshot.json"); })).toEqual(expect.arrayContaining([expect.stringContaining("多餘的")]));
  });

  it("tag 前綴與 idx 不符（半套重新編號）會被抓到", () => {
    expect(mutated(c => { c.entries[15]!.tag = "0014_b"; })).toEqual(expect.arrayContaining([expect.stringContaining("不是以 0015_ 開頭")]));
  });

  it("when 相等或倒退都會被抓到", () => {
    expect(mutated(c => { c.entries[5]!.when = c.entries[4]!.when; })).toEqual(expect.arrayContaining([expect.stringContaining("when 未嚴格遞增")]));
    expect(mutated(c => { c.entries[5]!.when = c.entries[4]!.when - 1; })).toEqual(expect.arrayContaining([expect.stringContaining("when 未嚴格遞增")]));
  });

  it("snapshot 鏈分岔、第 0 支 prevId 非全零都會被抓到", () => {
    expect(mutated(c => { c.snapshots["0007_snapshot.json"]!.prevId = "11111111-1111-1111-1111-111111111111"; })).toEqual(
      expect.arrayContaining([expect.stringContaining("0007_snapshot.json 的 prevId")]),
    );
    expect(mutated(c => { c.snapshots["0000_snapshot.json"]!.prevId = "11111111-1111-1111-1111-111111111111"; })).toEqual(
      expect.arrayContaining([expect.stringContaining("全零 UUID")]),
    );
  });
});
