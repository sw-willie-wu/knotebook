import type { QueryClient } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { deleteFolderRequest, invalidateFolderRelated, isFolderNotFound, moveFolderRequest, placeNoteRequest } from "@/api/folders";
import { applyMovedNote, refetchAfterFailure } from "@/api/note-move";
import type { DestTarget } from "@/components/sidebar/destination-level";
import type { SelectionTarget } from "@/components/sidebar/select-model";
import type { SelectionNode } from "@/lib/sidebar-selection";

/**
 * 一般 tab 選取模式的批次執行（#181 PR-2c，spec §6.11「執行」、D-M4）。只准被 SelectLazy 鏈與測試 import。
 * - 不用 mutation hook：批次要能跑完整輪，即使中途動作列或抽屜卸載（換頁、關抽屜、Done）；結果由呼叫端依 session 決定要不要套用。
 * - 依序（await 完一篇才送下一篇）：不開批次端點（spec §6.11），沿用單篇端點的交易、權限與容量檢查；依序才停得住、才回報得出「已完成幾篇」。
 * - 分類（Willie 裁定）：403、404 `not_found` → 略過、繼續；其餘（429、404 `group_not_found`、409、400、5xx、網路錯誤、
 *   非 JSON 的 `internal`）→ 停下。move 的 409 `conflict`（授權之後、上鎖之前歸屬變了）是窄競態：停下安全、不掉資料。
 * - 複製扣寫入節流（`limiters.edit` 30 次／60 秒，有附件再扣 upload 桶）：一次複製約 30 篇以上會撞 429 而停下。
 * - 停下時的 `remaining` 是選取鍵形（`{ kind, id }`）：呼叫端直接 `setAll` 回選取；PR-3b 的資料夾項放 `{ kind: "folder", id }`。
 * - 整批的快取失效一律在 `finally`：hook 丟例外時整批 reject，已送出的仍要對帳。
 */

/**
 * 403、404 not_found → 略過；其餘 → 停下（讀碼發現 13，Willie 裁定）。
 * 404 `folder_not_found`：`folderGone: "skip"` 時略過（只給刪資料夾：要刪的已不在）；預設停下（明選的目的地不在了，spec §6.10）。
 */
export function classifyBatchError(err: unknown, opts: { folderGone?: "skip" | "stop" } = {}): "skip" | "stop" {
  if (isFolderNotFound(err)) return opts.folderGone === "skip" ? "skip" : "stop";
  if (err instanceof ApiFail && (err.status === 403 || (err.status === 404 && err.code === "not_found"))) return "skip";
  return "stop";
}

export interface BatchOutcome<R> {
  /** 依送出順序。 */
  done: R[];
  /** 只計 server 回的略過（client 預先排除的由呼叫端加）。 */
  skipped: number;
  /** 每一筆略過的項目與錯誤（依送出順序）：呼叫端分「沒有權限」與「已不存在」（資料夾 404 `folder_not_found`）。 */
  skippedDetail: Array<{ node: SelectionNode; err: unknown }>;
  /** 停下那篇（含）之後全部未成功的項目，以選取鍵形回傳（gate r1 m13）：PR-3b 的資料夾項直接放 `{ kind: "folder", id }`。 */
  stopped: { cause: unknown; remaining: SelectionNode[] } | null;
}

type BatchHooks = { onProgress?: (processed: number, total: number) => void };

/** 依序（await 完一項才送下一項）。`beforeEach` 在送出前同步呼叫；`onProgress(processed, total)` 在每項結束（成功、略過）後呼叫。
 * hook 不得丟例外：丟了整批 reject、沒有 outcome（已完成篇數與「復原」都拿不到），只剩 finally 的失效。
 * `classify` 預設 `classifyBatchError`（PR-2c 呼叫端不傳、行為不變）。 */
