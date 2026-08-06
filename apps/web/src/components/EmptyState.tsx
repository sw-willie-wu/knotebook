import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

/**
 * 通用「空狀態」引導區塊。目前兩處共用同一套外觀、各自帶入不同文案：
 * `NoteList`（使用者尚無任何筆記，引導建立第一篇）與 `HomePage` 主內容區
 * （`/notes/:ref` 尚未存在——Task 13——`/` 底下永遠沒有「選取中的筆記」，
 * 依是否已有筆記顯示「建立第一篇」或「請從側欄選取」引導）。
 */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 p-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {action}
    </div>
  );
}
