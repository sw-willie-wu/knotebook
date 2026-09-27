import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { NoteDto, ShareDto, ShareRole } from "@knotebook/shared";
import { api } from "./client";
import type { PublicLinkDto } from "./public-link";

/**
 * 筆記歸屬（#103 PR3，spec §6.2／§8.3）。三支 hook、兩個端點，全是 owner-only、session-only，
 * 回 `NoteDto`（server 以 `toNoteDto(note, "owner", false)` 輸出，owner 一律看得到 `group`）。
 *
 * - `useMoveNoteToGroup`：`PUT …/group`，`groupId` **不等於**目前的群組（個人→群組、群組→群組）。
 *   server 同一交易刪光逐人分享、撤銷公開連結（含別名）。
 * - `useSetNoteGroupRole`：`PUT …/group`，`groupId` **等於**目前的群組——server 只改 `group_role`，
 *   **不清任何東西**。所以它**不得**寫 shares／public-link 快取：公開的群組筆記改唯讀之後連結仍在，
 *   寫成 null 會讓觸發鈕與 radio 誤報「群組內可見」。這是兩支分開的理由。
 * - `useRemoveNoteGroup`：`DELETE …/group`，不動公開連結（A10）；群組筆記本來就沒有逐人分享（S5）。
 *
 * **搬家的快取寫入順序（spec §8.3，契約）**：**先**寫 `['shares', id]`＝`[]` 與
 * `['public-link', id]`＝`{token:null, slug:null}`，**之後**才寫 `['note', id]`。三次
 * `setQueryData` 都是同步呼叫、中間沒有 await。順序照 spec 寫死，由 `note-group.test.tsx` 的
 * spy 案釘住；若日後在兩者之間插入 `await`（例如改成先等某個失效），順序就變成畫面可見的承重。
 *
 * 三支成功後都失效 `['notes']`（側欄分段看 `note.group`）與 `['note-by-path']`（解析層的舊 DTO）。
 * 失敗時先重抓 shares／public-link，再失效 `['note', id]` 與 `['groups']`（`refetchAfterFailure`）：
 * 409 `conflict`（筆記已不在群組，例如群組剛被刪）、404 `group_not_found`（目標群組剛被刪或我剛被
 * 移出）都表示畫面上的歸屬或群組清單過時了。另有 `useConfirmNoteGroupUnchanged`：元件在三種送出之前
 * 先用它確認群組沒在別處被改。
 *
 * ⚠ **`useSetNoteGroupRole` 的競態**（gate r1 M3）：server 以交易內讀到的 `group_id` 分流
 * （`routes/notes.ts:1269`）。若別的分頁已把這篇移出群組或搬到別的群組，而本面板還顯示舊群組，這支
 * 「只改權限」的 PUT 會走**換群組**分支——刪逐人分享、撤公開連結、把筆記搬回舊群組。元件送出前以
 * `useConfirmNoteGroupUnchanged` 擋掉大部分情形；檢查到送出之間的窗口仍在（根因是同一支端點兩種語意，
 * server 契約；建議見 plan）。
 */
function writeNote(queryClient: QueryClient, note: NoteDto): void {
  queryClient.setQueryData(["note", note.id], note);
  void queryClient.invalidateQueries({ queryKey: ["notes"] });
  void queryClient.invalidateQueries({ queryKey: ["note-by-path"] });
}

/**
 * 失敗後的對帳。**順序承重**（gate r1 M1，與 `api/groups.ts` 的 `useDeleteGroup` 同一條規則）：先
 * `await` shares／public-link 重抓，之後才失效 note。情境：面板開著時別人刪了群組（D8 把成員物化成
 * 逐人分享）→ 我選「無」→ `DELETE` 回 409 `conflict` → note 重抓後變個人筆記 → `AccessSection`
 * 以新 key 重掛，而個人筆記是「快取有就 latch」；若 shares 還是群組筆記時的 `[]`，radio 會 sticky 地
 * 停在「私人」。`ShareDialog.test.tsx` 的「DELETE 409（群組已被刪）」案釘住。
 *
 * ⚠ **不得從 `onError` 回傳這個 promise**（gate r2 M1）：TanStack 會先 await `onError` 才讓 mutation
 * 結算，`mutateAsync` 要等重抓結束才 reject——server 在出錯時，預設 `retry: 3`（1s／2s／4s）會把
 * 錯誤回饋拖住約 7 秒，期間按鈕全停用、沒有任何訊息。所以三支 hook 都寫 `void refetchAfterFailure(…)`；
 * 順序（先 shares／public-link、後 note）在這支函式**內部**保住。「PUT 500」案釘住。
 */
