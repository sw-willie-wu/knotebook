/** `avatars/oidc-fetch.ts`：IdP 頭貼下載器的界線、位址檢查與 issuer 同主機豁免。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_OIDC_AVATAR_BYTES } from "@knotebook/shared";
import {
  PRODUCTION_AVATAR_FETCH_POLICY,
  fetchOidcAvatar,
  type AvatarFetchPolicy,
  type LookupAll,
} from "../../src/avatars/oidc-fetch.js";

const ISSUER = "https://idp.example";
const OPEN: AvatarFetchPolicy = { portAllowed: () => true, addressBlocked: () => false };
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(size = 64): Buffer {
  const b = Buffer.alloc(size);
  Buffer.from(PNG_HEAD).copy(b);
  return b;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let base: string;
const handlers = new Map<string, Handler>();
let lastHeaders: IncomingMessage["headers"] = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    lastHeaders = req.headers;
    const h = handlers.get(new URL(req.url ?? "/", "http://x").pathname);
    if (!h) {
      res.statusCode = 404;
      res.end();
      return;
    }
    h(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

function serve(path: string, status: number, headers: Record<string, string>, body?: Buffer | string) {
  handlers.set(path, (_req, res) => {
    res.writeHead(status, headers);
    res.end(body);
  });
}

const run = (url: string, over: Partial<Parameters<typeof fetchOidcAvatar>[1]> = {}) =>
  fetchOidcAvatar(url, { issuer: ISSUER, policy: OPEN, ...over });

/** 假 fetch：回固定圖片，記下被請求的網址。 */
function fakeFetch(seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(new Uint8Array(png()), { status: 200, headers: { "content-type": "image/png" } });
  }) as typeof fetch;
}

