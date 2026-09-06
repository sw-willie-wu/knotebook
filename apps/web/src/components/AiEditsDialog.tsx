import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { NoteDto, NoteEditDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useNoteEdits, useRevertEdit } from "@/api/noteEdits";
import { invalidateNoteQueries } from "@/api/notes";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

/** 逐檔複製的既有慣例（無共用 helper——比照 ShareDialog／NoteMenu）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

function EditRow({ note, edit }: { note: NoteDto; edit: NoteEditDto }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const revert = useRevertEdit(note.id);

  const who = edit.agentLabel === null ? edit.byHandle : `${edit.byHandle} (${edit.agentLabel})`;

  async function handleRevert(): Promise<void> {
    try {
      await revert.mutateAsync(edit.id);
      // 撤回改的是筆記本體，`last_edited_*` 也跟著變——三把 note key 一起失效。
      // `ref` 傳 `note.id`：這個 dialog 只拿得到 `NoteDto`，路由當下用的 ref 是
      // `NotePage` 的事（它自己那條遠端更新路徑會帶對的 ref 進來）。
      invalidateNoteQueries(queryClient, note, note.id);
      toast({ title: t("aiEdits.revertOk") });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <li data-testid={`ai-edit-${edit.id}`} className="flex items-start justify-between gap-3 rounded-md border border-border p-2">
      <div className="min-w-0 space-y-1">
        {/* handle 與 agent 名稱都是外部字串——比照 ApiTokensSection 的名稱欄做 bidi 隔離。 */}
        <p dir="ltr" className="truncate text-sm [unicode-bidi:isolate]" data-testid="ai-edit-who">
          {who}
        </p>
        <p className="text-xs text-muted-foreground">
          {new Date(edit.createdAt).toLocaleString(i18n.language)}
          {" · "}
          {/* op 刻意留原始的 API 字面值（`replace_section`…）：這份清單對應的就是呼叫端
              送出的 op，翻譯反而讓人對不回自己送了什麼。
              但書：`revert` 這個值不成立這個理由——它不是呼叫端能送出的操作（write
              端點的 `EditOp` 不含它），是撤回端點自己合成、標記「這筆是撤回紀錄」的值
              （見 `apps/server/src/notes/editing/revert.ts` 寫入 `op: "revert"` 那行）。 */}
          <code>{edit.op}</code>
          {edit.heading !== "" && ` · ${edit.heading}`}
        </p>
      </div>
      {edit.revertable ? (
        <Button type="button" variant="outline" size="sm" disabled={revert.isPending} onClick={() => void handleRevert()}>
          {t("aiEdits.revert")}
        </Button>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">
          {edit.revertedAt !== null ? t("aiEdits.reverted") : t("aiEdits.stale")}
        </span>
      )}
    </li>
  );
}

/**
 * AI 修改紀錄 dialog（#106 spec §5／§10）。開關狀態住在 `NotePage`——這個 dialog 有
 * **兩個觸發點**（⋮ 選單項與頁首的 `LastEditedLabel`），狀態放在任一個元件內另一個
 * 就打不開（與 `ShareDialog`／`NoteMenu` 自持狀態的慣例相反，理由在此）。
 *
 * ⚠ 清單 query **以 `open` 為閘門**：關著的 dialog 不該對 `GET /api/notes/:id/edits`
 * 發請求（它有節流桶，而且 `NotePage` 每開一篇筆記就會掛一份）。守衛見
 * `AiEditsDialog.test.tsx` 的「關著時一發都不打」那一案。
 */
export function AiEditsDialog({
  note,
  open,
  onOpenChange,
}: {
  note: NoteDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const edits = useNoteEdits(note.id, { enabled: open });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 這個 dialog 沒有描述句（清單本身就是內容）——不給 Radix 一個不存在的
          aria-describedby 目標。 */}
      <DialogContent className="max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t("aiEdits.title")}</DialogTitle>
        </DialogHeader>
        {edits.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : edits.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, edits.error)}
          </p>
        ) : edits.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("aiEdits.empty")}</p>
        ) : (
          <ul className="max-h-80 space-y-2 overflow-y-auto">
            {edits.data.map(edit => (
              <EditRow key={edit.id} note={note} edit={edit} />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
