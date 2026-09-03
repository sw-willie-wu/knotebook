import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb } from "./helpers.js";
import { UserGate, type GateRow } from "../src/auth/session.js";
import { users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";

async function insertUser(
  db: Db,
  overrides: Partial<{
    email: string;
    displayName: string;
    isAdmin: boolean;
    tokenVersion: number;
    disabledAt: Date | null;
    passwordHash: string | null;
  }> = {}
) {
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: overrides.displayName ?? "Test User",
      isAdmin: overrides.isAdmin ?? false,
      tokenVersion: overrides.tokenVersion ?? 0,
      disabledAt: overrides.disabledAt ?? null,
      passwordHash: overrides.passwordHash ?? null,
    })
    .returning();
  return u;
}

describe("UserGate", () => {
  it("check ok：回完整 user 物件（含 isAdmin）", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { isAdmin: true, tokenVersion: 3 });
    const gate = new UserGate(db);
    const result = await gate.check(u.id, 3);
    expect(result).toEqual({
      status: "ok",
      user: { id: u.id, email: u.email, handle: u.handle, displayName: u.displayName, isAdmin: true, mustChangePassword: false, hasPassword: false },
    });
  });

  it("hasPassword：OIDC-only（無 passwordHash）→ false（經真 DB 走 fetchRowFromDb 投影）", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 0, passwordHash: null });
    const gate = new UserGate(db);
    const result = await gate.check(u.id, 0);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.user.hasPassword).toBe(false);
    }
  });

  it("hasPassword：有 passwordHash → true（經真 DB 走 fetchRowFromDb 投影）", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 0, passwordHash: "some-argon2-hash" });
    const gate = new UserGate(db);
    const result = await gate.check(u.id, 0);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.user.hasPassword).toBe(true);
    }
  });

  it("tv 不符 → revoked", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 3 });
    const gate = new UserGate(db);
    expect(await gate.check(u.id, 2)).toEqual({ status: "revoked" });
  });

  it("disabledAt 設定 → revoked", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 0, disabledAt: new Date() });
    const gate = new UserGate(db);
    expect(await gate.check(u.id, 0)).toEqual({ status: "revoked" });
  });

  it("user 不存在 → revoked", async () => {
    const { db } = await freshDb();
    const gate = new UserGate(db);
    expect(await gate.check("00000000-0000-0000-0000-000000000000", 0)).toEqual({ status: "revoked" });
  });

  it("快取命中路徑仍比對 tv（同一快取窗口內，換一個不符的 tv 仍須 revoked）", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 3 });
    const gate = new UserGate(db);

    expect((await gate.check(u.id, 3)).status).toBe("ok"); // 建立快取（row.tokenVersion=3）
    expect((await gate.check(u.id, 2)).status).toBe("revoked"); // 快取命中，但傳入 tv 不符，仍須 revoked
  });

  it("快取行為：check ok 後直改 DB tv 仍 ok（快取命中）；invalidate 後重讀 DB → revoked", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 0 });
    const gate = new UserGate(db);

    expect((await gate.check(u.id, 0)).status).toBe("ok");

    await db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, u.id));
    expect((await gate.check(u.id, 0)).status).toBe("ok"); // 快取命中，未重讀 DB

    gate.invalidate(u.id);
    expect((await gate.check(u.id, 0)).status).toBe("revoked"); // invalidate 後重讀 DB
  });

  it("TTL 過期後重讀 DB", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 0 });
    let now = 1_000_000;
    const gate = new UserGate(db, { now: () => now });

    expect((await gate.check(u.id, 0)).status).toBe("ok");

    await db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, u.id));
    expect((await gate.check(u.id, 0)).status).toBe("ok"); // 尚未過 TTL，快取命中

    now += 61_000; // 前進 61s，超過 60s TTL
    expect((await gate.check(u.id, 0)).status).toBe("revoked"); // TTL 過期，重讀 DB
  });

  it("LRU 上限：塞滿後最舊被淘汰，再 check 會重讀 DB", async () => {
    const { db } = await freshDb();
    const u1 = await insertUser(db, { tokenVersion: 0 });
    const u2 = await insertUser(db, { tokenVersion: 0 });
    const u3 = await insertUser(db, { tokenVersion: 0 });
    const gate = new UserGate(db, { maxEntries: 2 });

    expect((await gate.check(u1.id, 0)).status).toBe("ok"); // cache: [u1]
    expect((await gate.check(u2.id, 0)).status).toBe("ok"); // cache: [u1, u2]

    // 繞過 gate 直接改 DB，若 u1 仍被快取，之後 check 不會看到這個變更
    await db.update(users).set({ tokenVersion: 99 }).where(eq(users.id, u1.id));

    expect((await gate.check(u3.id, 0)).status).toBe("ok"); // cache 滿，淘汰最舊的 u1 → cache: [u2, u3]

    // 驗證被淘汰的「只有」最舊的 u1，u2 仍留在快取內——防「滿了就整個清空」的錯誤實作。
    // 繞過 gate 直接改 u2 的 DB row；u2 若真的還被快取（正確行為），check 應該回傳
    // 快取內的舊快照（ok，仍是 tv=0），完全看不到這次的變更；若 check 卻讀到新值
    // （tokenVersion=55，與傳入的 tv=0 不符 → revoked），代表 u2 被誤淘汰了。
    // 注意：這個斷言必須在「check u1」之前做——maxEntries=2 時 cache 淘汰後仍維持
    // 滿載（[u2, u3]），若先 check u1（cache miss，觸發 store 導致再淘汰一次），
    // 會把 u2 也擠出快取，讓這裡的驗證失去意義。
    await db.update(users).set({ tokenVersion: 55 }).where(eq(users.id, u2.id));
    expect((await gate.check(u2.id, 0)).status).toBe("ok");

    // u1 已被淘汰，重讀 DB 應看到 tokenVersion=99，與傳入的 tv=0 不符 → revoked
    expect((await gate.check(u1.id, 0)).status).toEqual("revoked");
  });

  it("invalidate 與 in-flight fetch 的 race：查詢中被 invalidate，完成的舊結果不落快取", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 0 });

    let firstFetchStarted = false;
    let resolveSlowFetch!: (row: GateRow | null) => void;
    const slowFetch = new Promise<GateRow | null>(resolve => {
      resolveSlowFetch = resolve;
    });

    let callCount = 0;
    const gate = new UserGate(db, {
      fetchRow: async userId => {
        callCount++;
        if (callCount === 1) {
          firstFetchStarted = true;
          return slowFetch; // 卡住，直到測試手動 resolve，模擬「查詢中」的窗口
        }
        // 第二次以後照常查真正的 DB（模擬 invalidate 後的下一次 check）
        const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        const row = rows[0];
        return row
          ? {
              id: row.id,
              email: row.email,
              handle: row.handle,
              displayName: row.displayName,
              isAdmin: row.isAdmin,
              disabledAt: row.disabledAt,
              tokenVersion: row.tokenVersion,
              mustChangePassword: row.mustChangePassword,
              hasPassword: row.passwordHash !== null,
            }
          : null;
      },
    });

    const firstCheck = gate.check(u.id, 0); // 觸發第一次（卡住的）查詢
    expect(firstFetchStarted).toBe(true);

    // 此時 cache 裡還沒有 u 的條目（第一次查詢還沒回來）——invalidate 的 cache.delete
    // 是 no-op，但 gen 會遞增；這正是要保護的 race window。
    gate.invalidate(u.id);

    // 讓卡住的第一次查詢完成，回傳「撤銷前」查到的舊資料
    resolveSlowFetch({
      id: u.id,
      email: u.email,
      handle: u.handle,
      displayName: u.displayName,
      isAdmin: false,
      disabledAt: null,
      tokenVersion: 0,
      mustChangePassword: false,
      hasPassword: false,
    });
    const first = await firstCheck;
    expect(first.status).toBe("ok"); // 這次呼叫本身仍用它查到的資料正確回答

    // 關鍵斷言：若沒有 generation guard，上面那次「舊 fetch」的結果會被寫進快取並帶 60s TTL，
    // 讓 invalidate 被靜默蓋掉。真正撤銷（tokenVersion 改變）後，下一次 check 必須重讀 DB。
    await db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, u.id));
    const second = await gate.check(u.id, 0);
    expect(second.status).toBe("revoked");
  });
});

