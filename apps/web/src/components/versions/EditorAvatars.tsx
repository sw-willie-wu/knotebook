import type { VersionEditorDto } from "@knotebook/shared";
import { Avatar } from "@/components/Avatar";

const MAX_SHOWN = 3;
const SIZE = 20;

/**
 * 版本列的編輯者頭貼群：重疊排列、至多 3 個，其餘以「+N」收尾。
 * 以 handle 去重（同一人以人與 agent 兩種身分出現只畫一個）；已刪除的使用者
 * （handle 空字串）合成一個「?」占位。agent 寫入的編輯者畫使用者本人的頭貼。
 * 整塊 aria-hidden：可及資訊由列上的 `editorsText` 提供。
 */
export function EditorAvatars({ editors }: { editors: VersionEditorDto[] }) {
  const seen = new Set<string>();
  const unique: VersionEditorDto[] = [];
  for (const e of editors) {
    if (seen.has(e.handle)) continue;
    seen.add(e.handle);
    unique.push(e);
  }
  if (unique.length === 0) return null;
  const shown = unique.slice(0, MAX_SHOWN);
  const extra = unique.length - shown.length;
  return (
    <span aria-hidden="true" className="inline-flex h-5 shrink-0 items-center">
      {shown.map((e, i) => (
        <span key={e.handle} data-editor-avatar="" className={i === 0 ? "inline-flex rounded-full ring-2 ring-card" : "-ms-1.5 inline-flex rounded-full ring-2 ring-card"}>
          <Avatar name={e.handle} avatar={e.avatar ?? null} size={SIZE} />
        </span>
      ))}
      {extra > 0 && <span aria-hidden="true" className="ms-1 text-[11px] leading-none text-muted-foreground">{`+${extra}`}</span>}
    </span>
  );
}
