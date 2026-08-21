import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type {
  AdminAiActionDto,
  AdminAiModelDto,
  AdminAiProviderDto,
} from "@knotebook/shared";
import { sendError } from "../http/errors.js";
import type { Db } from "../db/index.js";
import type { AppConfig } from "../config.js";
import { aiActions, aiModels, aiProviders } from "../db/schema.js";
import { AiKeyDecryptError, decryptApiKey, encryptApiKey, type EncryptedApiKey } from "../ai/crypto.js";
import type { AiRuntime } from "../ai/runtime.js";
import { BUILTIN_ACTION_IDS } from "../db/seed-ai.js";
import { isForeignKeyViolation, isUniqueViolation } from "../db/pg-errors.js";
import { UUID_RE } from "../notes/service.js";

export interface AdminAiRouteDeps {
  db: Db;
  config: AppConfig;
  runtime: AiRuntime;
}

// ───────────────────────────── providers ─────────────────────────────

const providerTypeEnum = z.enum(["openai_compatible", "anthropic"]);

const createProviderSchema = z.object({
  name: z.string().min(1),
  type: providerTypeEnum,
  baseUrl: z.string().url(),
  apiKey: z.string().min(1).optional(),
});

const patchProviderSchema = z.object({
  name: z.string().min(1).optional(),
  type: providerTypeEnum.optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

/**
 * 取 URL 的 `origin + pathname` 供日誌使用。
 *
 * **刻意不記完整 URL**：`base_url` 可能帶 `user:pass@`（`origin` 不含 userinfo）或把憑證放在
 * query（`pathname` 不含 query），整條寫進日誌等於把另一種憑證留在那裡。但也不能只記 host
 * ——`http://x` → `https://x`、或 `https://gw/tenant-a` → `/tenant-b` 這類變更會記成前後
 * 完全相同，一行看起來像沒發生事（審查指出）。解析不出來回 undefined（pino 會略過該欄位）。
 */
function safeTarget(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

// 只選這六欄（形狀鎖，比照 `routes/admin-users.ts` 的 `adminUserColumns` 慣例，
// 這裡更進一步）：`hasKey` 用 SQL 端 `IS NOT NULL` 直接算出布林值，**從不** SELECT
// `apiKeyEncrypted` 本體——密文位元組完全不進 Node process 記憶體，不是「查出來但序列化
// 階段刻意漏掉」那種較弱的防線（見 Task 3 交接：任何回應絕不可含 api_key_encrypted／
// ct/iv/tag/keyId 字樣）。issue #14 之後密文另外綁了 providerId，但那道綁定管的是
// 「密文不能跨列使用」，跟「密文不可以出現在回應裡」是兩件事——這裡這道防線照舊。
const providerListColumns = {
  id: aiProviders.id,
  name: aiProviders.name,
  type: aiProviders.type,
  baseUrl: aiProviders.baseUrl,
  enabled: aiProviders.enabled,
  createdAt: aiProviders.createdAt,
  hasKey: sql<boolean>`${aiProviders.apiKeyEncrypted} is not null`,
};

interface ProviderListRow {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  enabled: boolean;
  createdAt: Date;
  hasKey: boolean;
}

function toProviderDto(row: ProviderListRow, runtime: AiRuntime): AdminAiProviderDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type as "openai_compatible" | "anthropic",
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    hasKey: row.hasKey,
    degraded: runtime.degraded.has(row.id),
    createdAt: row.createdAt.toISOString(),
  };
}

// ───────────────────────────── models ─────────────────────────────

const createModelSchema = z.object({
  providerId: z.string().uuid(),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  // v0.1 只開 chat（YAGNI；embedding 連 API 都不收）——`z.literal` 讓任何非 "chat" 值
  // 在 zod 階段就 400 invalid_body，不必另外手寫檢查（spec §13.2「purpose 鎖 chat」）。
  purpose: z.literal("chat").optional(),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const patchModelSchema = z.object({
  providerId: z.string().uuid().optional(),
  modelId: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  purpose: z.literal("chat").optional(),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

type AiModelRow = typeof aiModels.$inferSelect;

function toModelDto(row: AiModelRow): AdminAiModelDto {
  return {
    id: row.id,
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: row.displayName,
    purpose: "chat",
    isDefault: row.isDefault,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

// ───────────────────────────── actions ─────────────────────────────

const actionApplyModeEnum = z.enum(["direct", "preview"]);
// `{{text}}` 佔位缺失在建立時就擋（400），不留到執行期才發現太晚（spec §13.2）。
const userTemplateSchema = z.string().min(1).refine(v => v.includes("{{text}}"), "userTemplate 必須包含 {{text}} 佔位符");

const createActionSchema = z.object({
  name: z.string().min(1),
  systemPrompt: z.string().min(1),
  userTemplate: userTemplateSchema,
  modelId: z.string().uuid().nullable().optional(),
  applyMode: actionApplyModeEnum,
  sortOrder: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

const patchActionSchema = z.object({
  name: z.string().min(1).optional(),
  systemPrompt: z.string().min(1).optional(),
  userTemplate: userTemplateSchema.optional(),
  modelId: z.string().uuid().nullable().optional(),
  applyMode: actionApplyModeEnum.optional(),
  sortOrder: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

type AiActionRow = typeof aiActions.$inferSelect;

function toActionDto(row: AiActionRow): AdminAiActionDto {
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.systemPrompt,
    userTemplate: row.userTemplate,
    modelId: row.modelId,
    applyMode: row.applyMode as "direct" | "preview",
    sortOrder: row.sortOrder,
    enabled: row.enabled,
    builtin: BUILTIN_ACTION_IDS.includes(row.id),
  };
}

/**
 * Admin AI 三層 CRUD（providers/models/actions）＋provider 測試連線端點（spec §13.2）。
 * 全部端點皆需 `requireAdmin`（guard／錯誤慣例逐字比照 `routes/admin-users.ts`）；
 * body／DTO 一律 camelCase（POST /api/ai 的 snake_case 是 §6 刻意例外，與本檔無關）。
 */
export function adminAiRoutes(deps: AdminAiRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    // ───────────── providers ─────────────

    app.get("/api/admin/ai/providers", { preHandler: app.requireAdmin }, async () => {
      const rows = await deps.db.select(providerListColumns).from(aiProviders).orderBy(asc(aiProviders.createdAt), asc(aiProviders.id));
      return { providers: rows.map(r => toProviderDto(r, deps.runtime)) };
    });

    app.post("/api/admin/ai/providers", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = createProviderSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const { name, type, baseUrl, apiKey } = parsed.data;

      // id 在這裡就產好，不沿用 schema 的 `defaultRandom()`：密文的 AAD 綁 providerId
      // （issue #14），加密的當下就必須已經知道 id。
      const id = randomUUID();
      const apiKeyEncrypted = apiKey !== undefined ? encryptApiKey(deps.config.appSecret, apiKey, id) : null;
      const [row] = await deps.db.insert(aiProviders).values({ id, name, type, baseUrl, apiKeyEncrypted }).returning(providerListColumns);
      return reply.code(201).send(toProviderDto(row, deps.runtime));
    });

    app.patch("/api/admin/ai/providers/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "not_found", "找不到此 provider");
      const id = rawId.toLowerCase();

      const parsed = patchProviderSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const { name, type, baseUrl, apiKey, enabled } = parsed.data;

      // 只讀這兩欄（**不** SELECT 密文本體，維持 `providerListColumns` 那道防線）——而且
      // 它們**只供日誌使用**，不參與「要不要清金鑰」的決定（那個判斷在 DB 端做，見下）。
      const [existing] = await deps.db
        .select({ baseUrl: aiProviders.baseUrl, hasKey: sql<boolean>`${aiProviders.apiKeyEncrypted} is not null` })
        .from(aiProviders)
        .where(eq(aiProviders.id, id))
        .limit(1);
      if (!existing) return sendError(reply, 404, "not_found", "找不到此 provider");

      const values: PgUpdateSetSource<typeof aiProviders> = {};
      if (name !== undefined) values.name = name;
      if (type !== undefined) values.type = type;
      if (baseUrl !== undefined) values.baseUrl = baseUrl;
      if (enabled !== undefined) values.enabled = enabled;

      // `apiKey` 給了 → 重加密覆寫；沒給 → 完全不碰這個欄位（既有密文原樣保留）。
      let newEncrypted: EncryptedApiKey | undefined;
      if (apiKey !== undefined) {
        newEncrypted = encryptApiKey(deps.config.appSecret, apiKey, id);
        values.apiKeyEncrypted = newEncrypted;
      }

      /**
       * issue #46：**換了網址就把既有金鑰作廢**（除非同一次 PATCH 就帶了新的金鑰）。
       *
       * 為什麼：`/test`（與 `ai/upstream.ts` 的每一次 AI 呼叫）會把解密後的**明文** key 以
       * `authorization: Bearer …`／`x-api-key` 送到 `baseUrl` 指的主機。`baseUrl` 只驗格式、
       * 沒有 allowlist，所以任何 admin 只要改一個明文欄位再按一下 Test，就能把金鑰送到自己
       * 的主機——完全不需要讀 DB，也不需要 `APP_SECRET`。產品刻意承諾「金鑰寫進去就讀不
       * 回來」（見 `providerListColumns` 的說明），這條路把那個承諾整個繞開。
       *
       * 作廢是成本最低、又不限制任何 host 的切法（自架者接內網 Ollama 照常）：金鑰不再能被
       * 「繼承」到一個新網址上，想把金鑰送到別的地方就得先自己重新輸入一次。
       *
       * ⚠ 這**不是**一道完整的防護：攻擊者 admin 仍可把網址指到自己主機、等另一個 admin
       * 「咦金鑰不見了」重新輸入。差別在於那條路留得下痕跡（金鑰消失、網址變了、下面那行
       * log），而原本那條是靜默的。殘留風險記在 docs/known-limitations.md。
       */
      if (baseUrl !== undefined && apiKey === undefined) {
        // ⚠ **比對必須在 DB 端、跟寫入同一個語句裡做**（審查實測抓到，命中率 7–28%）：
        // 先 SELECT 再於 Node 端比對是個 TOCTOU——攻擊者持續送「網址不變」的 PATCH（讀到
        // 舊值＝EVIL ⇒ 判定沒變 ⇒ 不清金鑰，但 `base_url = EVIL` 照寫），只要有一發的
        // SELECT 落在受害者「改回正確網址＋重新輸入金鑰」的 UPDATE 之前、而 UPDATE 落在
        // 之後，最終列就是「攻擊者的網址 ＋ 受害者剛輸入的金鑰」。
        //
        // 寫成一句 `case when` 就沒有那個窗口：PostgreSQL 的 UPDATE 對同一列取 row lock，
        // 而 SET 右側看到的一律是該列的**舊值**——所以「網址有沒有變」永遠是拿這一次真正
        // 要寫進去的值跟當下的舊值比，中間沒有任何人插得進來。攻擊者那發 no-op PATCH 若
        // 排在受害者之後，它比較的是受害者剛寫進去的網址 ⇒ 判定有變 ⇒ 金鑰照樣被清掉。
        //
        // 附帶好處：「編輯表單每次都會帶 baseUrl，只改名字不該掉金鑰」這件事也由同一句
        // 保證（值相同 ⇒ `is distinct from` 為 false ⇒ 原樣保留），不必再靠 Node 端比對。
        values.apiKeyEncrypted = sql`case when ${aiProviders.baseUrl} is distinct from ${baseUrl} then null::jsonb else ${aiProviders.apiKeyEncrypted} end`;
      }

      // fix round 1（I-2）：空 body `{}` 全欄位皆 undefined → `values` 是空物件——
      // drizzle 0.44 的 `.update(...).set({})` 會同步 throw "No values to set"，逃出
      // 這支 handler 變成裸 500。在真的呼叫 `.set()` 之前擋掉，回結構化 400。
      if (Object.keys(values).length === 0) {
        return sendError(reply, 400, "invalid_body", "請求格式錯誤：至少需要一個欄位");
      }

      const [row] = await deps.db.update(aiProviders).set(values).where(eq(aiProviders.id, id)).returning(providerListColumns);
      if (!row) return sendError(reply, 404, "not_found", "找不到此 provider");

      // 金鑰是不是真的被這一次請求清掉了——以 DB 回來的結果為準（上面那句 `case when` 的
      // 判斷只有資料庫知道結論）。
      const keyCleared = existing.hasKey && !row.hasKey && apiKey === undefined;

      if (baseUrl !== undefined && (baseUrl !== existing.baseUrl || keyCleared)) {
        // 改網址是敏感操作（見上面那段）——留一行可稽核的紀錄。**只記 host**：baseUrl 本身
        // 可能帶 `user:pass@`，完整 URL 進日誌等於把另一種憑證寫進去。解析失敗（理論上不會，
        // zod 已驗過 `.url()`）就記 undefined，不讓一行 log 弄掉整個請求。
        request.log.info(
          {
            providerId: id,
            userId: request.user!.id,
            from: safeTarget(existing.baseUrl),
            to: safeTarget(baseUrl),
            keyCleared,
          },
          "AI provider 的 base URL 被變更"
        );
      }

      if (keyCleared) {
        // 金鑰沒了就不可能是「密文解不開」——把降級狀態一起收掉，否則 provider 會卡在
        // 「請重新輸入 API key」的 503，連「這個 provider 本來就不需要金鑰」（自架 Ollama）
        // 都測不了。比照 issue #17 的教訓：不要留下沒有人會清的髒狀態。
        deps.runtime.degraded.delete(id);
      }

      if (newEncrypted !== undefined) {
        // 重加密寫入後自檢：用目前的 APP_SECRET 立即解密剛寫入的密文——同一支 secret
        // 剛加密完緊接著解，理論上必然成功；try/catch 是防禦性寫法（純函式契約層面，
        // 不假設 encryptApiKey/decryptApiKey 永不出錯），不是預期會踩到的分支。成功即
        // 從 degraded 移除（§10「不重啟生效」，不需重開 process）。
        try {
          decryptApiKey(deps.config.appSecret, newEncrypted, id);
          deps.runtime.degraded.delete(id);
        } catch {
          // 維持降級狀態不動——不吞出這個分支以外的行為。
        }
      }

      return reply.send(toProviderDto(row, deps.runtime));
    });

    app.delete("/api/admin/ai/providers/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "not_found", "找不到此 provider");
      const id = rawId.toLowerCase();

      // cascade 由 FK 承擔：models 隨之刪除，關聯 actions.modelId SET NULL（走 13.2 回退鏈）。
      const [deleted] = await deps.db.delete(aiProviders).where(eq(aiProviders.id, id)).returning({ id: aiProviders.id });
      if (!deleted) return sendError(reply, 404, "not_found", "找不到此 provider");
      // provider 都不在了，degraded 裡的那筆再也沒有人會去清（PATCH 重輸金鑰是唯一
      // 的移除路徑）——留著就是永遠累積的髒狀態。
      deps.runtime.degraded.delete(id);
      return reply.code(204).send();
    });

    app.post("/api/admin/ai/providers/:id/test", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "not_found", "找不到此 provider");
      const id = rawId.toLowerCase();

      // 這裡是唯一一處刻意 SELECT `apiKeyEncrypted` 本體的地方——測試連線需要真的
      // plaintext key 打上游請求。絕不落進任何回應（下面只回 {ok:true} 或結構化錯誤）。
      const [row] = await deps.db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1);
      if (!row) return sendError(reply, 404, "not_found", "找不到此 provider");

      if (deps.runtime.degraded.has(id)) {
        return sendError(reply, 503, "provider_unavailable", "此 provider 目前無法使用，請至後台重新輸入 API key");
      }

      let apiKey: string | undefined;
      if (row.apiKeyEncrypted !== null) {
        try {
          apiKey = decryptApiKey(deps.config.appSecret, row.apiKeyEncrypted, id);
        } catch (err) {
          if (!(err instanceof AiKeyDecryptError)) throw err;
          deps.runtime.degraded.add(id);
          return sendError(reply, 503, "provider_unavailable", "此 provider 目前無法使用，請至後台重新輸入 API key");
        }
      }

      try {
        // openai_compatible：`GET {baseUrl}/models`；anthropic：對稱地打官方 `/v1/models`
        // 列表端點（§5「與前者對稱、免花錢、不依賴任何 model id」——@anthropic-ai/sdk
        // 要到 Task 5 才加為依賴，此處故意不引入 SDK，改用等價的原生 fetch 呼叫，行為
        // 與「client.models.list()」語意相同）。
        const url = row.type === "anthropic" ? `${row.baseUrl}/v1/models` : `${row.baseUrl}/models`;
        const headers: Record<string, string> =
          row.type === "anthropic"
            ? { "anthropic-version": "2023-06-01", ...(apiKey !== undefined ? { "x-api-key": apiKey } : {}) }
            : apiKey !== undefined
              ? { authorization: `Bearer ${apiKey}` }
              : {};
        // fix round 1（I-4，安全）：`redirect: "manual"`——undici 對跨網域轉址只會剝掉
        // `Authorization`/`Cookie`，我們的驗證是自訂 header `x-api-key`（anthropic）／
        // 手寫 `authorization: Bearer ...`（openai_compatible 走的也是自訂組字串，非
        // fetch 認得的標準憑證欄位），跨網域 302 會把它原樣帶去第三方主機。手動模式下
        // 3xx 一律不追蹤，直接落入下面 `!res.ok`（3xx 不是 2xx）分支，統一映射 502
        // `upstream_error`，不外洩任何憑證。
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000), redirect: "manual" });
        if (!res.ok) {
          // 上游 body 只 log、絕不回傳給 client（可能含 key 片段或內網資訊）；
          // fix round 1（I-5）：無上限的 `res.text()` 可能把整包上游回應塞進 log——
          // 截前 2 KiB（比照 `drainWithCap` 的位元組上限精神），避免惡意/異常上游用
          // 超大 body 把 log 灌爆。
          const bodyText = await res.text();
          const truncatedBody = bodyText.length > 2048 ? `${bodyText.slice(0, 2048)}...(truncated)` : bodyText;
          request.log.warn({ providerId: id, status: res.status, body: truncatedBody }, "AI provider 測試連線失敗（上游非 2xx）");
          return sendError(reply, 502, "upstream_error", "AI provider 回應錯誤");
        }
        return reply.send({ ok: true });
      } catch (err) {
        request.log.warn({ providerId: id, err }, "AI provider 測試連線失敗（逾時或網路錯誤）");
        return sendError(reply, 502, "upstream_error", "AI provider 連線失敗或逾時");
      }
    });

    // ───────────── models ─────────────

    app.get("/api/admin/ai/models", { preHandler: app.requireAdmin }, async () => {
      const rows = await deps.db.select().from(aiModels).orderBy(asc(aiModels.createdAt), asc(aiModels.id));
      return { models: rows.map(toModelDto) };
    });

    app.post("/api/admin/ai/models", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = createModelSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const { providerId, modelId, displayName, isDefault, enabled } = parsed.data;

      try {
        const row = await deps.db.transaction(async tx => {
          // 交易內先 unset 同 purpose 其他列，再插入——`is_default` 唯一性無 DB 約束，
          // 純靠 server 交易保證（spec §13）。
          if (isDefault) {
            await tx.update(aiModels).set({ isDefault: false }).where(eq(aiModels.purpose, "chat"));
          }
          const [inserted] = await tx
            .insert(aiModels)
            .values({ providerId, modelId, displayName, purpose: "chat", isDefault: isDefault ?? false, enabled: enabled ?? true })
            .returning();
          return inserted;
        });
        return reply.code(201).send(toModelDto(row));
      } catch (err) {
        if (isUniqueViolation(err)) return sendError(reply, 409, "model_taken", "此 provider 已有相同 model");
        if (isForeignKeyViolation(err)) return sendError(reply, 400, "invalid_body", "指定的 provider 不存在");
        throw err;
      }
    });

    app.patch("/api/admin/ai/models/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "not_found", "找不到此 model");
      const id = rawId.toLowerCase();

      const parsed = patchModelSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const { providerId, modelId, displayName, isDefault, enabled } = parsed.data;

      const values: Partial<typeof aiModels.$inferInsert> = {};
      if (providerId !== undefined) values.providerId = providerId;
      if (modelId !== undefined) values.modelId = modelId;
      if (displayName !== undefined) values.displayName = displayName;
      if (enabled !== undefined) values.enabled = enabled;
      if (isDefault !== undefined) values.isDefault = isDefault;

      // fix round 1（I-2）：空 body `{}` → `values` 空物件，`.set({})` 同步 throw，見
      // providers PATCH 同款註解。
      if (Object.keys(values).length === 0) {
        return sendError(reply, 400, "invalid_body", "請求格式錯誤：至少需要一個欄位");
      }

      try {
        const row = await deps.db.transaction(async tx => {
          // fix round 1（I-1）：target 列先更新、**確認真的命中**之後才 unset 同 purpose
          // 其他列的 isDefault——原本的順序（先無條件 unset、之後才發現 target 不存在）
          // 會讓「PATCH 不存在的 id」這種完全不該有任何效果的請求，靜默把全站的既有
          // default 偏好清空後才回 404，交易仍然 commit（`returning()` 落空不是例外，
          // 不會觸發 rollback）。反過來做（先更新 target、拿到列才動其他列）在同一筆
          // 交易內是安全的：READ COMMITTED 下，這個交易尚未 commit 前，其他交易看不到
          // target 列被改成 isDefault=true 的中間狀態，不會有「同時兩個 default」的
          // 可觀察窗口；target 不存在時直接 return null，不做任何 unset，交易照常
          // commit（沒有任何寫入，等同 no-op）。
          const [updated] = await tx.update(aiModels).set(values).where(eq(aiModels.id, id)).returning();
          if (!updated) return null;
          if (isDefault === true) {
            await tx.update(aiModels).set({ isDefault: false }).where(and(eq(aiModels.purpose, "chat"), ne(aiModels.id, id)));
          }
          return updated;
        });
        if (!row) return sendError(reply, 404, "not_found", "找不到此 model");
        return reply.send(toModelDto(row));
      } catch (err) {
        if (isUniqueViolation(err)) return sendError(reply, 409, "model_taken", "此 provider 已有相同 model");
        if (isForeignKeyViolation(err)) return sendError(reply, 400, "invalid_body", "指定的 provider 不存在");
        throw err;
      }
    });

    app.delete("/api/admin/ai/models/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "not_found", "找不到此 model");
      const id = rawId.toLowerCase();

      // 刪除 model → 關聯 actions.modelId SET NULL（FK），走 13.2 回退鏈，不在此另外處理。
      const [deleted] = await deps.db.delete(aiModels).where(eq(aiModels.id, id)).returning({ id: aiModels.id });
      if (!deleted) return sendError(reply, 404, "not_found", "找不到此 model");
      return reply.code(204).send();
    });

    // ───────────── actions ─────────────

    app.get("/api/admin/ai/actions", { preHandler: app.requireAdmin }, async () => {
      const rows = await deps.db.select().from(aiActions).orderBy(asc(aiActions.sortOrder), asc(aiActions.id));
      return { actions: rows.map(toActionDto) };
    });

    app.post("/api/admin/ai/actions", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = createActionSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const { name, systemPrompt, userTemplate, modelId, applyMode, sortOrder, enabled } = parsed.data;

      try {
        const [row] = await deps.db
          .insert(aiActions)
          .values({
            name,
            systemPrompt,
            userTemplate,
            modelId: modelId ?? null,
            applyMode,
            sortOrder: sortOrder ?? 0,
            enabled: enabled ?? true,
          })
          .returning();
        return reply.code(201).send(toActionDto(row));
      } catch (err) {
        if (isForeignKeyViolation(err)) return sendError(reply, 400, "invalid_body", "指定的 model 不存在");
        throw err;
      }
    });

    app.patch("/api/admin/ai/actions/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "not_found", "找不到此動作");
      const id = rawId.toLowerCase();

      const parsed = patchActionSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const { name, systemPrompt, userTemplate, modelId, applyMode, sortOrder, enabled } = parsed.data;

      const values: Partial<typeof aiActions.$inferInsert> = {};
      if (name !== undefined) values.name = name;
      if (systemPrompt !== undefined) values.systemPrompt = systemPrompt;
      if (userTemplate !== undefined) values.userTemplate = userTemplate;
      if (modelId !== undefined) values.modelId = modelId;
      if (applyMode !== undefined) values.applyMode = applyMode;
      if (sortOrder !== undefined) values.sortOrder = sortOrder;
      if (enabled !== undefined) values.enabled = enabled;

      // fix round 1（I-2）：空 body `{}` → `values` 空物件，`.set({})` 同步 throw，見
      // providers PATCH 同款註解。
      if (Object.keys(values).length === 0) {
        return sendError(reply, 400, "invalid_body", "請求格式錯誤：至少需要一個欄位");
      }

      try {
        const [row] = await deps.db.update(aiActions).set(values).where(eq(aiActions.id, id)).returning();
        if (!row) return sendError(reply, 404, "not_found", "找不到此動作");
        return reply.send(toActionDto(row));
      } catch (err) {
        if (isForeignKeyViolation(err)) return sendError(reply, 400, "invalid_body", "指定的 model 不存在");
        throw err;
      }
    });

    app.delete("/api/admin/ai/actions/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "not_found", "找不到此動作");
      const id = rawId.toLowerCase();

      // 內建動作雙保險之一（server 端；UI 另一保險是不顯示刪除鈕，見 spec §13.2）：
      // 固定 id 一律拒刪，不論是否真存在於 DB（seed 是 idempotent，正常情況下必存在）。
      if (BUILTIN_ACTION_IDS.includes(id)) {
        return sendError(reply, 400, "builtin_action", "內建動作不可刪除");
      }

      const [deleted] = await deps.db.delete(aiActions).where(eq(aiActions.id, id)).returning({ id: aiActions.id });
      if (!deleted) return sendError(reply, 404, "not_found", "找不到此動作");
      return reply.code(204).send();
    });
  };
}
