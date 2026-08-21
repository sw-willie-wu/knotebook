import { describe, expect, it, vi, afterEach } from "vitest";
import { createCollabHooks, DELETING_GATE_TTL_MS, REVERIFY_DEADLINE_MS } from "../../src/collab/hooks-impl.js";
import type { CollabServer, ConnectionHandle } from "../../src/collab/server.js";

/**
 * 兩組東西：`beforeNoteDeleted` 開的閘門與它回傳的 `release()` handle（issue #35 審查
 * round 3／4），以及重驗 deadline 那一行日誌的守衛（issue #37 補審）。
 *
 * 這一層在 server 那側的測試看不到：整合測試直接呼叫 `collab.markDeleting/releaseDeletingGate`，
 * 而 `notes.test.ts` 用的是 mock 過的 hook。於是 hooks-impl 這邊的兩個修正——「重開閘門前先清掉
 * 舊 timer」與「release 只收自己那一道門」——刪掉都不會有測試變紅，而症狀只是「協作者偶爾看到
 * 錯的那句話」。這個檔案就是釘它們的。
 */
const NOTE = "11111111-1111-1111-1111-111111111111";

/** 只實作 `beforeNoteDeleted`／`reverify` 會碰到的那幾個成員。 */
function fakeServer(connections: Set<ConnectionHandle> = new Set()): {
  server: CollabServer;
  calls: { mark: number[]; release: Array<[string, number]>; unmark: string[] };
} {
  const calls = { mark: [] as number[], release: [] as Array<[string, number]>, unmark: [] as string[] };
  let epoch = 0;
  const server = {
    connectionsOfNote: () => connections,
    onNextTokenSync: () => {},
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
    hocuspocus: {
      flushPendingStores: () => {},
      documents: new Map(),
      unloadDocument: async () => {},
    },
  } as unknown as CollabServer;
  return { server, calls };
}

function recordingLog(): { log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void }; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  return {
    lines,
    log: {
      info: (obj: object) => lines.push({ ...obj }),
      error: (obj: object) => lines.push({ ...obj }),
    },
  };
}

const silentLog = { info: () => {}, error: () => {} };

/** 一條假的「文件連線」：只要 `reverify` 會碰到的成員。 */
function fakeHandle(noteId: string, userId: string): ConnectionHandle {
  return {
    socketId: "s1",
    noteId,
    userId,
    requestToken: () => {},
    close: () => {},
    setReadOnly: () => {},
  };
}

/**
 * 重驗 deadline 的那一行日誌（issue #37／PR #49 補審）。
 *
 * ⚠ 這條 timer 對「已經關閉的連線」fire 是刻意的冪等 no-op，所以**使用者自己關掉分頁**也會
 * 走到這裡。照記的話，docs 排錯指引最倚重的那一行（「他若堅持自己還有權限，這行說了不是」）
 * 會指著一個根本沒被踢的人。守衛是「這條連線還在索引裡嗎」，而它自己也得有測試——不然
 * 拿掉它不會有任何測試變紅（這一族在 round 3→4 就踩過同一個形狀）。
 */
describe("重驗 deadline 的日誌", () => {
  const USER = "22222222-2222-2222-2222-222222222222";

  afterEach(() => {
    vi.useRealTimers();
  });

  it("連線還在索引裡（client 只是沒回話）→ 記一行 deadline", async () => {
    vi.useFakeTimers();
    const handle = fakeHandle(NOTE, USER);
    const { server } = fakeServer(new Set([handle]));
    const { log, lines } = recordingLog();

    createCollabHooks(server, log).onShareChanged(NOTE, USER);
    await vi.advanceTimersByTimeAsync(REVERIFY_DEADLINE_MS + 100);

    const line = lines.find(one => one.phase === "deadline");
    expect(line).toMatchObject({ cause: "no-reverify", noteId: NOTE, userId: USER });
  });

  it("連線已經不在索引裡（使用者自己關了分頁）→ 一行都不記", async () => {
    vi.useFakeTimers();
    const handle = fakeHandle(NOTE, USER);
    const live = new Set([handle]);
    const { server } = fakeServer(live);
    const { log, lines } = recordingLog();

    createCollabHooks(server, log).onShareChanged(NOTE, USER);
    // 分頁在 deadline 之前關掉：server 端的 `connection.onClose` 會同步把 handle 拆出索引。
    live.delete(handle);
    await vi.advanceTimersByTimeAsync(REVERIFY_DEADLINE_MS + 100);

    // 標題說「一行都不記」就整份斷言——只濾 deadline 的話，catch 分支寫出的 error 行會被
    // 放過，而那句話就變成半真（審查指出）。
    expect(lines).toEqual([]);
  });
});

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