export async function runSequential<T, R>(
  items: readonly T[],
  nodeOf: (item: T) => SelectionNode,
  run: (item: T) => Promise<R>,
  hooks: {
    beforeEach?: (item: T) => void;
    afterFailure?: (item: T, err: unknown, kind: "skip" | "stop") => void;
    onProgress?: (processed: number, total: number) => void;
    classify?: (err: unknown, item: T) => "skip" | "stop";
  } = {},
): Promise<BatchOutcome<R>> {
  const classify = hooks.classify ?? ((err: unknown) => classifyBatchError(err));
  const done: R[] = [];
  const skippedDetail: Array<{ node: SelectionNode; err: unknown }> = [];
  for (const [index, item] of items.entries()) {
    hooks.beforeEach?.(item);
    try {
      done.push(await run(item));
    } catch (err) {
      const kind = classify(err, item);
      hooks.afterFailure?.(item, err, kind);
      if (kind === "stop") {
        return { done, skipped: skippedDetail.length, skippedDetail, stopped: { cause: err, remaining: items.slice(index).map(nodeOf) } };
      }
      skippedDetail.push({ node: nodeOf(item), err });
    }
    hooks.onProgress?.(index + 1, items.length);
  }
  return { done, skipped: skippedDetail.length, skippedDetail, stopped: null };
}

const noteNode = (note: NoteDto): SelectionNode => ({ kind: "note", id: note.id });
const notePath = (id: string): string => `/api/notes/${encodeURIComponent(id)}`;

/** `DELETE /api/notes/:id`（移到垃圾桶）；`done` 收原 NoteDto。失效同單篇 `useDeleteNote`。 */
export async function trashNotesInOrder(
  notes: readonly NoteDto[],
  deps: {
    queryClient: QueryClient;
    beforeEach?: (n: NoteDto) => void;
    afterFailure?: (n: NoteDto, err: unknown, kind: "skip" | "stop") => void;
  } & BatchHooks,
): Promise<BatchOutcome<NoteDto>> {
  const { queryClient } = deps;
  const doneIds: string[] = [];
  try {
    return await runSequential(
      notes,
      noteNode,
      async (note) => {
        await api<void>(notePath(note.id), { method: "DELETE" });
        doneIds.push(note.id);
        return note;
      },
      { beforeEach: deps.beforeEach, afterFailure: deps.afterFailure, onProgress: deps.onProgress },
    );
  } finally {
    void queryClient.invalidateQueries({ queryKey: ["notes"] });
    void queryClient.invalidateQueries({ queryKey: ["backlinks"] });
    void queryClient.invalidateQueries({ queryKey: ["trash"] });
    for (const id of doneIds) void queryClient.invalidateQueries({ queryKey: ["note", id] });
  }
}

/**
 * `POST /api/notes/:id/move { groupId, folderId? }`（根層不帶 folderId）；成功逐篇 `applyMovedNote`，失敗（略過或停下）逐篇
 * `refetchAfterFailure`（順序契約見 `api/note-move.ts`）。finally 失效 groups、folders。
 */
export async function moveNotesInOrder(
  notes: readonly NoteDto[],
  body: { groupId: string; folderId?: string },
  deps: { queryClient: QueryClient } & BatchHooks,
): Promise<BatchOutcome<NoteDto>> {
  const { queryClient } = deps;
  const payload = JSON.stringify(body.folderId === undefined ? { groupId: body.groupId } : { groupId: body.groupId, folderId: body.folderId });
  try {
    return await runSequential(
      notes,
      noteNode,
      async (note) => {
        const moved = await api<NoteDto>(`${notePath(note.id)}/move`, { method: "POST", body: payload });
        applyMovedNote(queryClient, note.id, moved);
        return moved;
      },
      {
        afterFailure: (note) => {
          void refetchAfterFailure(queryClient, note.id);
        },
        onProgress: deps.onProgress,
      },
    );
  } finally {
    void queryClient.invalidateQueries({ queryKey: ["groups"] });
    void queryClient.invalidateQueries({ queryKey: ["folders"] });
  }
}

