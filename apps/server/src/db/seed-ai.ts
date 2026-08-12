import type { Db } from "./index.js";
import { aiActions } from "./schema.js";

// 內建四動作的固定 UUID——一次生成後寫死，讓 seed 具備跨環境（開發機/CI/生產）一致的
// 冪等身分：`ON CONFLICT (id) DO NOTHING` 需要一個穩定的衝突鍵，若每次啟動都
// `defaultRandom()` 現生，第二次啟動會插出四筆重複的內建動作，而非「維持已存在的那筆」。
const REWRITE_ID = "ab0a1517-bec1-4709-b13f-756548375b86";
const TRANSLATE_ID = "362788cb-d2f0-41ce-b697-c929b67bf20e";
const SUMMARIZE_ID = "2e37a47e-a6cd-4f14-b2f6-0cdebd715b2a";
const CONTINUE_WRITING_ID = "4a8e18da-1d9c-4be1-ba32-a0c5429b0a22";

export const BUILTIN_ACTION_IDS: readonly string[] = [REWRITE_ID, TRANSLATE_ID, SUMMARIZE_ID, CONTINUE_WRITING_ID];

/**
 * 內建四動作定案內容（brief 逐字，不做 i18n key 映射——`name` 是 DB 資料、UI 原樣
 * 顯示，非 UI chrome；admin 可在後台自行改名，docs/ai.md 會說明）。`modelId` 留空
 * （NULL）：內建動作預設不綁特定 model，由 admin 於後台設定；`sortOrder` 依表列順序。
 */
const BUILTIN_ACTIONS = [
  {
    id: REWRITE_ID,
    name: "Rewrite",
    systemPrompt:
      "You are an expert editor. Rewrite the user's text to improve clarity and flow while preserving its meaning, language, and Markdown formatting. Reply with the rewritten text only.",
    userTemplate: "{{text}}",
    applyMode: "direct" as const,
    sortOrder: 0,
  },
  {
    id: TRANSLATE_ID,
    name: "Translate",
    systemPrompt:
      "Translate the user's text: if it is mostly Chinese, translate to English; otherwise translate to Traditional Chinese. Preserve Markdown formatting. Reply with the translation only.",
    userTemplate: "{{text}}",
    applyMode: "direct" as const,
    sortOrder: 1,
  },
  {
    id: SUMMARIZE_ID,
    name: "Summarize",
    systemPrompt: "Summarize the user's text concisely in its own language, preserving the key points. Reply with the summary only, in Markdown.",
    userTemplate: "{{text}}",
    applyMode: "preview" as const,
    sortOrder: 2,
  },
  {
    id: CONTINUE_WRITING_ID,
    name: "Continue writing",
    systemPrompt:
      "Continue writing from where the user's text ends, matching its language, tone, and Markdown formatting. Reply with the complete text: the original followed by your continuation.",
    userTemplate: "{{text}}",
    applyMode: "preview" as const,
    sortOrder: 3,
  },
];

/**
 * 內建 AI 動作 idempotent seed（spec §13）。掛在 `runMigrations` 既有的 idempotent
 * seed 流程尾端（見 `migrate.ts`）。`ON CONFLICT (id) DO NOTHING`：admin 事後改動
 * （改 prompt、停用……）不會被重跑的 seed 覆寫或復活——只有「該 id 完全不存在」才會
 * 插入，符合 §13 的「內建動作是初始值，非強制同步」語意。
 */
export async function seedAiActions(db: Db): Promise<void> {
  await db.insert(aiActions).values(BUILTIN_ACTIONS).onConflictDoNothing({ target: aiActions.id });
}
