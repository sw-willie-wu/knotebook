import { describe, expect, it } from "vitest";
import { OIDC_PENDING_MAX_COOKIE_BYTES, newPendingId, pendingCookieBytes, sealPendingLink, sealPendingLinkWithinLimit, unsealPendingLink, type PendingLinkPayload } from "../../src/auth/oidc-pending.js";
import { unsealOidcState } from "../../src/auth/oidc-state.js";
import { sealCookieJson } from "../../src/auth/sealed-cookie.js";

const S = "a".repeat(64);
const NOW = 1_790_000_000;
/** 其餘欄位全取上限（spec §7.5.1／r3-M3）：issuer 512、sub 255、email 254、三個 id 36、pendingId 22。 */
function worst(next?: string): PendingLinkPayload {
  return {
    pendingId: newPendingId(),
    issuer: "https://" + "i".repeat(504),
    sub: "s".repeat(255),
    providerId: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    email: "e".repeat(242) + "@example.com",
    exp: NOW + 900,
    ...(next !== undefined ? { next } : {}),
  };
}

describe("pending-link cookie（#187 §7.5.1）", () => {
  it("往返；pendingId 是 22 字元 base64url（128 bit）；exp ≤ now → null；竄改 → null；壞 next 型別 → null", () => {
    const p = worst("/n/alice/x");
    expect(p.pendingId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const sealed = sealPendingLink(S, p);
    expect(unsealPendingLink(S, sealed, NOW)).toEqual(p);
    expect(unsealPendingLink(S, sealed, p.exp)).toBeNull();
    // 竄改：確定性地換掉 ct 的第一個 base64url 字元（`slice(0,-2)+"AA"` 約 1/256 機率等於沒改，gate r1 m3）。
    const [ivPart, ctPart, tagPart] = sealed.split(".");
    const flipped = (ctPart![0] === "A" ? "B" : "A") + ctPart!.slice(1);
    expect(unsealPendingLink(S, `${ivPart}.${flipped}.${tagPart}`, NOW)).toBeNull();
    expect(unsealPendingLink(S, sealPendingLink(S, { ...p, next: 7 as unknown as string }), NOW)).toBeNull();
    expect(unsealPendingLink(S, sealPendingLink(S, { ...p, userId: undefined as unknown as string }), NOW)).toBeNull();
  });

  it("namespace 隔離：state cookie 的密文不能當 pending 用，反之亦然", () => {
    // 用 sealCookieJson 直接以 "oidc-state" namespace 封（與 sealOidcState 逐位元組同形）：不綁 OidcStatePayload 的型別，
    // Task 8 給 state payload 加必要欄位時本檔不必跟著改。
    const state = sealCookieJson(S, "oidc-state", { state: "a", nonce: "b", codeVerifier: "c", exp: NOW + 600 });
    expect(unsealPendingLink(S, state, NOW)).toBeNull();
    expect(unsealOidcState(S, sealPendingLink(S, worst()), NOW)).toBeNull();
    // 承重的一條（gate r1 t1-7 I4）：在 "oidc-state" namespace 下封一顆**欄位齊全的 pending payload**——只有 namespace 擋得住它。
    // 上面兩條在 pending 的 NAMESPACE 被改成 "oidc-state" 時照樣 null（解得開，但被欄位檢查擋下），證明不了隔離。
    expect(unsealPendingLink(S, sealCookieJson(S, "oidc-state", worst()), NOW)).toBeNull();
  });

  it("量測守衛①：next 2048＋其餘上限 → 捨棄 next，name=value < 3800（實測約 1671）", () => {
    const next = "/" + "a".repeat(2047);
    const r = sealPendingLinkWithinLimit(S, worst(next));
    expect(r).not.toBeNull();
    expect(r!.droppedNext).toBe(true);
    expect(unsealPendingLink(S, r!.sealed, NOW)!.next).toBeUndefined();
    expect(pendingCookieBytes(r!.sealed)).toBeLessThan(OIDC_PENDING_MAX_COOKIE_BYTES);
  });

  it("量測守衛②：next 1500（剛好放得下）＋其餘上限 → next 真的進了 cookie，且 < 3800（實測 3684；臨界值 1587）", () => {
    const next = "/" + "a".repeat(1499);
    const r = sealPendingLinkWithinLimit(S, worst(next));
    expect(r!.droppedNext).toBe(false);
    // 先釘住「真的進去了」——否則 next 被丟掉時下一條上界反而更綠（knotebook-return-to-wiring「單向上界」教訓）。
    expect(unsealPendingLink(S, r!.sealed, NOW)!.next).toBe(next);
    expect(pendingCookieBytes(r!.sealed)).toBeLessThan(OIDC_PENDING_MAX_COOKIE_BYTES);
  });

  it("防禦縱深：捨棄 next 後仍超過（例如 issuer 6000 字，正常到不了）→ null（不封章）", () => {
    expect(sealPendingLinkWithinLimit(S, { ...worst("/x"), issuer: "https://" + "i".repeat(6000) })).toBeNull();
  });
});