async function refetchAfterFailure(queryClient: QueryClient, noteId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["shares", noteId] }),
    queryClient.invalidateQueries({ queryKey: ["public-link", noteId] }),
  ]);
  void queryClient.invalidateQueries({ queryKey: ["note", noteId] });
  void queryClient.invalidateQueries({ queryKey: ["groups"] });
}

/**
 * 送出前檢查（Willie 2026-09-27 裁決 M3：「B 在改權限時要先檢查最新狀態，發現已經移出去了要重新
 * 整理」）。重讀 `GET /api/notes/:id`，群組 id 與面板顯示的相同 → `true`（呼叫端照常送出）；不同 →
 * 面板對齊 server 後回 `false`（呼叫端不得送出）。對齊的順序與 `refetchAfterFailure` 同一條規則：
 * **先** await shares／public-link 重抓，**之後**才把新的 note 寫進 `['note', id]`。
 *
 * ⚠ 刻意**不**用 `queryClient.fetchQuery({ queryKey: ['note', id] })`：它一回來就寫進常駐層快取，
 * `AccessSection` 立刻以新 key 重掛、拿舊的 shares latch——正是 M1 那個 sticky「私人」。
 * 讀取失敗（例如筆記已被刪，404 `not_found`）照常 throw，呼叫端當成錯誤顯示、不送出。
 * 殘留窗口：檢查回來到送出之間，別處仍可能改掉群組（TOCTOU），這裡擋不住。
 */
export function useConfirmNoteGroupUnchanged(noteId: string) {
  const queryClient = useQueryClient();
  return async (expectedGroupId: string | null): Promise<boolean> => {
    const latest = await api<NoteDto>(`/api/notes/${encodeURIComponent(noteId)}`);
    if ((latest.group?.id ?? null) === expectedGroupId) return true;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["shares", noteId] }),
      queryClient.invalidateQueries({ queryKey: ["public-link", noteId] }),
    ]);
    queryClient.setQueryData(["note", noteId], latest);
    void queryClient.invalidateQueries({ queryKey: ["notes"] });
    void queryClient.invalidateQueries({ queryKey: ["note-by-path"] });
    void queryClient.invalidateQueries({ queryKey: ["groups"] });
    return false;
  };
}

function putGroup(noteId: string, body: { groupId: string; role: ShareRole }): Promise<NoteDto> {
  return api<NoteDto>(`/api/notes/${encodeURIComponent(noteId)}/group`, { method: "PUT", body: JSON.stringify(body) });
}

export function useMoveNoteToGroup(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { groupId: string; role: ShareRole }) => putGroup(noteId, body),
    onSuccess: (note) => {
      queryClient.setQueryData<ShareDto[]>(["shares", noteId], []);
      queryClient.setQueryData<PublicLinkDto>(["public-link", noteId], { token: null, slug: null });
      writeNote(queryClient, note);
    },
    onError: () => {
      void refetchAfterFailure(queryClient, noteId);
    },
  });
}

export function useSetNoteGroupRole(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { groupId: string; role: ShareRole }) => putGroup(noteId, body),
    onSuccess: (note) => writeNote(queryClient, note),
    onError: () => {
      void refetchAfterFailure(queryClient, noteId);
    },
  });
}

export function useRemoveNoteGroup(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<NoteDto>(`/api/notes/${encodeURIComponent(noteId)}/group`, { method: "DELETE" }),
    onSuccess: (note) => writeNote(queryClient, note),
    onError: () => {
      void refetchAfterFailure(queryClient, noteId);
    },
  });
}
