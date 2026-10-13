import {
  CONTINUE_WRITING_ACTION_ID,
  INSTRUCT_ACTION_ID,
  REWRITE_ACTION_ID,
  SUMMARIZE_ACTION_ID,
  TRANSLATE_ACTION_ID,
} from "@knotebook/shared";
import type { Db } from "./index.js";
import { aiActions } from "./schema.js";

/**
 * 內建五動作定案內容（brief 逐字，不做 i18n key 映射——`name` 是 DB 資料、UI 原樣顯示，非 UI chrome；admin 可在後台自行改名，
 * docs/ai.md 會說明）。固定 UUID 住 `@knotebook/shared` 的 `ai.ts`（#263：web 也要用它判 chip 的 icon 與 Instruct）。
 * `modelId` 留空（NULL）：內建動作預設不綁特定 model，由 admin 於後台設定；`sortOrder` 依表列順序。
 * `applyMode`：五個一律 preview（#263 後續，2026-10-13：Rewrite/Translate 原為 direct）。seed 只插入缺的 id，所以只影響新安裝；
 * 既有站台的值不動，direct 仍可由 admin 在後台設定。
 * Instruct（#263 §4.1）：自由指令；template 的三個佔位符由 `routes/ai.ts` 包上固定標記後代入、system prompt 前置 server 固定的守門
 * （`ai/instruct.ts`），這裡的 systemPrompt 只管語氣與風格。
 */
const BUILTIN_ACTIONS = [
  {
    id: REWRITE_ACTION_ID,
    name: "Rewrite",
    systemPrompt:
      "You are an expert editor. Rewrite the user's text to improve clarity and flow while preserving its meaning, language, and Markdown formatting. Reply with the rewritten text only.",
    userTemplate: "{{text}}",
    applyMode: "preview" as const,
    sortOrder: 0,
  },
  {
    id: TRANSLATE_ACTION_ID,
    name: "Translate",
    systemPrompt:
      "Translate the user's text: if it is mostly Chinese, translate to English; otherwise translate to Traditional Chinese. Preserve Markdown formatting. Reply with the translation only.",
    userTemplate: "{{text}}",
    applyMode: "preview" as const,
    sortOrder: 1,
  },
  {
    id: SUMMARIZE_ACTION_ID,
    name: "Summarize",
    systemPrompt: "Summarize the user's text concisely in its own language, preserving the key points. Reply with the summary only, in Markdown.",
    userTemplate: "{{text}}",
    applyMode: "preview" as const,
    sortOrder: 2,
  },
  {
    id: CONTINUE_WRITING_ACTION_ID,
    name: "Continue writing",
    systemPrompt:
      "Continue writing from where the user's text ends, matching its language, tone, and Markdown formatting. Reply with the complete text: the original followed by your continuation.",
    userTemplate: "{{text}}",
    applyMode: "preview" as const,
    sortOrder: 3,
  },
  {
    id: INSTRUCT_ACTION_ID,
    name: "Instruct",
    systemPrompt:
      "You are an expert editor working on a note. Follow the user's instruction for the given text, preserving its language and Markdown formatting unless the instruction says otherwise.",
    userTemplate: "{{instruction}}\n{{focus}}\n{{text}}",
    applyMode: "preview" as const,
    sortOrder: 4,
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
