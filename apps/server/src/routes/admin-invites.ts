/**
 * #285 管理員產生／列出／撤銷邀請連結（spec §5.2，`requireAdmin`）。
 *
 * 全是單句、不開交易（不進 `test/unit/s14-structure.test.ts` 的 ④⑥）。不放進 `admin-users.ts`：避免牽動該檔的 ⑥ 計數，
 * 與重設路由（`admin-password-reset.ts`）同一種切法。
 * log 與回應絕不含 token 明文、`token_hash` 或備註（201 回應的 `token` 除外，V1；列表回應帶備註給管理員看，log 不帶，§5.8）。
 */
import type { FastifyInstance } from "fastify";
import { desc, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { MAX_INVITE_LABEL_LENGTH, type AdminInviteDto, type AdminInviteStatus } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { oneTimeLinks, users } from "../db/schema.js";
import { isStorableText } from "../auth/admin-provider-input.js";
import { hashToken } from "../auth/api-token.js";
import { activeOneTimeLink, generateOneTimeToken } from "../auth/one-time-link.js";
import { deleteEndedOneTimeLinks } from "../auth/one-time-link-cleanup.js";
import { isPasswordLoginAccepted, PASSWORD_LOGIN_DISABLED_MESSAGE } from "../auth/password-login.js";
import { sendError } from "../http/errors.js";
import { redactDbError } from "../lib/redact-db-error.js";
import { UUID_RE } from "../notes/service.js";

const issueBodySchema = z.object({ expiresInDays: z.number().int().min(1).max(7), label: z.string().optional() }).strict();

export interface AdminInvitesRouteDeps {
  db: Db;
  config: Pick<AppConfig, "passwordLoginForceEnable">;
}

/** trim → 空字串存 NULL → 可儲存字元 → 以 code point 計不超過上限（與 DB `one_time_links_label_chk` 同值）。 */
function normalizeInviteLabel(raw: string | undefined): string | null | "invalid" {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (s === "") return null;
  if (!isStorableText(s)) return "invalid";
  if ([...s].length > MAX_INVITE_LABEL_LENGTH) return "invalid";
  return s;
}

interface InviteRow {
  id: string;
  label: string | null;
  status: AdminInviteStatus;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  creatorId: string | null;
  creatorEmail: string | null;
  redeemerId: string | null;
  redeemerEmail: string | null;
}

function toAdminInviteDto(row: InviteRow): AdminInviteDto {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdBy: row.creatorId !== null ? { id: row.creatorId, email: row.creatorEmail! } : null,
    usedBy: row.redeemerId !== null ? { id: row.redeemerId, email: row.redeemerEmail! } : null,
  };
}

/** 列表與建立回應共用的單句查詢：不 select `token_hash`。 */
async function selectInvites(db: Db, where: SQL): Promise<AdminInviteDto[]> {
  const creator = alias(users, "invite_creator");
  const redeemer = alias(users, "invite_redeemer");
  const rows = await db
    .select({
      id: oneTimeLinks.id,
      label: oneTimeLinks.label,
      status: sql<AdminInviteStatus>`case when ${oneTimeLinks.usedAt} is not null then 'used' when ${oneTimeLinks.revokedAt} is not null then 'revoked' when ${oneTimeLinks.expiresAt} <= now() then 'expired' else 'pending' end`,
      createdAt: oneTimeLinks.createdAt,
      expiresAt: oneTimeLinks.expiresAt,
      usedAt: oneTimeLinks.usedAt,
      revokedAt: oneTimeLinks.revokedAt,
      creatorId: creator.id,
      creatorEmail: creator.email,
      redeemerId: redeemer.id,
      redeemerEmail: redeemer.email,
    })
    .from(oneTimeLinks)
    .leftJoin(creator, eq(creator.id, oneTimeLinks.createdById))
    .leftJoin(redeemer, eq(redeemer.id, oneTimeLinks.usedById))
    .where(where)
    .orderBy(desc(oneTimeLinks.createdAt), desc(oneTimeLinks.id));
  return rows.map(toAdminInviteDto);
}

