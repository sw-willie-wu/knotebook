/**
 * Downloads an IdP `picture` URL (untrusted: the target comes from the IdP's profile). SSRF: every hop (start URL and each redirect,
 * followed manually, max 3, all checks repeated) checks scheme and port, resolves the host and refuses if ANY address is special-use;
 * userinfo is refused before connecting; no cookies or Authorization are sent. One timeout covers resolution, every hop and the
 * body read; the body is counted while read and aborted at the cap; a content-type other than the three bitmap types is never
 * read; the final check is by magic bytes (GIF refused). Failure reasons are fixed strings: the built-in fetch's TypeError
 * carries the full URL (password and query), so underlying errors are neither returned nor logged.
 * Exemption: a host equal to the issuer's (URL already lowercased) skips the address check, since self-hosted IdPs serve avatars
 * from internal addresses; only the host string is compared (no subdomain, suffix or same-IP matching), scheme and port are still
 * checked, and a redirect to another host is address-checked again.
 * Known residual risk: DNS rebinding (resolve and connect are separate lookups), and probing of services on the exempt host's 80/443/issuer port.
 */
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { MAX_OIDC_AVATAR_BYTES } from "@knotebook/shared";
import { detectRasterImageMimeType } from "../uploads/magic-bytes.js";

export type AvatarFetchFailure =
  | "bad_scheme"
  | "bad_port"
  | "credentials"
  | "blocked_address"
  | "unresolvable"
  | "too_many_redirects"
  | "timeout"
  | "http_status"
  | "bad_content_type"
  | "too_large"
  | "not_image"
  | "network";

export interface AvatarFetchPolicy {
  portAllowed(port: number, issuerPort: number): boolean;
  addressBlocked(ip: string): boolean;
}

export type LookupAll = (
  host: string,
  opts: { all: true; verbatim: true },
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export type OidcAvatarMime = "image/png" | "image/jpeg" | "image/webp";

export type OidcAvatarFetchResult =
  | { ok: true; bytes: Buffer; mime: OidcAvatarMime; finalUrl: string }
  | { ok: false; reason: AvatarFetchFailure };

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const ALLOWED_TYPES = new Set<string>(["image/png", "image/jpeg", "image/webp"]);

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
  blocked.addSubnet("64:ff9b::" + net, 96 + prefix, "ipv6");
}
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback and deprecated IPv4-compatible forms
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

function productionAddressBlocked(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) return blocked.check(ip, "ipv6"); // BlockList matches IPv4-mapped forms by the IPv4 rules
  // Unrecognized address form: block (fail closed).
  return true;
}

export const PRODUCTION_AVATAR_FETCH_POLICY: AvatarFetchPolicy = {
  portAllowed: (port, issuerPort) => port === 80 || port === 443 || port === issuerPort,
  addressBlocked: productionAddressBlocked,
};

function effectivePort(u: URL): number {
  if (u.port) return Number(u.port);
  return u.protocol === "https:" ? 443 : 80;
}

class Fail extends Error {
  constructor(readonly reason: AvatarFetchFailure) {
    super(reason);
  }
}

function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** `dns.lookup` ignores `signal`, so race it against abort; an abandoned lookup still holds a threadpool slot until it finishes. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  p.catch(() => undefined);
  if (signal.aborted) return Promise.reject(new Fail("timeout"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Fail("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error("lookup failed"));
      },
    );
  });
}

async function checkAddress(
  url: URL,
  issuerHost: string | null,
  policy: AvatarFetchPolicy,
  lookup: LookupAll,
  signal: AbortSignal,
): Promise<void> {
  if (issuerHost !== null && url.hostname === issuerHost) return;
  const host = bareHost(url.hostname);
  if (isIP(host)) {
    if (policy.addressBlocked(host)) throw new Fail("blocked_address");
    return;
  }
  let addrs: ReadonlyArray<{ address: string }>;
  try {
    addrs = await raceAbort(lookup(host, { all: true, verbatim: true }), signal);
  } catch (e) {
    if (e instanceof Fail) throw e;
    throw new Fail("unresolvable");
  }
  if (addrs.length === 0) throw new Fail("unresolvable");
  for (const a of addrs) if (policy.addressBlocked(a.address)) throw new Fail("blocked_address");
}

async function readBody(res: Response): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_OIDC_AVATAR_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new Fail("too_large");
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_OIDC_AVATAR_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Fail("too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export async function fetchOidcAvatar(
  url: string,
  opts: {
    issuer: string;
    policy: AvatarFetchPolicy;
    lookup?: LookupAll;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<OidcAvatarFetchResult> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const lookup = opts.lookup ?? ((host, o) => dnsLookup(host, o));
  const doFetch = opts.fetchImpl ?? fetch;
  let issuerHost: string | null = null;
  let issuerPort = -1;
  try {
    const iu = new URL(opts.issuer);
    issuerHost = iu.hostname;
    issuerPort = effectivePort(iu);
  } catch {
    // The issuer isn't a URL: no exemption.
  }
  try {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      throw new Fail("bad_scheme");
    }
    for (let hop = 0; ; hop++) {
      if (current.protocol !== "http:" && current.protocol !== "https:") throw new Fail("bad_scheme");
      if (current.username || current.password) throw new Fail("credentials");
      if (!opts.policy.portAllowed(effectivePort(current), issuerPort)) throw new Fail("bad_port");
      await checkAddress(current, issuerHost, opts.policy, lookup, signal);
      let res: Response;
      try {
        res = await doFetch(current.href, {
          redirect: "manual",
          signal,
          headers: { accept: "image/png,image/jpeg,image/webp" },
        });
      } catch {
        throw new Fail(signal.aborted ? "timeout" : "network");
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get("location");
        if (!location) throw new Fail("http_status");
        if (hop >= MAX_REDIRECTS) throw new Fail("too_many_redirects");
        try {
          current = new URL(location, current);
        } catch {
          throw new Fail("http_status");
        }
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel().catch(() => undefined);
        throw new Fail("http_status");
      }
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!ALLOWED_TYPES.has(type)) {
        await res.body?.cancel().catch(() => undefined);
        throw new Fail("bad_content_type");
      }
      let bytes: Buffer;
      try {
        bytes = await readBody(res);
      } catch (e) {
        if (e instanceof Fail) throw e;
        throw new Fail(signal.aborted ? "timeout" : "network");
      }
      const mime = detectRasterImageMimeType(bytes);
      if (mime === null || mime === "image/gif") throw new Fail("not_image");
      return { ok: true, bytes, mime, finalUrl: current.href };
    }
  } catch (e) {
    if (e instanceof Fail) return { ok: false, reason: e.reason };
    return { ok: false, reason: signal.aborted ? "timeout" : "network" };
  }
}
