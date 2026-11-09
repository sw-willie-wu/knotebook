/**
 * bulk transfer spec 2026-11-02 §6.1、§6.6-4～-6、§25.4：串流寫出 `.tar.gz`（不加依賴，照 spike S4 的 A 形）。
 *
 * - 路徑非 ASCII 或超過 100 bytes → 先寫一個 `x` 型 pax 標頭帶 `path` 記錄（UTF-8 原名），ustar 標頭的 name 欄放 ASCII 後備
 *   （`PaxHeader-fallback/<sha1 前 16>`）。GNU tar、bsdtar、Python tarfile 都認 pax（spike S4）。
 * - 每個項目寫完 `gzip.flush(Z_SYNC_FLUSH)`，等回呼——回呼要等下游消化，所以 flush 本身就是背壓（`write()` 回 false 時另等
 *   `drain`，是防線、不承重：plan T7-M4）。
 * - **所有等待都與內部 abort signal 賽跑**（plan gate r1 C1）：gzip pipe 到不消化的下游時，下游被 destroy 之後 flush 回呼與
 *   drain 都永不 settle。`abort()` 讓 pending 的 `addFile`／`addDir`／`finish` 立刻以 `TarAbortError` reject，之後的呼叫也立刻
 *   reject；`out` 自己 `'close'`／`'error'`（socket 斷）時 writer 也會 abort。`finish()` 只有 `out` 的 `'finish'` 算成功。
 * - 中止不送 tar 結尾區塊也不送 gzip 結尾：呼叫端另外 destroy socket（§5.6：curl 因此 exit 18）。
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Writable } from "node:stream";
import zlib from "node:zlib";

export class TarAbortError extends Error {
  constructor(cause?: unknown) {
    super("tar stream aborted");
    this.name = "AbortError";
    if (cause !== undefined) this.cause = cause;
  }
}

const BLOCK = 512;
const octal = (n: number, len: number): string => n.toString(8).padStart(len - 1, "0") + "\0";
const padOf = (n: number): Buffer => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK, 0);
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** 名字要不要 pax：非可印 ASCII、或超過 ustar name 欄的 100 bytes。 */
export function needsPax(name: string): boolean {
  return !PRINTABLE_ASCII.test(name) || Buffer.byteLength(name, "utf8") > 100;
}

/** ustar 標頭（512 bytes）。`name` 必須是 ≤ 100 bytes 的可印 ASCII（呼叫端給後備名）。checksum 照 POSIX：先填 8 個空白再加總。 */
export function ustarHeader(h: { name: string; size: number; type: "0" | "5" | "x"; mode: number; mtime: number }): Buffer {
  const b = Buffer.alloc(BLOCK, 0);
  b.write(h.name, 0, 100, "ascii");
  b.write(octal(h.mode, 8), 100, "ascii");
  b.write(octal(0, 8), 108, "ascii");
  b.write(octal(0, 8), 116, "ascii");
  b.write(octal(h.size, 12), 124, "ascii");
  b.write(octal(h.mtime, 12), 136, "ascii");
  b.write("        ", 148, "ascii");
  b.write(h.type, 156, "ascii");
  b.write("ustar\0", 257, "ascii");
  b.write("00", 263, "ascii");
  let sum = 0;
  for (const x of b) sum += x;
  b.write(octal(sum, 7) + " ", 148, "ascii");
  return b;
}

/** pax 記錄 `"<len> <key>=<value>\n"`，`len` 含它自己的位數（兩段式：位數進位時再算一次）。 */
export function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const len = Buffer.byteLength(body, "utf8");
  let total = len + String(len).length;
  if (String(total).length !== String(len).length) total = len + String(total).length;
  return Buffer.from(`${total}${body}`, "utf8");
}

function fallbackName(name: string, dir: boolean): string {
  return "PaxHeader-fallback/" + createHash("sha1").update(name, "utf8").digest("hex").slice(0, 16) + (dir ? "/" : "");
}

