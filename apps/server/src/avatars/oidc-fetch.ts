/**
 * 下載 IdP 的 `picture` 網址（不受信任的輸入，連線目標由 IdP 的使用者資料決定）。
 *
 * 威脅與界線：
 * - 伺服器端請求偽造：網址可以指向內網、本機、雲端中繼資料位址。每一跳（起始網址與每個重導）
 *   都先驗 scheme、埠，再把主機解析成位址，**任一**位址落在特殊用途範圍就拒絕。
 * - 重導：手動跟，最多 3 跳；每一跳重新套用全部檢查。
 * - 帳密：網址含 userinfo 的任何一跳在連線前拒絕。
 * - 資源耗盡：同一個逾時涵蓋解析、每一跳與讀 body；body 邊讀邊計數，超過上限立刻中止；
 *   content-type 不是三種點陣圖就不讀 body。
 * - 格式：最後仍以 magic bytes 判斷，GIF 與其他格式一律拒絕。
 * - 不帶 cookie、Authorization。
 * - 失敗原因是固定字串；底層錯誤（內建 fetch 的 TypeError 會帶完整網址，含密碼與 query）
 *   的訊息不回傳、不記錄。
 *
 * 豁免：圖片網址的主機名與 issuer 的主機名逐字相同（URL 已轉小寫）時，略過位址檢查——
 * 自架 IdP 常把頭貼放在自己的內網位址上。只比主機字串：不比子網域、後綴，也不比「解析到同一個
 * IP」。scheme 與埠仍照常檢查；重導到別的主機則回到位址檢查。
 *
 * 已知殘留：
 * - DNS rebinding：解析與連線是兩次查詢，攻擊者控制的 DNS 可在兩者之間換答案。
 * - 豁免主機的 80／443（以及 issuer 的埠）上的任何服務都可被探測。
 */
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { MAX_OIDC_AVATAR_BYTES } from "@knotebook/shared";
import { detectImageMimeType } from "../uploads/magic-bytes.js";

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
  // NAT64（64:ff9b::/96）內嵌的 IPv4 走同一份清單。
  blocked.addSubnet("64:ff9b::" + net, 96 + prefix, "ipv6");
}
for (const [net, prefix] of [
  ["::", 96], // 未指定、迴路與已廢止的 IPv4 相容形
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

function productionAddressBlocked(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) return blocked.check(ip, "ipv6"); // IPv4-mapped 形由 BlockList 依 IPv4 規則比對
  return true; // 認不得的形一律當作擋
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

/** 去掉 IPv6 字面值的方括號。 */
function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * `dns.lookup` 不收 signal：與 abort 賽跑。被丟下的 lookup 仍佔著 threadpool 直到自己結束。
 */
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
    // issuer 不是網址：沒有豁免。
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
      const mime = detectImageMimeType(bytes);
      if (mime === null || mime === "image/gif") throw new Fail("not_image");
      return { ok: true, bytes, mime, finalUrl: current.href };
    }
  } catch (e) {
    if (e instanceof Fail) return { ok: false, reason: e.reason };
    return { ok: false, reason: signal.aborted ? "timeout" : "network" };
  }
}
