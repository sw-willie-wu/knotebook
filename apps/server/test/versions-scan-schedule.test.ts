// #272 §7.4：app.ts 的自動切版掃描排程——startVersionSweep 開著才排；每個間隔一輪；onClose 清計時器並等進行中那一輪。
import { describe, expect, it } from "vitest";
import { markPending } from "../src/collab/versions.js";
import type { Db } from "../src/db/index.js";
import { seedDoc } from "./copy-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { paraDoc, versionsOf } from "./version-helpers.js";

/** 一篇有內容、待切時刻在 6 分鐘前（站台設定 X＝5 分鐘 → 已到期）的筆記。 */
async function duePending(db: Db, ownerId: string, text: string): Promise<string> {
  const n = await seedNote(db, { ownerId });
  await seedDoc(db, n.id, paraDoc([text]));
  await markPending(db, { noteId: n.id, at: new Date(Date.now() - 6 * 60_000), add: [{ user_id: ownerId, agent_label: null }], ref: null, spaceKey: `u:${ownerId}` });
  return n.id;
}

describe("自動切版掃描排程（§7.4）", () => {
  it("startVersionSweep＋versionAutoScanIntervalMs → 定時掃描切到期的筆記；app.close() 之後不再掃", async () => {
    const { app, db } = await buildTestApp({ startVersionSweep: true, versionAutoScanIntervalMs: 50 });
    const u = await seedUser(db);
    const a = await duePending(db, u.id, "排程切的");
    await expect.poll(async () => (await versionsOf(db, a)).length, { timeout: 5_000 }).toBe(1);
    await app.close();
    const b = await duePending(db, u.id, "關了之後");
    await new Promise(r => setTimeout(r, 300));
    expect(await versionsOf(db, b)).toEqual([]);
  });

  it("沒有 startVersionSweep（測試 app 的預設）→ 不排程", async () => {
    const { app, db } = await buildTestApp({ versionAutoScanIntervalMs: 50 });
    const u = await seedUser(db);
    const a = await duePending(db, u.id, "沒有排程");
    await new Promise(r => setTimeout(r, 300));
    expect(await versionsOf(db, a)).toEqual([]);
    await app.close();
  });
});
