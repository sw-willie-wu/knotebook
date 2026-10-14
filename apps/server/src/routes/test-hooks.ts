/**
 * #272 §7.5：e2e 測試縫。**只在 `config.testHooks` 時由 app.ts 註冊**（KNOTEBOOK_E2E_TEST_HOOKS=1 且 PUBLIC_URL 是 loopback），否則 404。
 * `PUT /api/admin/test/version-auto-wait { seconds }`：把自動切版的等待 X 壓成秒（`seconds: null`＝回站台設定）。requireAdmin；204。
 * 只覆寫這個行程的掃描器（`VersionService.overrideAutoWaitMs`），不寫 DB。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendInvalidBody } from "../auth/admin-provider-input.js";
import type { VersionService } from "../collab/versions.js";

const autoWaitBodySchema = z.object({ seconds: z.number().int().min(1).max(3600).nullable() }).strict();

export function testHookRoutes(deps: { versions: VersionService }) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.put("/api/admin/test/version-auto-wait", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = autoWaitBodySchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      deps.versions.overrideAutoWaitMs(parsed.data.seconds === null ? null : parsed.data.seconds * 1000);
      return reply.code(204).send();
    });
  };
}
