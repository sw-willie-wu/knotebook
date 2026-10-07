import { describe, expect, it, vi } from "vitest";
import { siteSettings } from "../src/db/schema.js";
import {
  PASSWORD_LOGIN_FORCED_LOG,
  PASSWORD_LOGIN_FORCED_NOOP_LOG,
  PASSWORD_LOGIN_LOCKOUT_LOG,
  warnPasswordLoginAtBoot,
} from "../src/auth/password-login.js";
import { buildTestApp } from "./helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";

const fakeLogger = () => ({ warn: vi.fn(), error: vi.fn() });

describe("warnPasswordLoginAtBoot（#187 §10.4：不擋啟動，只寫 log）", () => {
  it("預設（DB 開、env 未設）→ 一行都不印", async () => {
    const { db } = await buildTestApp();
    const logger = fakeLogger();
    await warnPasswordLoginAtBoot(db, { passwordLoginForceEnable: false }, logger);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("env 強制＋DB 關 → warn「regardless of the Site admin setting」；env 強制＋DB 開 → warn「has no effect」", async () => {
    const { db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: "https://idp.example" });
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    const off = fakeLogger();
    await warnPasswordLoginAtBoot(db, { passwordLoginForceEnable: true }, off);
    expect(off.warn.mock.calls).toEqual([[PASSWORD_LOGIN_FORCED_LOG]]);
    expect(off.error).not.toHaveBeenCalled();

    await db.update(siteSettings).set({ passwordLoginEnabled: true });
    const on = fakeLogger();
    await warnPasswordLoginAtBoot(db, { passwordLoginForceEnable: true }, on);
    expect(on.warn.mock.calls).toEqual([[PASSWORD_LOGIN_FORCED_NOOP_LOG]]);
  });

  it("有效值關＋零個啟用 provider（只可能是手改 DB，INV-8）→ error 一行；有啟用 provider 時不印", async () => {
    const { db } = await buildTestApp();
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    const none = fakeLogger();
    await warnPasswordLoginAtBoot(db, { passwordLoginForceEnable: false }, none);
    expect(none.error.mock.calls).toEqual([[PASSWORD_LOGIN_LOCKOUT_LOG]]);

    await seedAuthProvider(db, { issuerUrl: "https://idp.example" });
    const one = fakeLogger();
    await warnPasswordLoginAtBoot(db, { passwordLoginForceEnable: false }, one);
    expect(one.error).not.toHaveBeenCalled();
    expect(one.warn).not.toHaveBeenCalled();
  });

  it("只有停用的 provider 不算（enabled 為假）→ 仍 error", async () => {
    const { db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: "https://other.example", enabled: false, clientSecret: null });
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    const logger = fakeLogger();
    await warnPasswordLoginAtBoot(db, { passwordLoginForceEnable: false }, logger);
    expect(logger.error.mock.calls).toEqual([[PASSWORD_LOGIN_LOCKOUT_LOG]]);
  });

  it("env 強制時即使 DB 關＋零 provider 也不印 error（有效值是開）", async () => {
    const { db } = await buildTestApp();
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    const logger = fakeLogger();
    await warnPasswordLoginAtBoot(db, { passwordLoginForceEnable: true }, logger);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls).toEqual([[PASSWORD_LOGIN_FORCED_LOG]]);
  });
});
