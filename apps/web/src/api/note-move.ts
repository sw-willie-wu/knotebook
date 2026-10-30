import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { NoteDto, ShareDto } from "@knotebook/shared";
import { api } from "./client";
import type { PublicLinkDto } from "./public-link";

/**
 * #175 PR2：移動（個人→群組）與複製（spec §6.3、§6.5、§8.3、§8.4）。沿用 v1 `api/note-group.ts`（ab8f824）的兩條順序契約：
 * - **成功的快取寫入序**：先 `['shares', id]`＝`[]`、`['public-link', id]`＝token／slug 清空（函式型：保留 width、快取空不寫），**再** `['note', id]`——
 *   三次同步、中間無 await。note 一換成群組形，`ShareDialog` 的觸發鈕就改讀 public-link；若 public-link 還是舊 token，
 *   會閃一下「公開」（PR1 交接不變量⑥）。
 * - **失敗的對帳序**（`refetchAfterFailure`）：先 await shares／public-link 失效重抓、之後才失效 note 與 groups；
 *   一律 `void` 呼叫，**不得**從 `onError` 回傳 promise（TanStack 會等它，`retry: 3` 讓錯誤回饋拖 7 秒——v1 gate r2 M1）。
 */
function writeMovedNote(queryClient: QueryClient, note: NoteDto): void {
  queryClient.setQueryData(["note", note.id], note);
  void queryClient.invalidateQueries({ queryKey: ["notes"] });
  void queryClient.invalidateQueries({ queryKey: ["note-by-path"] });
  void queryClient.invalidateQueries({ queryKey: ["note-by-group-path"] });
  void queryClient.invalidateQueries({ queryKey: ["backlinks"] });
}

/** 移入群組成功後的快取寫入（PR1 交接不變量⑥：先 shares／public-link，再 note）。單篇 hook 與 PR-2c 批次共用。 */
export function applyMovedNote(queryClient: QueryClient, noteId: string, note: NoteDto): void {
  queryClient.setQueryData<ShareDto[]>(["shares", noteId], []);
  queryClient.setQueryData<PublicLinkDto>(["public-link", noteId], prev => (prev ? { ...prev, token: null, slug: null } : prev));
  writeMovedNote(queryClient, note);
}

/** 失敗的對帳序（先 await shares／public-link，再失效 note 與 groups）。呼叫端一律 `void`，不得從 onError 回傳。 */
export async function refetchAfterFailure(queryClient: QueryClient, noteId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["shares", noteId] }),
    queryClient.invalidateQueries({ queryKey: ["public-link", noteId] }),
  ]);
  void queryClient.invalidateQueries({ queryKey: ["note", noteId] });
  void queryClient.invalidateQueries({ queryKey: ["groups"] });
}

export function useMoveNoteToGroup(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation<NoteDto, Error, { groupId: string; folderId?: string }>({
    mutationFn: (input: { groupId: string; folderId?: string }) =>
      api<NoteDto>(`/api/notes/${encodeURIComponent(noteId)}/move`, {
        method: "POST",
        body: JSON.stringify(input.folderId === undefined ? { groupId: input.groupId } : { groupId: input.groupId, folderId: input.folderId }),
      }),
    onSuccess: note => {
      applyMovedNote(queryClient, noteId, note);
    },
    onError: () => {
      void refetchAfterFailure(queryClient, noteId);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

export function useCopyNote(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation<NoteDto, Error, { groupId?: string; folderId?: string }>({
    mutationFn: (input: { groupId?: string; folderId?: string }) =>
      api<NoteDto>(`/api/notes/${encodeURIComponent(noteId)}/copy`, {
        method: "POST",
        body: JSON.stringify({
          ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
          ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
        }),
      }),
    onSuccess: copy => {
      queryClient.setQueryData(["note", copy.id], copy);
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

/**
 * 送出前檢查（PR1 交接不變量④）：重讀筆記，仍是「我能移動的個人筆記」→ true；否則先 await shares／public-link 失效、
 * 再寫 `['note', id]`、回 false（呼叫端不得送出）。刻意不用 `fetchQuery`：它一回來就寫常駐層快取，面板會在 shares
 * 對帳之前重掛（v1 gate r1 M1 的 sticky「私人」）。讀取失敗照常 throw。
 */
export function useConfirmNoteStillPersonal(noteId: string) {
  const queryClient = useQueryClient();
  return async (): Promise<boolean> => {
    const latest = await api<NoteDto>(`/api/notes/${encodeURIComponent(noteId)}`);
    if (latest.groupId === null && latest.permissions.moveToGroup) return true;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["shares", noteId] }),
      queryClient.invalidateQueries({ queryKey: ["public-link", noteId] }),
    ]);
    queryClient.setQueryData(["note", noteId], latest);
    void queryClient.invalidateQueries({ queryKey: ["notes"] });
    void queryClient.invalidateQueries({ queryKey: ["note-by-path"] });
    void queryClient.invalidateQueries({ queryKey: ["note-by-group-path"] });
    void queryClient.invalidateQueries({ queryKey: ["groups"] });
    return false;
  };
}