type CopyBody = { groupId?: string; folderId?: string };

/** 固定目的地的 body：群組空間帶 groupId、資料夾帶 folderId；個人根層 → `{}`（根層一律不帶 folderId，`null` 會 400）。 */
function placeCopyBody(target: Extract<DestTarget, { kind: "place" }>): CopyBody {
  const body: CopyBody = {};
  if (target.space.kind === "group") body.groupId = target.space.groupId;
  if (target.folder !== null) body.folderId = target.folder.id;
  return body;
}

/** 「建立副本」：每篇落回自己的群組與資料夾（D18 ②）。 */
function makeCopyBody(note: NoteDto): CopyBody {
  const body: CopyBody = {};
  if (note.groupId !== null) body.groupId = note.groupId;
  if (note.folderId !== null) body.folderId = note.folderId;
  return body;
}

/**
 * `POST /api/notes/:id/copy`；`done` 收副本，逐篇寫進 `["note", copy.id]`。finally 失效 notes、folders。
 * - makeCopy：每篇 `{ groupId?: note.groupId, folderId?: note.folderId }`；404 `folder_not_found`（原資料夾已不在）時該篇不帶 folderId
 *   重送一次（n6 逐篇退回根層），重送再失敗照一般分類。
 * - 其餘 target：固定 body；明選的資料夾 404 `folder_not_found` → 停下、不重送（spec §6.10）。
 */
export async function copyNotesInOrder(
  notes: readonly NoteDto[],
  target: DestTarget,
  deps: { queryClient: QueryClient } & BatchHooks,
): Promise<BatchOutcome<NoteDto>> {
  const { queryClient } = deps;
  const post = (note: NoteDto, body: CopyBody) => api<NoteDto>(`${notePath(note.id)}/copy`, { method: "POST", body: JSON.stringify(body) });
  try {
    return await runSequential(
      notes,
      noteNode,
      async (note) => {
        let copy: NoteDto;
        if (target.kind === "place") copy = await post(note, placeCopyBody(target));
        else {
          const body = makeCopyBody(note);
          try {
            copy = await post(note, body);
          } catch (err) {
            if (body.folderId === undefined || !isFolderNotFound(err)) throw err;
            copy = await post(note, body.groupId === undefined ? {} : { groupId: body.groupId });
          }
        }
        queryClient.setQueryData(["note", copy.id], copy);
        return copy;
      },
      { onProgress: deps.onProgress },
    );
  } finally {
    void queryClient.invalidateQueries({ queryKey: ["notes"] });
    void queryClient.invalidateQueries({ queryKey: ["folders"] });
  }
}

/** 放置一筆的原處（復原用）。 */
export type PlacedItem = { kind: "note"; id: string; from: string | null } | { kind: "folder"; id: string; from: string | null };

const targetNode = (target: SelectionTarget): SelectionNode =>
  target.kind === "note" ? { kind: "note", id: target.note.id } : { kind: "folder", id: target.folder.id };
const placedNode = (item: PlacedItem): SelectionNode => ({ kind: item.kind, id: item.id });

/** 一筆放到 folderId（null＝根層）：資料夾 PATCH {parentId}、筆記 PUT {folderId}；成功的筆記寫進 `["note", id]`。 */
async function placeOne(queryClient: QueryClient, kind: "note" | "folder", id: string, folderId: string | null): Promise<void> {
  if (kind === "folder") {
    await moveFolderRequest(id, folderId);
    return;
  }
  const placed = await placeNoteRequest(id, folderId);
  queryClient.setQueryData(["note", placed.id], placed);
}

/**
 * 同空間（spec §6.10「執行」）：資料夾 PATCH {parentId}、筆記 PUT {folderId}（根層 null），依序、不確認；`done` 帶各自原處（復原用）。
 * 分類預設（folder_not_found＝目的地不在了 → 停下）。finally `invalidateFolderRelated(qc, { trash: 有資料夾 })`。
 */
