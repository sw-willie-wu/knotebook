import { createContext, useContext, type RefObject } from "react";
import type { CollabState } from "@/collab/connection";

/** NotePage 交給側欄 ⋮ 的「目前開著的那篇」控制（只在 NotePage 已解析出 noteId 時有值）。
 * 側欄 ⋮ 對這一篇的刪除要共用 NotePage 的 `leavingRef`／共編狀態（理由見 NoteMenu.tsx 檔頭 M11），
 * 「AI 修改紀錄」直接開 NotePage 的對話框、不導頁。 */
export interface NotePageControls {
  noteId: string;
  state: CollabState;
  leavingRef: RefObject<boolean>;
  openEdits: () => void;
}

export const NotePageControlsContext = createContext<NotePageControls | null>(null);

/** 側欄對「別篇」按 AI 修改紀錄時帶的 location.state；NotePage 讀同一個型別（兩端鍵名不會漂）。 */
export interface OpenEditsState {
  openEdits: true;
}

/** 沒有 provider（首頁、管理頁）回 null——側欄在那些頁面上一律當「別篇」處理。 */
export function useNotePageControls(): NotePageControls | null {
  return useContext(NotePageControlsContext);
}