export function adminInvitesRoutes(deps: AdminInvitesRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    // 判斷順序（spec §5.2 N-5）：body → 帳密有效值 → INSERT。
    app.post("/api/admin/invites", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = issueBodySchema.safeParse(request.body);
      const label = parsed.success ? normalizeInviteLabel(parsed.data.label) : "invalid";
      if (!parsed.success || label === "invalid") return sendError(reply, 400, "invalid_body", "請求格式錯誤");
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      const token = generateOneTimeToken("invite");
      let invite: AdminInviteDto;
      try {
        const [row] = await deps.db
          .insert(oneTimeLinks)
          .values({
            kind: "invite",
            tokenHash: hashToken(token),
            createdById: request.user!.id,
            label,
            expiresAt: sql`now() + make_interval(days => ${parsed.data.expiresInDays}::int)`,
          })
          .returning({ id: oneTimeLinks.id, createdAt: oneTimeLinks.createdAt, expiresAt: oneTimeLinks.expiresAt });
        // 剛插入、至少 1 天後到期：status 必為 pending，建立者就是自己。
        invite = toAdminInviteDto({
          id: row!.id,
          label,
          status: "pending",
          createdAt: row!.createdAt,
          expiresAt: row!.expiresAt,
          usedAt: null,
          revokedAt: null,
          creatorId: request.user!.id,
          creatorEmail: request.user!.email,
          redeemerId: null,
          redeemerEmail: null,
        });
      } catch (err) {
        // INSERT 的參數帶 token_hash 與備註：drizzle 的錯誤會把參數串進 message，原樣交給全域 handler 就進 log。
        throw redactDbError(request.log, err, "產生邀請");
      }
      request.log.info({ userId: request.user!.id, linkId: invite.id, expiresAt: invite.expiresAt }, "產生邀請");
      // 清理沒有排程，產生成功後機會性執行；失敗不影響回應。
      void deleteEndedOneTimeLinks(deps.db).catch((err: unknown) => request.log.warn({ err }, "清理一次性連結失敗"));
      return reply.code(201).send({ invite, token });
    });

    app.get("/api/admin/invites", { preHandler: app.requireAdmin }, async () => {
      return selectInvites(deps.db, eq(oneTimeLinks.kind, "invite"));
    });

    // 撤銷永遠允許：不看帳密開關（spec §5.7）。已撤銷或已過期的再撤也是 204，不改列。
    app.delete("/api/admin/invites/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "invite_not_found", "找不到這個邀請");
      const id = rawId.toLowerCase();
      let hit: Array<{ id: string }>;
      let existing: { usedAt: Date | null } | undefined;
      try {
        hit = await deps.db
          .update(oneTimeLinks)
          .set({ revokedAt: sql`now()` })
          .where(sql`${oneTimeLinks.id} = ${id} and ${activeOneTimeLink("invite")}`)
          .returning({ id: oneTimeLinks.id });
        if (hit.length === 0) {
          [existing] = await deps.db
            .select({ usedAt: oneTimeLinks.usedAt })
            .from(oneTimeLinks)
            .where(sql`${oneTimeLinks.id} = ${id} and ${oneTimeLinks.kind} = 'invite'`);
        }
      } catch (err) {
        // 動的是含雜湊欄的列——不讓錯誤本體進 log。
        throw redactDbError(request.log, err, "撤銷邀請");
      }
      if (hit.length > 0) {
        request.log.info({ userId: request.user!.id, linkId: id }, "撤銷邀請");
        return reply.code(204).send();
      }
      if (!existing) return sendError(reply, 404, "invite_not_found", "找不到這個邀請");
      if (existing.usedAt !== null) return sendError(reply, 409, "invite_used", "這個邀請已經被使用");
      return reply.code(204).send();
    });
  };
}
