import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import type { AiActionDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { aiActions } from "../db/schema.js";
import { loadAiSnapshot, resolveActionModel } from "../ai/resolve.js";

export interface AiRouteDeps {
  db: Db;
}

/**
 * 一般 session 用 AI 路由（本 task 只做 `GET /api/ai/actions`；`POST /api/ai` SSE
 * 端點留 Task 5）。
 */
export function aiRoutes(deps: AiRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    // 依 sort_order, id 排序（次要鍵慣例，同 `admin-users.ts` GET 列表）；只帶
    // `{id, name, applyMode}`——systemPrompt/userTemplate 這些不需要洩給非 admin。
    //
    // 「可解析」判定與 `POST /api/ai`（Task 5）**共用同一支 `resolveActionModel`**
    // （spec §13.2 單一真相）：一次 `loadAiSnapshot` 取快照，對每筆 enabled action 套用，
    // 只有解析得出 model/provider 的 action 才出現在清單——全新實例（零 provider）／
    // 全部降級但仍 enabled 的 provider（降級不參與此判定，只影響 POST 執行）／
    // action 綁定的 model 已停用但存在其他可回退的 enabled chat model，皆各自對應
    // 「回空」「照常出現」「照常出現」三種正確行為，不必個別特判。
    app.get("/api/ai/actions", { preHandler: app.authenticate }, async () => {
      const [snapshot, actionRows] = await Promise.all([
        loadAiSnapshot(deps.db),
        deps.db.select().from(aiActions).where(eq(aiActions.enabled, true)).orderBy(asc(aiActions.sortOrder), asc(aiActions.id)),
      ]);

      const actions: AiActionDto[] = [];
      for (const row of actionRows) {
        const resolved = resolveActionModel({ modelId: row.modelId }, snapshot);
        if (resolved === null) continue;
        actions.push({ id: row.id, name: row.name, applyMode: row.applyMode as "direct" | "preview" });
      }

      return { actions };
    });
  };
}