describe("UserGate.checkUser（#107：token 路徑的使用者狀態閘）", () => {
  it("D3：tokenVersion 改變不影響（改密碼不作廢 API token）", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 3 });
    const gate = new UserGate(db);

    expect((await gate.checkUser(u.id)).status).toBe("ok");

    await db.update(users).set({ tokenVersion: 4 }).where(eq(users.id, u.id));
    gate.invalidate(u.id);

    // session 路徑（check）拿舊 tv 會被拒；token 路徑（checkUser）不受影響。
    expect((await gate.check(u.id, 3)).status).toBe("revoked");
    expect((await gate.checkUser(u.id)).status).toBe("ok");
  });

  it("checkUser 回的 user 與 check 同形（同一個 evaluate 投影）", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { isAdmin: true, passwordHash: "some-argon2-hash" });
    const gate = new UserGate(db);
    const result = await gate.checkUser(u.id);
    expect(result).toEqual({
      status: "ok",
      user: {
        id: u.id,
        email: u.email,
        handle: u.handle,
        displayName: u.displayName,
        isAdmin: true,
        mustChangePassword: false,
        hasPassword: true,
      },
    });
  });

  it("停權 → revoked", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db);
    const gate = new UserGate(db);
    expect((await gate.checkUser(u.id)).status).toBe("ok");

    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, u.id));
    gate.invalidate(u.id);
    expect((await gate.checkUser(u.id)).status).toBe("revoked");
  });

  it("查無使用者 → revoked", async () => {
    const { db } = await freshDb();
    const gate = new UserGate(db);
    expect((await gate.checkUser("00000000-0000-0000-0000-000000000000")).status).toBe("revoked");
  });

  it("與 check 共用同一份快取：check() 建好的快取 checkUser 直接用，不重查 DB", async () => {
    // ⚠ 這條是「checkUser 必須走 getRow」的**唯一**守衛。下面那條 race 案只能分辨
    // 「有沒有把舊值寫進快取」，分辨不出「有沒有用快取」——把 checkUser 改成自己
    // await this.fetchRow()、完全不碰快取，race 案照樣全綠（實測）。
    const { db } = await freshDb();
    let served = 0;
    const gate = new UserGate(db, {
      fetchRow: async (userId): Promise<GateRow> => {
        served += 1;
        return {
          id: userId,
          email: "shared@example.com",
          handle: "shared",
          displayName: "S",
          isAdmin: false,
          disabledAt: null,
          tokenVersion: 7,
          mustChangePassword: false,
          hasPassword: true,
        };
      },
    });

    expect((await gate.check("u-shared", 7)).status).toBe("ok"); // 建立快取
    expect((await gate.checkUser("u-shared")).status).toBe("ok"); // 必須命中同一份
    expect(served).toBe(1);
  });

  it("查詢期間被 invalidate → 不得把舊資料寫進快取（gen 守衛與 check() 共用同一條路）", async () => {
    // 這條守的是 gen 守衛本身：另寫一份 fetch 又自己寫快取、但少了 gen 守衛，
    // 停權後 60 秒內 token 仍然可用。「有沒有用快取」由上一條守。
    const { db } = await freshDb();
    let served = 0;
    const gate = new UserGate(db, {
      fetchRow: async (userId): Promise<GateRow> => {
        served += 1;
        // 第一次刻意慢，讓外面在它回來之前 invalidate
        if (served === 1) await new Promise(resolve => setTimeout(resolve, 20));
        return {
          id: userId,
          email: "race@example.com",
          handle: "race",
          displayName: "R",
          isAdmin: false,
          disabledAt: served === 1 ? null : new Date(),
          tokenVersion: 0,
          mustChangePassword: false,
          hasPassword: true,
        };
      },
    });

    const inFlight = gate.checkUser("u-race");
    gate.invalidate("u-race");
    expect((await inFlight).status).toBe("ok"); // 這一發用的是查詢當下的快照，合理

    // 關鍵斷言：那份舊快照不得被寫進快取——下一次必須重新查（拿到已停權的狀態）。
    expect((await gate.checkUser("u-race")).status).toBe("revoked");
    expect(served).toBe(2);
  });
});