const lookupTo = (...addrs: string[]): LookupAll => async () =>
  addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("limits", () => {
  it("downloads a png", async () => {
    serve("/ok.png", 200, { "content-type": "image/png" }, png());
    const r = await run(`${base}/ok.png`);
    expect(r).toMatchObject({ ok: true, mime: "image/png", finalUrl: `${base}/ok.png` });
  });

  it.each(["ftp://img.example/a.png", "file:///etc/passwd"])("rejects scheme of %s", async (u) => {
    expect(await run(u)).toEqual({ ok: false, reason: "bad_scheme" });
  });

  it("applies the production port allowlist", async () => {
    const lookup = lookupTo("203.0.113.7");
    const p = PRODUCTION_AVATAR_FETCH_POLICY;
    const f = fakeFetch();
    expect(await run("http://img.example:8081/a.png", { policy: p, lookup, fetchImpl: f })).toEqual({ ok: false, reason: "bad_port" });
    expect((await run("http://img.example:80/a.png", { policy: p, lookup, fetchImpl: f })).ok).toBe(true);
    expect((await run("https://img.example:443/a.png", { policy: p, lookup, fetchImpl: f })).ok).toBe(true);
    expect((await run("http://img.example/a.png", { policy: p, lookup, fetchImpl: f })).ok).toBe(true);
    expect((await run("https://img.example:8443/a.png", { policy: p, lookup, fetchImpl: f, issuer: "https://idp.example:8443" })).ok).toBe(true);
  });

  it("rejects the fourth redirect, accepts three", async () => {
    serve("/r4", 302, { location: "/r3" });
    serve("/r3", 302, { location: "/r2" });
    serve("/r2", 302, { location: "/r1" });
    serve("/r1", 302, { location: "/ok.png" });
    serve("/ok.png", 200, { "content-type": "image/png" }, png());
    expect(await run(`${base}/r4`)).toEqual({ ok: false, reason: "too_many_redirects" });
    expect(await run(`${base}/r3`)).toMatchObject({ ok: true, finalUrl: `${base}/ok.png` });
  });

  it("rejects a redirect to a bad scheme, a bad port, or a blocked address on that hop", async () => {
    serve("/to-ftp", 302, { location: "ftp://img.example/a.png" });
    serve("/to-port", 302, { location: "http://img.example:9999/a.png" });
    serve("/to-private", 302, { location: "http://10.0.0.9/a.png" });
    const loop: AvatarFetchPolicy = { portAllowed: () => true, addressBlocked: (ip) => ip.startsWith("10.") };
    expect(await run(`${base}/to-ftp`)).toEqual({ ok: false, reason: "bad_scheme" });
    expect(await run(`${base}/to-port`, { policy: { portAllowed: (p) => p !== 9999, addressBlocked: () => false } })).toEqual({ ok: false, reason: "bad_port" });
    expect(await run(`${base}/to-private`, { policy: loop })).toEqual({ ok: false, reason: "blocked_address" });
  });

  it("does not read the body of a non-image content-type", async () => {
    let closedEarly = false;
    handlers.set("/html", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.on("close", () => {
        closedEarly = !res.writableEnded;
      });
      const chunk = Buffer.alloc(64 * 1024);
      const tick = setInterval(() => {
        if (res.destroyed) return clearInterval(tick);
        res.write(chunk);
      }, 5);
    });
    expect(await run(`${base}/html`)).toEqual({ ok: false, reason: "bad_content_type" });
    await new Promise((r) => setTimeout(r, 100));
    expect(closedEarly).toBe(true);
  });

  it("strips content-type parameters and case", async () => {
    serve("/ct", 200, { "content-type": "Image/PNG; charset=binary" }, png());
    expect((await run(`${base}/ct`)).ok).toBe(true);
  });

  it("rejects one byte over the size cap and accepts exactly the cap", async () => {
    serve("/exact", 200, { "content-type": "image/png" }, png(MAX_OIDC_AVATAR_BYTES));
    serve("/over", 200, { "content-type": "image/png" }, png(MAX_OIDC_AVATAR_BYTES + 1));
    expect((await run(`${base}/exact`)).ok).toBe(true);
    expect(await run(`${base}/over`)).toEqual({ ok: false, reason: "too_large" });
  });

  it("stops a chunked body that exceeds the cap without a content-length", async () => {
    handlers.set("/chunked", (_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(png(MAX_OIDC_AVATAR_BYTES));
      res.write(Buffer.from([1]));
      res.end();
    });
    expect(await run(`${base}/chunked`)).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects a declared content-length over the cap before reading the body", async () => {
    handlers.set("/declared", (_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(MAX_OIDC_AVATAR_BYTES + 1) });
      res.write(png(16)); // 其餘永遠不送
    });
    const t0 = Date.now();
    expect(await run(`${base}/declared`, { timeoutMs: 3000 })).toEqual({ ok: false, reason: "too_large" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("rejects non-image bytes and gif under an image content-type", async () => {
    serve("/text", 200, { "content-type": "image/png" }, "hello, not an image");
    serve("/gif", 200, { "content-type": "image/png" }, Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"));
    expect(await run(`${base}/text`)).toEqual({ ok: false, reason: "not_image" });
    expect(await run(`${base}/gif`)).toEqual({ ok: false, reason: "not_image" });
  });

  it("maps non-2xx to http_status", async () => {
    serve("/500", 500, {});
    serve("/redir-nolocation", 302, {});
    expect(await run(`${base}/500`)).toEqual({ ok: false, reason: "http_status" });
    expect(await run(`${base}/redir-nolocation`)).toEqual({ ok: false, reason: "http_status" });
  });

  it("times out a slow body", async () => {
    handlers.set("/slow", (_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(png(16));
      const tick = setInterval(() => {
        if (res.destroyed) return clearInterval(tick);
        res.write("x");
      }, 2000);
      res.on("close", () => clearInterval(tick));
    });
    expect(await run(`${base}/slow`, { timeoutMs: 400 })).toEqual({ ok: false, reason: "timeout" });
  });

  it("times out a lookup that never resolves", async () => {
    const lookup: LookupAll = () => new Promise(() => undefined);
    expect(await run("https://img.example/a.png", { lookup, timeoutMs: 400, fetchImpl: fakeFetch() })).toEqual({ ok: false, reason: "timeout" });
  });

  it("sends accept but no cookie or authorization", async () => {
    serve("/h", 200, { "content-type": "image/png" }, png());
    await run(`${base}/h`);
    expect(lastHeaders.cookie).toBeUndefined();
    expect(lastHeaders.authorization).toBeUndefined();
    expect(lastHeaders.accept).toBe("image/png,image/jpeg,image/webp");
  });
});

describe("credentials and error hygiene", () => {
  it("rejects a url with userinfo before connecting", async () => {
    const seen: string[] = [];
    for (const u of ["https://alice:pw@img.example/a.png", "https://alice@img.example/a.png", "https://:pw@img.example/a.png"]) {
      expect(await run(u, { lookup: lookupTo("203.0.113.7"), fetchImpl: fakeFetch(seen) })).toEqual({ ok: false, reason: "credentials" });
    }
    expect(seen).toEqual([]);
  });

  it("rejects a redirect Location that carries userinfo", async () => {
    serve("/to-cred", 302, { location: `http://alice:pw@127.0.0.1:${new URL(base).port}/ok.png` });
    serve("/ok.png", 200, { "content-type": "image/png" }, png());
    expect(await run(`${base}/to-cred`)).toEqual({ ok: false, reason: "credentials" });
  });

  it("maps a fetch error to network and never exposes its message", async () => {
    const secretUrl = "https://img.example/a.png?token=s3cret";
    const boom: typeof fetch = async (input) => {
      throw new TypeError(`fetch failed for ${String(input)} password=hunter2`);
    };
    const r = await run(secretUrl, { lookup: lookupTo("203.0.113.7"), fetchImpl: boom });
    expect(r).toEqual({ ok: false, reason: "network" });
    expect(JSON.stringify(r)).not.toMatch(/s3cret|hunter2/);
  });

  it("maps an error thrown by the policy to network without leaking the message", async () => {
    const policy: AvatarFetchPolicy = {
      portAllowed: () => true,
      addressBlocked: () => {
        throw new Error("token=s3cret");
      },
    };
    const r = await run("https://img.example/a.png", { policy, lookup: lookupTo("203.0.113.7"), fetchImpl: fakeFetch() });
    expect(r).toEqual({ ok: false, reason: "network" });
    expect(JSON.stringify(r)).not.toContain("s3cret");
  });

  it("maps a body read error to network without leaking the message", async () => {
    const f: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("socket hang up token=s3cret"));
          },
        }),
        { status: 200, headers: { "content-type": "image/png" } },
      );
    const r = await run("https://img.example/a.png", { lookup: lookupTo("203.0.113.7"), fetchImpl: f });
    expect(r).toEqual({ ok: false, reason: "network" });
    expect(JSON.stringify(r)).not.toContain("s3cret");
  });

  it("does not throw for a real connection failure", async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    expect(await run(`http://127.0.0.1:${port}/a.png`)).toEqual({ ok: false, reason: "network" });
  });
});

