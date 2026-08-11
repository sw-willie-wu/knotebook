import type { Db } from "../db/index.js";
import { aiModels, aiProviders } from "../db/schema.js";
import type { AiProviderRow } from "./runtime.js";

export type AiModelRow = typeof aiModels.$inferSelect;

export interface AiSnapshot {
  models: AiModelRow[];
  providers: AiProviderRow[];
}

/**
 * 一次撈齊 models 與 providers（各一次 SELECT）供 `resolveActionModel` 純記憶體判定用
 * （spec §13.2「helper 吃一次撈齊快照」）——`GET /api/ai/actions`（本檔呼叫端）與
 * `POST /api/ai`（Task 5）共用同一份快照/同一支判定函式，禁止各自逐 action 查詢
 * （同 12.3「禁止逐 target resolveRole」同族反模式）。兩個 SELECT 並行執行，互不相依。
 */
export async function loadAiSnapshot(db: Db): Promise<AiSnapshot> {
  const [models, providers] = await Promise.all([db.select().from(aiModels), db.select().from(aiProviders)]);
  return { models, providers };
}

/**
 * 模型解析（spec §13.2，純記憶體、不打 DB）：
 * 1. `action.modelId` 綁定的 model 存在、`enabled`、且其 provider 亦 `enabled` → 直接用它
 *    （不與任何回退候選比較——即使有其他 model 是 `isDefault`，綁定可用就優先用綁定的）。
 * 2. 否則（含綁定 model 不存在／disabled／provider disabled）回退：`purpose === "chat"`
 *    且 `enabled` 的 model，其 provider 亦 `enabled`，取 `ORDER BY isDefault DESC,
 *    createdAt ASC, id ASC` 排序後第一筆。`isDefault` 只是排序偏好，不是可用性開關
 *    （spec §13.2 三輪 gate MAJOR-1：無 default／default 被停用或刪除都不得讓 AI
 *    靜默消失）。
 * 3. 全無可用候選 → `null`。
 *
 * 一併回傳 `provider`（與 `model.providerId` 保證一致）——POST 端（Task 5）不得再查一次，
 * 防止兩處各自查詢導致的「解析結果」與「實際打的 provider」不同源漂移。
 *
 * 降級集合（`AiRuntime.degraded`）**不參與**此判定（spec §13.2 明訂）：降級是「可行動
 * 錯誤」，不因此悄悄改選另一個 model——呼叫端（admin test 端點／`POST /api/ai`）自行
 * 用降級集合判斷是否要打 upstream。
 */
export function resolveActionModel(
  action: { modelId: string | null },
  snapshot: AiSnapshot
): { model: AiModelRow; provider: AiProviderRow } | null {
  const providerById = new Map(snapshot.providers.map(p => [p.id, p]));

  if (action.modelId !== null) {
    const bound = snapshot.models.find(m => m.id === action.modelId);
    if (bound?.enabled) {
      const provider = providerById.get(bound.providerId);
      if (provider?.enabled) return { model: bound, provider };
    }
  }

  const candidates: Array<{ model: AiModelRow; provider: AiProviderRow }> = [];
  for (const model of snapshot.models) {
    if (!model.enabled || model.purpose !== "chat") continue;
    const provider = providerById.get(model.providerId);
    if (provider?.enabled) candidates.push({ model, provider });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.model.isDefault !== b.model.isDefault) return a.model.isDefault ? -1 : 1;
    const byCreatedAt = a.model.createdAt.getTime() - b.model.createdAt.getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;
  });

  return candidates[0];
}
