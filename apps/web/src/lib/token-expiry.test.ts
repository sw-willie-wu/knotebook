import { describe, expect, it } from "vitest";
import { OAUTH_APP_IDLE_DAYS, type ApiTokenDto } from "@knotebook/shared";
import { displayExpiry } from "./token-expiry";

const DAY = 86_400_000;
const base: ApiTokenDto = {
  id: "t",
  kind: "oauth",
  name: "n",
  agentLabel: "n",
  scope: "notes:read",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: "2026-01-10T00:00:00.000Z",
  expiresAt: "2026-01-11T00:00:00.000Z",
  clientId: "c",
};
const plus = (iso: string, days: number): string => new Date(Date.parse(iso) + days * DAY).toISOString();

describe("displayExpiry（#298）", () => {
  it("pat：expiresAt 為 null → null；有值 → 原樣，不受 lastUsedAt 影響（AC6）", () => {
    const pat: ApiTokenDto = { ...base, kind: "pat", clientId: null, lastUsedAt: "2026-01-05T00:00:00.000Z" };
    expect(displayExpiry({ ...pat, expiresAt: null }, OAUTH_APP_IDLE_DAYS)).toBeNull();
    expect(displayExpiry({ ...pat, expiresAt: "2027-03-04T05:06:07.000Z" }, OAUTH_APP_IDLE_DAYS)).toBe("2027-03-04T05:06:07.000Z");
  });

  it("oauth：lastUsedAt + N 天（createdAt 不參與，AC3）", () => {
    expect(displayExpiry(base, OAUTH_APP_IDLE_DAYS)).toBe(plus("2026-01-10T00:00:00.000Z", OAUTH_APP_IDLE_DAYS));
  });

  it("oauth：lastUsedAt 為 null → createdAt + N 天（AC3）", () => {
    const row = { ...base, lastUsedAt: null, expiresAt: "2026-01-02T12:00:00.000Z" };
    expect(displayExpiry(row, OAUTH_APP_IDLE_DAYS)).toBe(plus("2026-01-01T00:00:00.000Z", OAUTH_APP_IDLE_DAYS));
  });

  it("oauth：結果與 expiresAt 無關（AC4）", () => {
    const expected = plus("2026-01-10T00:00:00.000Z", OAUTH_APP_IDLE_DAYS);
    expect(displayExpiry({ ...base, expiresAt: "2020-01-01T00:00:00.000Z" }, OAUTH_APP_IDLE_DAYS)).toBe(expected);
    expect(displayExpiry({ ...base, expiresAt: null }, OAUTH_APP_IDLE_DAYS)).toBe(expected);
  });
});
