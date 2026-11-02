import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import zlib from "node:zlib";
import { TarGzWriter, paxRecord } from "../../src/transfer/tar.js";
import { parseTar, readPartialTarGz, readTarGz } from "../tar-read.js";

/** bulk transfer spec §6.1、§6.6-4～-6、§25.4；plan T7（T-1～T-8）。 */

const MTIME = new Date("2026-11-02T00:00:00Z");
const cjk64 = "資料夾名稱很長".repeat(10).slice(0, 64);
const title64 = "會議紀錄標題非常長的筆記".repeat(6).slice(0, 64);
const a64 = "a".repeat(64);
const b64s = "b".repeat(64);
/** spike S4 A 形的 21 項名單（目錄不帶尾斜線）。 */
const ENTRIES: Array<{ dir: string } | { name: string }> = [
  { dir: "My notes" },
  { dir: "Groups" },
  { dir: "Shared with me" },
  { dir: ".knotebook" },
  { name: "My notes/會議紀錄.md" },
  { dir: "My notes/專案" },
  { dir: "My notes/專案/子資料夾" },
  { name: "My notes/專案/子資料夾/中文標題 (2).md" },
  { name: "My notes/\u{1F680} launch ✓.md" },
  { name: "My notes/café NFC é.md" },
  { name: "My notes/sym #%&'[]{}=+,;@!$^~`.md" },
  { name: "My notes/ascii-only.md" },
  { dir: "My notes/空資料夾" },
  { dir: `Groups/${cjk64}` },
  { dir: `Groups/${cjk64}/${cjk64}` },
  { dir: `Groups/${cjk64}/${cjk64}/${cjk64}` },
  { name: `Groups/${cjk64}/${cjk64}/${cjk64}/${title64}.md` },
  { dir: `Shared with me/${a64}` },
  { dir: `Shared with me/${a64}/${b64s}` },
  { name: `Shared with me/${a64}/${b64s}/${"c".repeat(64)}.md` },
  { name: ".knotebook/manifest.json" },
];
const bodyOf = (n: string) => Buffer.from(`---\nknotebook: 1\ntitle: ${JSON.stringify(n)}\n---\n內容 ${n}\n`, "utf8");