export async function placeTargetsInOrder(
  items: readonly SelectionTarget[],
  folderId: string | null,
  deps: { queryClient: QueryClient } & BatchHooks,
): Promise<BatchOutcome<PlacedItem>> {
  const { queryClient } = deps;
  try {
    return await runSequential(
      items,
      targetNode,
      async (target): Promise<PlacedItem> => {
        if (target.kind === "folder") {
          await placeOne(queryClient, "folder", target.folder.id, folderId);
          return { kind: "folder", id: target.folder.id, from: target.folder.parentId };
        }
        await placeOne(queryClient, "note", target.note.id, folderId);
        return { kind: "note", id: target.note.id, from: target.note.folderId };
      },
      { onProgress: deps.onProgress },
    );
  } finally {
    invalidateFolderRelated(queryClient, { trash: items.some((target) => target.kind === "folder") });
  }
}

/**
 * D18 ③ 復原：把 done 逐一送回 from，依序；分類同 classifyBatchError（預設：429 等停下）；回 outcome（呼叫端報已移回幾項）。
 * finally 同 placeTargetsInOrder。
 */
export async function undoPlacements(items: readonly PlacedItem[], deps: { queryClient: QueryClient }): Promise<BatchOutcome<PlacedItem>> {
  const { queryClient } = deps;
  try {
    return await runSequential(items, placedNode, async (item) => {
      await placeOne(queryClient, item.kind, item.id, item.from);
      return item;
    });
  } finally {
    invalidateFolderRelated(queryClient, { trash: items.some((item) => item.kind === "folder") });
  }
}

/**
 * 刪除（spec §6.10）：資料夾先（`DELETE /api/folders/:id`，404 `folder_not_found` 略過＝已不在）、筆記後（`DELETE /api/notes/:id`），
 * 各自維持輸入順序；beforeEach／afterFailure 同 PR-2c 形。`done[].trashedNoteIds`：資料夾＝server 回的、筆記＝[自己]。
 * finally 失效 folders／notes／trash／backlinks 與每篇移到垃圾桶的 `["note", id]`。
 */
export async function deleteTargetsInOrder(
  items: readonly SelectionTarget[],
  deps: {
    queryClient: QueryClient;
    beforeEach?: (t: SelectionTarget) => void;
    afterFailure?: (t: SelectionTarget, err: unknown, kind: "skip" | "stop") => void;
  } & BatchHooks,
): Promise<BatchOutcome<{ target: SelectionTarget; trashedNoteIds: string[] }>> {
  const { queryClient } = deps;
  const ordered = [...items.filter((target) => target.kind === "folder"), ...items.filter((target) => target.kind === "note")];
  const trashedIds: string[] = [];
  try {
    return await runSequential(
      ordered,
      targetNode,
      async (target) => {
        let trashedNoteIds: string[];
        if (target.kind === "folder") trashedNoteIds = (await deleteFolderRequest(target.folder.id)).trashedNoteIds;
        else {
          await api<void>(notePath(target.note.id), { method: "DELETE" });
          trashedNoteIds = [target.note.id];
        }
        trashedIds.push(...trashedNoteIds);
        return { target, trashedNoteIds };
      },
      {
        beforeEach: deps.beforeEach,
        afterFailure: deps.afterFailure,
        onProgress: deps.onProgress,
        classify: (err, target) => (target.kind === "folder" ? classifyBatchError(err, { folderGone: "skip" }) : classifyBatchError(err)),
      },
    );
  } finally {
    invalidateFolderRelated(queryClient, { trash: true });
    void queryClient.invalidateQueries({ queryKey: ["backlinks"] });
    for (const id of trashedIds) void queryClient.invalidateQueries({ queryKey: ["note", id] });
  }
}
