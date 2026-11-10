/**
 * 在線頭像列的 awareness 欄位。`knotebook` 欄只增不改形，`v` 讓 #312 可並存；
 * 欄位刻意不含任何網址，頭貼只以 `AvatarRef` 表達。
 */
import type { AvatarRef } from "./avatar.js";

/** awareness 狀態上本 app 自己的欄位名（BlockNote 擁有 `user`、y-prosemirror 擁有 `cursor`）。 */
export const PRESENCE_FIELD = "knotebook";

/** AI 代理的游標色與頭像外框色（server `PRESENCE_COLOR` 取這一份）。 */
export const AGENT_PRESENCE_COLOR = "#7c3aed";

/**
 * 共編游標的顏色。同一個使用者在任何裝置、任何筆記都要是同一色，所以不能用亂數——
 * 從 userId 做一個穩定的 32-bit 雜湊再映到色相環。飽和度/亮度寫死，確保深淺兩個
 * 主題下都看得見（y-prosemirror 會把這個顏色同時當游標線與名牌背景）。
 * 從 NoteEditor.tsx 原封搬來（本體逐字不變）；頭像列與 #312 的 server 端共用。
 */
export function collabUserColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (Math.imul(hash, 31) + seed.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360} 65% 45%)`;
}

export type PresenceRole = "owner" | "editor" | "viewer";

export interface UserPresenceField {
  v: 1;
  kind: "user";
  role: PresenceRole;
  avatar: AvatarRef | null;
  since: number;
}

export interface AgentPresenceField {
  v: 1;
  kind: "agent";
  handle: string;
  label: string;
}

export type PresenceField = UserPresenceField | AgentPresenceField;