describe("address policy (production)", () => {
  const P = PRODUCTION_AVATAR_FETCH_POLICY;
  const prod = (url: string, over: Partial<Parameters<typeof fetchOidcAvatar>[1]> = {}) =>
    run(url, { policy: { ...P, portAllowed: () => true }, fetchImpl: fakeFetch(), ...over });

  it.each([
    "http://127.0.0.1/a.png",
    "http://10.1.2.3/a.png",
    "http://169.254.169.254/a.png",
    "http://100.64.0.1/a.png",
    "http://172.16.0.1/a.png",
    "http://192.168.1.10/a.png",
    "http://0.0.0.0/a.png",
    "http://[::1]/a.png",
    "http://[::]/a.png",
    "http://[fc00::1]/a.png",
    "http://[fe80::1]/a.png",
    "http://[::ffff:127.0.0.1]/a.png",
    "http://[::ffff:7f00:1]/a.png",
    "http://[64:ff9b::a01:203]/a.png",
    "http://0x7f.1/a.png",
  ])("blocks %s", async (u) => {
    expect(await prod(u)).toEqual({ ok: false, reason: "blocked_address" });
  });

  it("allows public literals", async () => {
    expect((await prod("http://203.0.113.7/a.png")).ok).toBe(true);
    expect((await prod("http://[::ffff:cb00:7107]/a.png")).ok).toBe(true);
  });

  it("blocks a name that resolves to a private address", async () => {
    expect(await prod("https://img.example/a.png", { lookup: lookupTo("10.0.0.5") })).toEqual({ ok: false, reason: "blocked_address" });
  });

  it("blocks when any resolved address is private", async () => {
    expect(await prod("https://img.example/a.png", { lookup: lookupTo("203.0.113.7", "10.0.0.5") })).toEqual({ ok: false, reason: "blocked_address" });
  });

  it("reports unresolvable names", async () => {
    const lookup: LookupAll = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await prod("https://img.example/a.png", { lookup })).toEqual({ ok: false, reason: "unresolvable" });
    expect(await prod("https://img.example/a.png", { lookup: async () => [] })).toEqual({ ok: false, reason: "unresolvable" });
  });

  it("allows a name that resolves to a public address", async () => {
    const seen: string[] = [];
    expect((await prod("https://img.example/a.png", { lookup: lookupTo("203.0.113.7"), fetchImpl: fakeFetch(seen) })).ok).toBe(true);
    expect(seen).toEqual(["https://img.example/a.png"]);
  });
});

