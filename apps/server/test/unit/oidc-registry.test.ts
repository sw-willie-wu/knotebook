import { describe, expect, it } from "vitest";
import type { CustomFetch } from "openid-client";
import { OidcUnavailableError, createOidcRuntimeRegistry, type OidcRuntimeKey } from "../../src/auth/oidc-client.js";
import { createFakeIdp } from "../helpers/fake-idp.js";

const ISSUER = "https://idp.example.com";
const key = (over: Partial<OidcRuntimeKey> = {}): OidcRuntimeKey => ({ id: "p1", issuerUrl: ISSUER, clientId: "c", configVersion: 1, ...over });

describe("createOidcRuntimeRegistry（#187 §6）", () => {
  it("同 (id, configVersion) → 快取（discovery 一次、loadSecret 一次、同一個 Configuration）", async () => {
    const idp = createFakeIdp(ISSUER);
    const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
    let loads = 0;
    const load = async () => { loads += 1; return "s"; };
    const a = await registry.get(key(), load);
    const b = await registry.get(key(), load);
    expect(b).toBe(a);
    expect(idp.counts.discovery).toBe(1);
    expect(loads).toBe(1);
  });

  it("configVersion 變了 → 重新 discovery、重新 loadSecret（invalidate 漏叫也自癒）", async () => {
    const idp = createFakeIdp(ISSUER);
    const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
    let loads = 0;
    const load = async () => { loads += 1; return "s"; };
    const a = await registry.get(key(), load);
    const b = await registry.get(key({ configVersion: 2 }), load);
    expect(b).not.toBe(a);
    expect(idp.counts.discovery).toBe(2);
    expect(loads).toBe(2);
  });

  it("invalidate(id) → 下一次重新 discovery", async () => {
    const idp = createFakeIdp(ISSUER);
    const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
    await registry.get(key(), async () => "s");
    registry.invalidate("p1");
    await registry.get(key(), async () => "s");
    expect(idp.counts.discovery).toBe(2);
  });

  it("首波併發共用同一次 discovery（in-flight 去重保留）", async () => {
    const idp = createFakeIdp(ISSUER);
    const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
    await Promise.all([1, 2, 3].map(() => registry.get(key(), async () => "s")));
    expect(idp.counts.discovery).toBe(1);
  });

  it("loadSecret 失敗 → OidcUnavailableError，且不快取（下一次重試會再 loadSecret）", async () => {
    const idp = createFakeIdp(ISSUER);
    const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
    await expect(registry.get(key(), async () => { throw new Error("undecryptable"); })).rejects.toBeInstanceOf(OidcUnavailableError);
    let loads = 0;
    await registry.get(key(), async () => { loads += 1; return "s"; });
    expect(loads).toBe(1);
  });

  it("同一個 configVersion、issuerUrl 換了 → 重新 discovery、拿到新 issuer 的 Configuration；clientId 換了 → 也重建（防禦縱深，gate r1 m1）", async () => {
    const ISSUER2 = "https://idp2.example.com";
    const idp1 = createFakeIdp(ISSUER);
    const idp2 = createFakeIdp(ISSUER2);
    // 兩份 fake IdP 共用一個 fetch：依 host 分派（不靠尾斜線的 issuer 比對細節）。
    const fetch: CustomFetch = (url, options) => (String(url).startsWith(`${ISSUER2}/`) ? idp2 : idp1).fetch(url, options);
    const registry = createOidcRuntimeRegistry({ fetch });
    const a = await registry.get(key(), async () => "s");
    expect(a.serverMetadata().issuer).toBe(ISSUER);
    const b = await registry.get(key({ issuerUrl: ISSUER2 }), async () => "s");
    expect(b.serverMetadata().issuer).toBe(ISSUER2);
    expect(idp1.counts.discovery + idp2.counts.discovery).toBe(2);
    const c = await registry.get(key({ issuerUrl: ISSUER2, clientId: "other-client" }), async () => "s");
    expect(c).not.toBe(b);
    expect(idp2.counts.discovery).toBe(2);
  });

  it("metadata.issuer 超過 512 字 → OidcUnavailableError（不快取；r3-M3 的 issuer 上界）", async () => {
    const longIssuer = `https://idp.example.com/${"x".repeat(500)}`;
    expect(longIssuer.length).toBeGreaterThan(512);
    const idp = createFakeIdp(longIssuer);
    const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
    await expect(registry.get(key({ issuerUrl: longIssuer }), async () => "s")).rejects.toBeInstanceOf(OidcUnavailableError);
    await expect(registry.get(key({ issuerUrl: longIssuer }), async () => "s")).rejects.toBeInstanceOf(OidcUnavailableError);
    expect(idp.counts.discovery).toBe(2);
  });
});