/** 一個項目的全部位元組（pax 標頭＋記錄＋補齊、ustar 標頭、內容＋補齊）。 */
export function entryBytes(name: string, type: "0" | "5", data: Buffer, mtime: number): Buffer[] {
  const out: Buffer[] = [];
  const dir = type === "5";
  if (needsPax(name)) {
    const rec = paxRecord("path", name);
    out.push(ustarHeader({ name: "PaxHeader", size: rec.length, type: "x", mode: 0o644, mtime }), rec, padOf(rec.length));
  }
  out.push(ustarHeader({ name: needsPax(name) ? fallbackName(name, dir) : name, size: data.length, type, mode: dir ? 0o755 : 0o644, mtime }));
  if (data.length > 0) out.push(data, padOf(data.length));
  return out;
}

export class TarGzWriter {
  private readonly gz: zlib.Gzip;
  private readonly ac = new AbortController();
  private readonly mtime: number;
  private bytes = 0;

  constructor(
    private readonly out: Writable,
    opts: { mtime: Date },
  ) {
    this.mtime = Math.floor(opts.mtime.getTime() / 1000);
    this.gz = zlib.createGzip();
    this.gz.on("error", err => this.abort(err));
    this.gz.on("data", (c: Buffer) => {
      this.bytes += c.length;
    });
    this.gz.pipe(out);
    const gone = (err?: unknown) => this.abort(err ?? new Error("output closed"));
    out.once("close", () => gone());
    out.once("error", err => gone(err));
  }

  /** gzip 之後送出的位元組數。 */
  get bytesOut(): number {
    return this.bytes;
  }

  get aborted(): boolean {
    return this.ac.signal.aborted;
  }

  addDir(path: string): Promise<void> {
    return this.addEntry(path.endsWith("/") ? path : path + "/", "5", Buffer.alloc(0));
  }

  addFile(path: string, data: Buffer): Promise<void> {
    return this.addEntry(path, "0", data);
  }

  /** tar 結尾（1024 bytes 零）＋gzip 結尾；只有 `out` 的 `'finish'` 算成功（先 close 或 abort → reject）。 */
  async finish(): Promise<void> {
    this.check();
    const signal = this.ac.signal;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        this.out.removeListener("finish", onFinish);
        this.out.removeListener("close", onClose);
      };
      const onAbort = () => {
        cleanup();
        reject(new TarAbortError(signal.reason));
      };
      const onFinish = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new TarAbortError(new Error("output closed before finish")));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.out.once("finish", onFinish);
      this.out.once("close", onClose);
      this.gz.end(Buffer.alloc(BLOCK * 2, 0));
    });
  }

  /** 冪等：pending 的等待全部以 `TarAbortError` reject；unpipe＋destroy gzip（不送結尾）。socket 由呼叫端 destroy。 */
  abort(reason?: unknown): void {
    if (this.ac.signal.aborted) return;
    this.ac.abort(reason ?? new Error("aborted"));
    this.gz.unpipe(this.out);
    this.gz.destroy();
  }

  private check(): void {
    if (this.ac.signal.aborted) throw new TarAbortError(this.ac.signal.reason);
  }

  private async addEntry(name: string, type: "0" | "5", data: Buffer): Promise<void> {
    this.check();
    for (const b of entryBytes(name, type, data, this.mtime)) await this.write(b);
    await this.flush();
  }

  private async write(buf: Buffer): Promise<void> {
    this.check();
    if (!this.gz.write(buf)) {
      try {
        await once(this.gz, "drain", { signal: this.ac.signal });
      } catch (err) {
        throw new TarAbortError(err);
      }
    }
  }

  private flush(): Promise<void> {
    const signal = this.ac.signal;
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new TarAbortError(signal.reason));
      const onAbort = () => reject(new TarAbortError(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
      this.gz.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(new TarAbortError(signal.reason));
        else resolve();
      });
    });
  }
}
