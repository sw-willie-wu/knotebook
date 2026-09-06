import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { NoteEditDto, NoteEditResultDto } from "@knotebook/shared";
import { api } from "./client";

/** `GET /api/notes/:id/edits` 的 query key。**匯出**是為了讓呼叫端失效時不必內聯陣列
 * 字面量（介面與碼一致，錯字就是靜默失效不到）。 */
export const NOTE_EDITS_QUERY_KEY = (noteId: string) => ["note-edits", noteId] as const;

/**
 * #106 AI 修改紀錄清單（`GET /api/notes/:id/edits`，回 `{edits}`）。
 *
 * ⚠ **`enabled` 必填，且由 dialog 的 open 驅動**：這一發只有在使用者真的打開修改紀錄
 * 時才該送出。`NotePage.test.tsx` 的 `mockFetch` 有一支 `GET /api/notes/…` 的 catch-all，
 * dialog 關著時多打的這一發**不會**在那裡炸開（它會被餵成 NoteDto），所以那 37 案
 * **守不到這件事**——真正的守衛是 `AiEditsDialog.test.tsx` 的「關著時一發都不打」那一案。
 * ⚠ **催化不是那 37 案守不到的決定性原因**（審查實測）：就算把這支 catch-all 改成直接
 * `throw`，那 37 案仍然全綠——react-query 只是把這個 reject 收進這支 query 自己的 error
 * 狀態，沒有任何斷言在看它。所以「把 mock 改嚴」不會重建這道守衛，唯一的守衛仍然只有
 * 上面那個 `AiEditsDialog.test.tsx` 的案例。
 */
export function useNoteEdits(noteId: string, options: { enabled: boolean }): UseQueryResult<NoteEditDto[]> {
  return useQuery({
    queryKey: NOTE_EDITS_QUERY_KEY(noteId),
    queryFn: () =>
      api<{ edits: NoteEditDto[] }>(`/api/notes/${encodeURIComponent(noteId)}/edits`).then(body => body.edits),
    enabled: options.enabled,
  });
}

/**
 * `POST /api/notes/:id/edits/:editId/revert`——撤回一筆 AI 修改（201）。
 *
 * 只負責失效**修改紀錄清單**：筆記本體那三把 key 由呼叫端用 `invalidateNoteQueries`
 * 處理（它需要 `NoteDto` 的 ownerHandle／slug，這支 hook 只拿得到 noteId）。
 */
export function useRevertEdit(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (editId: string) =>
      api<NoteEditResultDto>(
        `/api/notes/${encodeURIComponent(noteId)}/edits/${encodeURIComponent(editId)}/revert`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NOTE_EDITS_QUERY_KEY(noteId) });
    },
  });
}