/** 收集用 Writable；`hold` 時不呼叫 write 回呼（＝下游不消化），`release()` 之後消化。 */
function sink(opts: { hold?: boolean; highWaterMark?: number } = {}) {
  const chunks: Buffer[] = [];
  let holding = opts.hold ?? false;
  const pending: Array<() => void> = [];
  const w = new Writable({
    highWaterMark: opts.highWaterMark ?? 16 * 1024,
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk);
      if (holding) pending.push(cb);
      else cb();
    },
  });
  return {
    w,
    bytes: () => Buffer.concat(chunks),
    release: () => {
      holding = false;
      for (const cb of pending.splice(0)) cb();
    },
  };
}
const settle = <T>(p: Promise<T>) => {
  const s: { state: "pending" | "resolved" | "rejected"; err?: unknown } = { state: "pending" };
  p.then(
    () => void (s.state = "resolved"),
    e => {
      s.state = "rejected";
      s.err = e;
    },
  );
  return s;
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function writeAll(w: TarGzWriter) {
  for (const e of ENTRIES) {
    if ("dir" in e) await w.addDir(e.dir);
    else await w.addFile(e.name, bodyOf(e.name));
  }
}

describe("TarGzWriter", () => {
  it("T-1 往返：21 項（CJK、emoji、é、符號、空資料夾、~270 code point 的 CJK 長路徑、ASCII > 100 bytes）名稱、型別、內容、順序逐一相等", async () => {
    const s = sink();
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    await writeAll(w);
    await w.finish();
    const got = readTarGz(s.bytes());
    expect(got.map(e => [e.type, e.path])).toEqual(ENTRIES.map(e => ("dir" in e ? ["dir", e.dir] : ["file", e.name])));
    for (const [k, e] of ENTRIES.entries()) if ("name" in e) expect(got[k]!.data.equals(bodyOf(e.name)), e.name).toBe(true);
    expect(w.bytesOut).toBe(s.bytes().length);
  });

  it("T-2 ASCII ≤ 100 bytes 的名字不寫 pax、其餘都寫；長度自含的 pax 記錄在位數進位時也對", async () => {
    const s = sink();
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    await writeAll(w);
    await w.finish();
    const { headers } = parseTar(zlib.gunzipSync(s.bytes()));
    const pax = headers.filter(h => h.type === "x").length;
    const want = ENTRIES.map(e => ("dir" in e ? e.dir + "/" : e.name)).filter(n => !/^[\x20-\x7e]*$/.test(n) || Buffer.byteLength(n) > 100).length;
    expect(pax).toBe(want);
    expect(want).toBeGreaterThan(5);
    expect(headers.filter(h => h.type !== "x").map(h => h.name)).toContain("My notes/ascii-only.md");
    // 自含長度：body 長 94 → 94+2=96；body 長 98 → 98+2=100（三位數）→ 再算一次 101
    for (const v of ["x".repeat(84), "x".repeat(88), "x".repeat(89), "é".repeat(500)]) {
      const r = paxRecord("path", v);
      expect(Number(r.toString("utf8").split(" ")[0]), v.length.toString()).toBe(r.length);
    }
  });

  it("T-3 每個 512 標頭的 checksum 重算等於欄位值", async () => {
    const s = sink();
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    await writeAll(w);
    await w.finish();
    const { headers } = parseTar(zlib.gunzipSync(s.bytes()));
    expect(headers.length).toBeGreaterThan(21);
    for (const h of headers) expect(h.checksumField, h.name).toBe(h.checksumComputed);
  });

  it("T-4 逐篇 flush：每個 addFile resolve 時，已收到的位元組（SYNC_FLUSH 解開）就含剛寫完那一項的完整內容", async () => {
    const s = sink();
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    for (let i = 0; i < 5; i++) {
      const data = Buffer.from(`note ${i} `.repeat(200 + i));
      await w.addFile(`My notes/n${i}.md`, data);
      const seen = readPartialTarGz(s.bytes());
      expect(seen.map(e => e.path)).toEqual(Array.from({ length: i + 1 }, (_, k) => `My notes/n${k}.md`));
      expect(seen[i]!.data.equals(data)).toBe(true);
    }
    await w.finish();
  });

  it("T-5 背壓：下游 highWaterMark 16 且不消化 → 1 MiB 亂數的 addFile 50 ms 內仍未 resolve；下游開始消化後 resolve", async () => {
    const s = sink({ hold: true, highWaterMark: 16 });
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    const st = settle(w.addFile("My notes/big.bin", randomBytes(1024 * 1024)));
    await sleep(50);
    expect(st.state).toBe("pending");
    s.release();
    for (let i = 0; i < 100 && st.state === "pending"; i++) await sleep(10);
    expect(st.state).toBe("resolved");
    await w.finish();
    expect(readTarGz(s.bytes()).map(e => e.path)).toEqual(["My notes/big.bin"]);
  });

  it("T-6 abort 之後輸出讀不出完整包；finish 之後最後 1024 bytes（解壓後）全零", async () => {
    const a = sink();
    const wa = new TarGzWriter(a.w, { mtime: MTIME });
    await wa.addFile("My notes/a.md", Buffer.from("a"));
    wa.abort();
    expect(() => readTarGz(a.bytes())).toThrow();
    const b = sink();
    const wb = new TarGzWriter(b.w, { mtime: MTIME });
    await wb.addFile("My notes/a.md", Buffer.from("a"));
    await wb.finish();
    const tar = zlib.gunzipSync(b.bytes());
    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(tar.length - 1024).every(x => x === 0)).toBe(true);
  });

  it("T-8a abort 解除等待：下游不消化時 pending 的 addFile 在 abort 後 100 ms 內以 AbortError reject；之後 addFile／addDir／finish 立刻 reject", async () => {
    const s = sink({ hold: true, highWaterMark: 16 });
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    const st = settle(w.addFile("My notes/big.bin", randomBytes(1024 * 1024)));
    await sleep(50);
    expect(st.state, "前提：50 ms 時仍 pending").toBe("pending");
    w.abort(new Error("stop"));
    for (let i = 0; i < 10 && st.state === "pending"; i++) await sleep(10);
    expect(st.state).toBe("rejected");
    expect((st.err as Error).name).toBe("AbortError");
    await expect(w.addFile("x", Buffer.from("x"))).rejects.toMatchObject({ name: "AbortError" });
    await expect(w.addDir("x")).rejects.toMatchObject({ name: "AbortError" });
    await expect(w.finish()).rejects.toMatchObject({ name: "AbortError" });
    w.abort(); // 冪等
  });

  it("T-8b 下游自己被 destroy（模擬 socket 斷）→ pending 的 addFile 100 ms 內 reject", async () => {
    const s = sink({ hold: true, highWaterMark: 16 });
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    const st = settle(w.addFile("My notes/big.bin", randomBytes(1024 * 1024)));
    await sleep(50);
    expect(st.state, "前提：50 ms 時仍 pending").toBe("pending");
    s.w.destroy();
    for (let i = 0; i < 10 && st.state === "pending"; i++) await sleep(10);
    expect(st.state).toBe("rejected");
    expect((st.err as Error).name).toBe("AbortError");
    expect(w.aborted).toBe(true);
  });

  it("T-8c finish 進行中下游被 destroy → finish 以 AbortError reject、不 resolve", async () => {
    const s = sink({ hold: true, highWaterMark: 16 });
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    const st = settle(w.finish());
    await sleep(30);
    expect(st.state, "前提：下游不消化時 finish 未完成").toBe("pending");
    s.w.destroy();
    for (let i = 0; i < 10 && st.state === "pending"; i++) await sleep(10);
    expect(st.state).toBe("rejected");
    expect((st.err as Error).name).toBe("AbortError");
  });

  const hasGnuTar = (() => {
    if (process.platform === "win32") return false;
    try {
      return /GNU tar/.test(execFileSync("tar", ["--version"], { encoding: "utf8" }));
    } catch {
      return false;
    }
  })();
  it.runIf(hasGnuTar)("T-7 GNU tar -tzf 列出的名字＝名單", async () => {
    const s = sink();
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    await writeAll(w);
    await w.finish();
    const dir = mkdtempSync(path.join(tmpdir(), "kn-tar-"));
    try {
      const f = path.join(dir, "t.tar.gz");
      writeFileSync(f, s.bytes());
      const listed = execFileSync("tar", ["-tzf", f], { encoding: "utf8" }).split("\n").filter(Boolean);
      expect(listed).toEqual(ENTRIES.map(e => ("dir" in e ? e.dir + "/" : e.name)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
