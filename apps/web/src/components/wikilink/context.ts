import { createContext } from "react";
import type { PublicLinkDto } from "@knotebook/shared";

/**
 * #269 §7.1：wikilink 的渲染情境。member（預設）＝編輯頁、viewer、版本預覽——標題來自 `["notes"]` 快取（`useNotes`）。
 * public＝公開頁——**不得呼叫 `useNotes()`**（匿名頁打 `GET /api/notes` 必 401），標題與網址只來自公開 payload 的 `links`。
 * hook 不能條件式呼叫，所以 `WikilinkInline` 依這個 context 分派到兩個元件。
 */
export type WikilinkMode = { mode: "member" } | { mode: "public"; links: ReadonlyMap<string, PublicLinkDto> };

export const WikilinkContext = createContext<WikilinkMode>({ mode: "member" });
