/**
 * #240 REST：路徑參數 `id`／`userId` 中 UUID 形的值轉小寫——`id`／`userId` 路徑參數的收斂點（app 層 `preValidation`，
 * 見 `app.ts`）。live doc、presence、寫入佇列、`connectionsOfNote`、`c.userId === userId` 這些以字串為鍵的結構
 * 都只認小寫；DB 的 uuid 欄不分大小寫，所以大寫 id 查得到列、卻打到另一份記憶體狀態（spec §3.1）。
 * 非 UUID 形原樣放過（各路由既有的 404 不變）；名單外的參數（`:ref`、`:handle`、`:slug`、`:editId`、`:groupId`…）不碰。
 * 守衛＝`test/unit/uuid-params.test.ts`（U-240r）與整合 R1–R8、R5b。
 */
import type { FastifyRequest } from "fastify";
import { UUID_RE } from "../notes/service.js";

export const LOWERCASED_PARAMS = ["id", "userId"] as const;

export async function lowercaseUuidParams(request: FastifyRequest): Promise<void> {
  const params = request.params as Record<string, unknown> | undefined;
  if (!params) return;
  for (const key of LOWERCASED_PARAMS) {
    const value = params[key];
    if (typeof value === "string" && UUID_RE.test(value)) params[key] = value.toLowerCase();
  }
}