describe("issuer same-host exemption", () => {
  const P = { ...PRODUCTION_AVATAR_FETCH_POLICY };
  const go = (issuer: string, url: string, over: Partial<Parameters<typeof fetchOidcAvatar>[1]> = {}) =>
    fetchOidcAvatar(url, { issuer, policy: P, fetchImpl: fakeFetch(), lookup: lookupTo("203.0.113.7"), ...over });

  it("skips the address check for the issuer's own host", async () => {
    expect((await go("http://192.168.1.10:8080", "http://192.168.1.10:8080/a.png")).ok).toBe(true);
  });

  it("compares hosts case-insensitively", async () => {
    expect((await go("http://IdP.Example:8080", "http://idp.example:8080/a.png", { lookup: lookupTo("10.0.0.5") })).ok).toBe(true);
  });

  it("treats port 0 as a bad port when the issuer is not a URL", async () => {
    expect(await go("not a url", "http://img.example:0/a.png")).toEqual({ ok: false, reason: "bad_port" });
  });

  it("does not exempt a different string that is the same IP", async () => {
    expect(await go("http://localhost:9400", "http://127.0.0.1:9400/a.png", { lookup: lookupTo("127.0.0.1") })).toEqual({ ok: false, reason: "blocked_address" });
  });

  it("does not exempt subdomains", async () => {
    expect(await go("http://idp.example", "http://img.idp.example/a.png", { lookup: lookupTo("10.0.0.5") })).toEqual({ ok: false, reason: "blocked_address" });
  });

  it("does not exempt suffix look-alikes", async () => {
    expect(await go("http://idp.example", "http://evilidp.example/a.png", { lookup: lookupTo("10.0.0.5") })).toEqual({ ok: false, reason: "blocked_address" });
  });

  it("does not exempt a redirect to another host", async () => {
    const f: typeof fetch = async () => new Response(null, { status: 302, headers: { location: "http://10.0.0.9/a.png" } });
    expect(await go("http://192.168.1.10:8080", "http://192.168.1.10:8080/a.png", { fetchImpl: f })).toEqual({ ok: false, reason: "blocked_address" });
  });

  it("still enforces port and scheme on the exempt host", async () => {
    expect(await go("http://192.168.1.10:8080", "http://192.168.1.10:9999/a.png")).toEqual({ ok: false, reason: "bad_port" });
    expect(await go("http://192.168.1.10:8080", "ftp://192.168.1.10:8080/a.png")).toEqual({ ok: false, reason: "bad_scheme" });
  });

  it("allows the exempt host on 80 and 443 (known residual)", async () => {
    expect((await go("http://192.168.1.10:8080", "http://192.168.1.10/a.png")).ok).toBe(true);
    expect((await go("http://192.168.1.10:8080", "https://192.168.1.10/a.png")).ok).toBe(true);
  });
});
