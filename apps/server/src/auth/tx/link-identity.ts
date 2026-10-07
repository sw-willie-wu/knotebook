import { and, eq, ne, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { userIdentities, users } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import type { OidcTestHook } from "../oidc-test-hook.js";

export const LINK_EXPIRED_MESSAGE = "這個連結請求已過期，請重新登入";

export type LinkProof = { kind: "password"; passwordHash: string } | { kind: "sso"; issuer: string; sub: string };

export interface LinkPendingInput {
  targetUserId: string;
  /** pending cookie 裡的 email（已正規化）。 */
  pendingEmail: string;
  /** 要連結的新身分——**一律取自 pending cookie**，不取自 SSO 證明的第二段往返（§7.5.3 末段）。 */
  issuer: string;
  sub: string;
  proof: LinkProof;
}

export interface LinkedUser {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
  hasPassword: boolean;
  tokenVersion: number;
}

/**
 * #187 交易表 A2（§7.5.3 第 3 步＋§7.5.4）。**第一句**鎖目標帳號（`FOR NO KEY UPDATE`，B16：需判 B2 的 INSERT identity 交易同一個
 * 序列化點、固定「先 users 後 identity」——A1 create 分支（全新帳號）與 §10.3 補登除外，spec §4.2 r3-N2；NO KEY UPDATE 與 FK 的 KEY SHARE 相容，不擋同一人建筆記／PAT——r3 T4），之後依序：
 *   1. 列存在且 lower(email)＝pendingEmail，否則 oidc_link_expired；
 *   2. 證明：密碼 → password_hash 仍是驗過的那個字串（C23）；SSO → 證明身分屬目標帳號，否則 oidc_link_proof_mismatch（不透露是誰）；
 *   3. 停用 → account_disabled（B14：證明之後才揭露）；
 *   4. B2：已有同 issuer 的其他 sub → identity_already_linked（B14 同）；
 *   5. INSERT … ON CONFLICT (issuer, sub) DO NOTHING；沒插進去 → 讀現有擁有者：本人＝冪等成功（C12、C21），別人＝identity_taken（C11）；
 *   6. must_change_password **不動**（B15）。SSO 證明另更新證明身分的 last_login_at（在 users 鎖之後，符合 B16）。
 * 交易外才做的：密碼雜湊比對（S14）、清 pending cookie、gate.invalidate、簽 session（呼叫端）。
 */
export async function linkPendingIdentityInTx(tx: Tx, input: LinkPendingInput, hook?: OidcTestHook): Promise<LinkedUser> {
  const [row] = await tx
    .select({
      id: users.id,
      email: users.email,
      emailLower: sql<string>`lower(${users.email})`,
      handle: users.handle,
      displayName: users.displayName,
      isAdmin: users.isAdmin,
      mustChangePassword: users.mustChangePassword,
      passwordHash: users.passwordHash,
      disabledAt: users.disabledAt,
      tokenVersion: users.tokenVersion,
    })
    .from(users)
    .where(eq(users.id, input.targetUserId))
    .for("no key update");
  await hook?.("link-locked", { userId: input.targetUserId });

  if (row === undefined || row.emailLower !== input.pendingEmail) throw new TxAbort(409, "oidc_link_expired", LINK_EXPIRED_MESSAGE);

  if (input.proof.kind === "password") {
    if (row.passwordHash === null || row.passwordHash !== input.proof.passwordHash) {
      throw new TxAbort(401, "invalid_credentials", "帳號或密碼錯誤");
    }
  } else {
    const [owner] = await tx
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(and(eq(userIdentities.issuer, input.proof.issuer), eq(userIdentities.sub, input.proof.sub)))
      .limit(1);
    if (owner?.userId !== input.targetUserId) throw new TxAbort(409, "oidc_link_proof_mismatch", "你登入的不是這個帳號已連結的那個身分");
  }

  if (row.disabledAt !== null) throw new TxAbort(403, "account_disabled", "此帳號已被停用");

  // B2 用精確 `eq(issuer)`，不用決策／pending GET 的寬鬆 `issuerKey`（`auth/issuer.ts`）：`user_identities.issuer` 與 pending 的
  // issuer 都是 callback 取自 IdP 的 `serverMetadata().issuer` 原字串（`routes/oidc.ts` 組 claims 處；§10.3 補登的舊欄也是舊版
  // callback 寫的），同一個 IdP 寫進來的就是同一字串；寬鬆化會把只差結尾斜線、實為不同 issuer 的身分誤判成 B2。
  // 排除用寬鬆（寧多勿漏，防 B14 洩漏），判定用精確（寧漏勿誤擋）——兩者方向相反，**不要統一**。
  const [sameIssuer] = await tx
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(and(eq(userIdentities.userId, input.targetUserId), eq(userIdentities.issuer, input.issuer), ne(userIdentities.sub, input.sub)))
    .limit(1);
  if (sameIssuer !== undefined) throw new TxAbort(409, "identity_already_linked", "這個帳號已連結同一個登入服務的另一個身分");

  const inserted = await tx
    .insert(userIdentities)
    .values({ userId: input.targetUserId, issuer: input.issuer, sub: input.sub, lastLoginAt: sql`now()` })
    .onConflictDoNothing({ target: [userIdentities.issuer, userIdentities.sub] })
    .returning({ id: userIdentities.id });
  if (inserted.length === 0) {
    // ON CONFLICT 會先等對方的交易結束；DO NOTHING 之後這一句是新的快照，看得到對方已 commit 的列【推：READ COMMITTED 逐句快照；C11 案實證】。
    const [owner] = await tx
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(and(eq(userIdentities.issuer, input.issuer), eq(userIdentities.sub, input.sub)))
      .limit(1);
    if (owner?.userId !== input.targetUserId) throw new TxAbort(409, "identity_taken", "這個登入身分已連結到其他帳號");
  }

  if (input.proof.kind === "sso") {
    await tx
      .update(userIdentities)
      .set({ lastLoginAt: sql`now()` })
      .where(and(eq(userIdentities.issuer, input.proof.issuer), eq(userIdentities.sub, input.proof.sub)));
  }

  return {
    id: row.id,
    email: row.email,
    handle: row.handle,
    displayName: row.displayName,
    isAdmin: row.isAdmin,
    mustChangePassword: row.mustChangePassword,
    hasPassword: row.passwordHash !== null,
    tokenVersion: row.tokenVersion,
  };
}

/**
 * #187 交易表 P3（§8.1 第 2 步）：設定頁手動連結。本人同時持有 session 與 IdP 登入就是證明——不要求 email 相同（第 3 步）。
 * **第一句**鎖本人 users 列（`FOR NO KEY UPDATE`，B16：給 B2 一個序列化點，C22），之後依序：帳號不在 → `oidc_link_session_mismatch`；
 * 停用 → `account_disabled`；`(issuer, sub)` 屬本人 → 冪等成功；屬別人 → `identity_taken`；本人已有同 issuer 另一個 sub →
 * `identity_already_linked`（B2，精確 `eq(issuer)`，理由同上一個函式）；都不是 → INSERT（並發首登搶同一身分時 ON CONFLICT 後重讀，C11）。
 * 不動 `must_change_password`（B15）、不寫 users、不簽 session。
 */
export async function linkIdentityToUserInTx(tx: Tx, input: { userId: string; issuer: string; sub: string }): Promise<void> {
  const [row] = await tx.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, input.userId)).for("no key update");
  if (row === undefined) throw new TxAbort(409, "oidc_link_session_mismatch", "發起連結的帳號已不存在");
  if (row.disabledAt !== null) throw new TxAbort(403, "account_disabled", "此帳號已被停用");

  const ownerOf = async () =>
    (
      await tx
        .select({ userId: userIdentities.userId })
        .from(userIdentities)
        .where(and(eq(userIdentities.issuer, input.issuer), eq(userIdentities.sub, input.sub)))
        .limit(1)
    )[0];
  const owner = await ownerOf();
  if (owner !== undefined) {
    if (owner.userId === input.userId) return;
    throw new TxAbort(409, "identity_taken", "這個登入身分已連結到其他帳號");
  }

  const [sameIssuer] = await tx
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(and(eq(userIdentities.userId, input.userId), eq(userIdentities.issuer, input.issuer), ne(userIdentities.sub, input.sub)))
    .limit(1);
  if (sameIssuer !== undefined) throw new TxAbort(409, "identity_already_linked", "這個帳號已連結同一個登入服務的另一個身分");

  const inserted = await tx
    .insert(userIdentities)
    .values({ userId: input.userId, issuer: input.issuer, sub: input.sub, lastLoginAt: sql`now()` })
    .onConflictDoNothing({ target: [userIdentities.issuer, userIdentities.sub] })
    .returning({ id: userIdentities.id });
  if (inserted.length === 0) {
    const winner = await ownerOf();
    if (winner?.userId !== input.userId) throw new TxAbort(409, "identity_taken", "這個登入身分已連結到其他帳號");
  }
}
