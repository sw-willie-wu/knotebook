import { describe, expect, it, vi, afterEach } from "vitest";
import { createCollabHooks, DELETING_GATE_TTL_MS } from "../../src/collab/hooks-impl.js";
import type { CollabServer } from "../../src/collab/server.js";

/**
 * `beforeNoteDeleted` 開的閘門與它回傳的 `release()` handle（issue #35 審查 round 3／4）。
 *
 * 這一層在 server 那側的測試看不到：整合測試直接呼叫 `collab.markDeleting/releaseDeletingGate`，
 * 而 `notes.test.ts` 用的是 mock 過的 hook。於是 hooks-impl 這邊的兩個修正——「重開閘門前先清掉
 * 舊 timer」與「release 只收自己那一道門」——刪掉都不會有測試變紅，而症狀只是「協作者偶爾看到
 * 錯的那句話」。這個檔案就是釘它們的。
 */
const NOTE = "11111111-1111-1111-1111-111111111111";

/** 只實作 `beforeNoteDeleted` 會碰到的那幾個成員。 */
function fakeServer(): { server: CollabServer; calls: { mark: number[]; release: Array<[string, number]>; unmark: string[] } } {
  const calls = { mark: [] as number[], release: [] as Array<[string, number]>, unmark: [] as string[] };
  let epoch = 0;
  const server = {
    markDeleting: async (): Promise<number> => {
      epoch += 1;
      calls.mark.push(epoch);
      return epoch;
    },
    releaseDeletingGate: async (noteId: string, e: number): Promise<boolean> => {
      calls.release.push([noteId, e]);
      return true;
    },
    unmarkDeleting: (noteId: string): void => {
      calls.unmark.push(noteId);
    },
    connectionsOfNote: () => new Set(),
    hocuspocus: {
      flushPendingStores: () => {},
      documents: new Map(),
      unloadDocument: async () => {},
    },
  } as unknown as CollabServer;
  return { server, calls };
}

const silentLog = { info: () => {}, error: () => {} };

describe("beforeNoteDeleted 的閘門 handle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("重開閘門會清掉前一次的 TTL timer（否則第一顆會把第二道門提早打開）", async () => {
    vi.useFakeTimers();
    const { server, calls } = fakeServer();
    const hooks = createCollabHooks(server, silentLog);

    await hooks.beforeNoteDeleted(NOTE);
    await hooks.beforeNoteDeleted(NOTE);

    await vi.advanceTimersByTimeAsync(DELETING_GATE_TTL_MS + 1_000);
    // 舊 timer 沒被清掉的話這裡會是 2——第一顆會在第二道門還該關著的時候把它打開。
    expect(calls.unmark).toEqual([NOTE]);
  });

  it("release() 收的是「自己那一道門」的世代序號，不是當下最新的那一道", async () => {
    const { server, calls } = fakeServer();
    const hooks = createCollabHooks(server, silentLog);

    const first = await hooks.beforeNoteDeleted(NOTE);
    await hooks.beforeNoteDeleted(NOTE);
    expect(calls.mark).toEqual([1, 2]);

    first.release();
    await vi.waitFor(() => expect(calls.release).toHaveLength(1));
    // 帶的是 1（自己那道），不是 2——否則併發的第二次刪除成功時，第一次的失敗會把它的
    // 閘門關掉，接下來兩分鐘重連的協作者都會聽到「你已失去存取權」。
    expect(calls.release[0]).toEqual([NOTE, 1]);
  });
});
