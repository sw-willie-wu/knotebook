/**
 * `CollabHooks` 的 Plan 2 實作——撤權 SLA（spec §7：權限變更後 ≤10s 內生效）的核心。
 *
 * 機制只有兩件事：
 *   1. **重驗（reverify）**：對受影響的連線送 `requestToken()`，並掛一個 5s deadline。
 *      client 若回送 token，`onTokenSync`（Task 5）會重跑 `resolveRole` + `gate.check`
 *      決定續留、降級唯讀或關閉，同時觸發 `onNextTokenSync` 回呼撤銷 deadline；client
 *      若不回應（離線、卡住、惡意），deadline 到期就直接關閉——「沒有查證就不放行」。
 *   2. **刪除閘門**：刪除筆記前先擋掉新連線、關閉既有連線、把文件 flush + unload，讓
 *      刪除交易跑在「沒有任何進行中連線」的前提上。
 *
 * 三個 hook 都不得往外 throw：`onShareChanged`/`onUserRevoked` 是同步 fire-and-forget，
 * 呼叫點在 DB commit 之後（見 `routes/notes.ts`、`routes/admin-users.ts`、`routes/auth.ts`），
 * throw 會讓一個其實已經成功的 API 回 500；`beforeNoteDeleted` 則是 DELETE 交易前的
 * await 點，throw 會讓「筆記刪不掉、卻已經被閘門擋住兩分鐘」（見 `DELETING_GATE_TTL_MS`）——兩種都比記錄錯誤後繼續更糟。
 */
import { COLLAB_CLOSE_NOTE_DELETED, COLLAB_CLOSE_REVOKED } from "@knotebook/shared";
import type { CollabHooks, NoteDeleteGate } from "./hooks.js";
import type { CollabServer, ConnectionHandle } from "./server.js";

/**
 * 重驗的 deadline：送出 `requestToken()` 後等 client 回送 token 的上限，逾時即關閉連線。
 *
 * 5s 是 spec §7 的 ≤10s SLA 底下留給「一次 token 往返（client 需重打
 * `POST /api/notes/:id/collab-token`）」的預算：正常路徑遠快於此（實測 <200ms），
 * 剩下的餘裕留給 DB 抖動、client 的重試退避與 API 端本身的 per-user 節流。
 */
export const REVERIFY_DEADLINE_MS = 5_000;

/**
 * 刪除閘門的 TTL。
 *
 * 閘門原本只需要覆蓋「刪除交易還沒 commit、筆記仍在」的那一小段窗口——commit 之後任何
 * 重連本來就會因為 `resolveRole` 查不到筆記而被 `onAuthenticate` 拒絕。
 *
 * ⚠ **但那個拒絕的理由是 `no-role`（wire 上的 `forbidden`），client 會據此告訴使用者
 * 「你已失去這篇筆記的存取權」——而真相是筆記被刪了**（issue #35）。分辨兩者的唯一乾淨
 * 辦法就是這道閘門：它只裝得下「這個行程剛剛刪掉的筆記」，因此不像「查 DB 看筆記在不在」
 * 那樣會變成一個任何登入使用者都能對任意 UUID 提問的存在性 oracle（REST 端刻意不區分
 * 「不存在」與「無權限」，見 `routes/notes.ts` 的防列舉說明）。
 *
 * 所以 TTL 必須**大於 client 端最長的一次重啟退避**：`TOKEN_RESTART_DELAYS_MS` 最後一格
 * 60s ＋ 25% 抖動 ＝ 最壞 75s（見 `apps/web/src/collab/useCollab.ts`）。取 120s 留餘裕。
 * 撐更久沒有意義：睡了半天才醒來的分頁本來就會落回 `forbidden`，那是可接受的降級。
 *
 * 代價：交易失敗時本來要靠 TTL 自然到期，這篇筆記會有兩分鐘連不上且畫面顯示「已刪除」。
 * 不過那條路現在由 `NoteDeleteGate.release()` 收掉（見 `beforeNoteDeleted` 的回傳值），只有
 * 「release 自己也失敗」或「併發的另一次刪除持有這道門」才會真的等到 TTL。
 */
export const DELETING_GATE_TTL_MS = 120_000;

/** unload 輪詢：上限 20 × 250ms = 5s，之後一律放行（絕不無限等，見 `beforeNoteDeleted`）。 */
const UNLOAD_POLL_INTERVAL_MS = 250;
const UNLOAD_POLL_ATTEMPTS = 20;

/**
 * 只取用得到的 `error` 方法（pino 的 `Logger`、Fastify 的 `app.log` 皆結構相容）。
 * 刻意不直接依賴 pino 型別：`createCollabHooks` 在 `buildApp()` **之前**就要被建出來
 * （AppDeps 的一部分），那時還沒有 `app.log` 可用。
 */
export interface CollabHooksLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

// 未注入 logger 時的退路。刻意不是靜默 no-op：會走到 `log.error` 的都是「撤權/刪除清掃
// 沒有照預期完成」這種必須被看見的事件，吞掉等於讓 SLA 破功時無跡可循。
const consoleLogger: CollabHooksLogger = {
  info: (obj, msg) => console.info(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createCollabHooks(server: CollabServer, log: CollabHooksLogger = consoleLogger): CollabHooks {
  /**
   * 每篇筆記目前武裝中的閘門 TTL timer，連同它屬於哪一道門（epoch）。
   *
   * **重新開閘門前要先清掉舊的**（審查 round 3）：刪除失敗後 5 秒重試成功的話，第一次那個
   * timer 會在 120 秒整點把**第二次**的閘門提早打開，而那個縫隙裡重連的協作者聽到的會是
   * 「你已失去存取權」。epoch 則保證 `release()` 不會清掉別人的 timer（審查 round 4）。
   */
  const gateTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; epoch: number }>();
  /**
   * 對指定的每一條連線要求重新出示 token，並掛上 deadline。
   *
   * ⚠ 傳進來的必須是**快照**（呼叫端一律 `[...set]`）：`connectionsOf*` 回傳的是索引裡
   * 的活集合，重驗過程若同步關閉了某條連線（例如 client 立刻回送過期 token），該集合會
   * 在迭代中被改動。
   *
   * deadline timer 對「已經關閉的連線」fire 是安全的 no-op——v4 `Connection.close` 以
   * `document.hasConnection(this)` 做冪等守衛（已對 4.5.0 原始碼核實），重複 close 不會
   * 重送 CLOSE 訊息、也不會影響同文件的其他連線。**因此刻意不做 onDisconnect 清 timer
   * 的機制**：那需要另一套「連線 → 未觸發 timer」的登記表與拆除時機，複雜度遠高於讓
   * 一個 5s 的 timer 自然到期。
   */
  function reverify(conns: Iterable<ConnectionHandle>): void {
    for (const c of conns) {
      // ⚠ **不變式：deadline timer 必須在任何可能拋錯的呼叫之前武裝。** 一次例外絕不能
      // 留下「既沒被重驗、也沒被關閉」的連線——那是 fail-open，已撤權者可以無限期繼續
      // 編輯（還只留下一行 log），正是本 task 存在的理由。先武裝再送 requestToken 是
      // 安全的：若 send 真的失敗，該連線在 v4 裡已經自我關閉，屆時 timer fire 到的是一條
      // 已關閉的連線＝冪等 no-op（`Connection.close` 的 `hasConnection` 守衛）。
      const t = setTimeout(() => {
        // timer 的 callback 跑在沒有呼叫者的 macrotask 裡：例外逸出會直接讓 process
        // 掛掉（比照 server.ts 對 upgrade listener 的處理），一律接住並記錄。
        try {
          // ⚠ 這一則必須留下訊號（issue #37／審查 round 3）：deadline 到期是**合法使用者
          // 最可能被誤踢**的路徑（他的 client 只是剛好卡在 token 退避裡沒能在 5 秒內回話），
          // 而使用者看到的是「你已失去存取權」。欄位比照 server.ts 的 `logReject`，
          // phase 另立 `deadline`——它不是握手被拒，也不是重驗有了結論。
          //
          // ⚠ 但**只有這條連線還在索引裡才算數**（審查指出）：timer 對已關閉的連線 fire 是
          // 安全的 no-op（見上面的說明），使用者自己關掉分頁也會走到這裡——照記的話，排錯
          // 指引最倚重的那一行會指著一個根本沒被踢的人說「他是被踢的」。
          const stillConnected = [...server.connectionsOfNote(c.noteId)].includes(c);
          if (stillConnected) {
            log.info(
              { phase: "deadline", noteId: c.noteId, userId: c.userId, cause: "no-reverify", reason: COLLAB_CLOSE_REVOKED },
              "collab 重驗逾時關閉連線"
            );
          }
          c.close(COLLAB_CLOSE_REVOKED);
        } catch (error) {
          log.error({ err: error, noteId: c.noteId, userId: c.userId }, "collab 重驗 deadline 關閉連線失敗");
        }
      }, REVERIFY_DEADLINE_MS);

      // 每條連線各自 try/catch：一條連線的意外不得讓**其餘連線漏掉重驗**——那正是
      // 「已被撤權的人還在編輯」這個失效模式。（v4.5.0 的 `Connection.send` 本身已把
      // 送出失敗吞掉並改為關閉該連線，所以這裡實務上不會進 catch；純粹是不把整批撤權
      // 的正確性押在那個實作細節上。）
      try {
        // ⚠ 這個回呼若是在一次**進行中**的 onTokenSync 期間登記的（該次已經把 callbacks
        // 取走清空了，見 server.ts 的 hoist-take-and-clear），它就不會被那一次觸發；若那次
        // 重驗的結論是關閉連線，這個回呼便永遠等不到下一次 token sync 而被丟棄，pending 的
        // timer 隨後對一條已關閉的連線 fire ——同上，安全 no-op。
        server.onNextTokenSync(c, () => clearTimeout(t));
        c.requestToken(); // fire-and-forget，無內建 timeout
      } catch (error) {
        log.error({ err: error, noteId: c.noteId, userId: c.userId }, "collab 重驗單一連線失敗，立即關閉該連線");
        // fail-closed：連「要求重驗」都做不到的連線沒有續留的理由，不必讓它多活 5s。
        // 上面的 timer 刻意**不**清除——萬一這裡的 close 自己也拋錯，它仍是最後一道保險。
        try {
          c.close(COLLAB_CLOSE_REVOKED);
        } catch (closeError) {
          log.error(
            { err: closeError, noteId: c.noteId, userId: c.userId },
            "collab 重驗失敗後關閉連線亦失敗（deadline timer 仍為保險）"
          );
        }
      }
    }
  }

  return {
    /**
     * N1：只重驗「該 note ∩ 該 user」的連線，**不得**對整份文件廣播——同文件其他協作者
     * 的權限沒有變化，無故要他們重新出示 token 會製造無謂的 token endpoint 尖峰（還會
     * 撞上 per-user 節流），且任何一次 client 沒回應都可能誤殺一條合法連線。
     */
    onShareChanged(noteId: string, userId: string): void {
      try {
        reverify([...server.connectionsOfNote(noteId)].filter(c => c.userId === userId));
      } catch (error) {
        log.error({ err: error, noteId, userId }, "collab onShareChanged 重驗失敗");
      }
    },

    /** 停用帳號／改密碼：該使用者**跨所有文件**的連線全部重驗。 */
    onUserRevoked(userId: string): void {
      try {
        reverify([...server.connectionsOf(userId)]);
      } catch (error) {
        log.error({ err: error, userId }, "collab onUserRevoked 重驗失敗");
      }
    },

    /**
     * 刪除筆記前的清場：擋新連線 → 關既有連線 → flush → unload → 輪詢確認。
     *
     * ⚠ 刻意**偏離** spec §7 字面上的 `closeConnections`：v4 的 `closeConnections()` 是以
     * `ResetConnection` 關閉，語意等同「叫 provider 立刻重連」；而此刻刪除交易尚未
     * commit、筆記還在，重連會通過授權並讓文件重新進 `server.documents`，輪詢永遠不會
     * 收斂、DELETE 請求掛死。這裡改用「閘門 + 逐連線 close」保留 §7 的意圖（所有人都該
     * 離開）而不製造活鎖。
     *
     * ⚠ 這個機制**不保證**「刪除前絕對沒有任何 update 被套用」：`connected` 的
     * deleting 重查只能擋下「還沒被登記進索引」的連線，擋不掉它在 onAuthenticate 通過後、
     * connected 抵達前那段時間從佇列 drain 出來、已經套用進 Y.Doc 的 update。真正的
     * 資料面保證來自兩件事：刪除本身是一個交易，以及 Task 7 的 `onStoreDocument` 見到
     * 筆記已不存在就丟棄該次寫入——所以即使有落單的 update，也不會在筆記刪除後復活。
     */
    async beforeNoteDeleted(noteId: string): Promise<NoteDeleteGate> {
      // 先關門：此後 onAuthenticate / connected / onTokenSync 三處都會拒絕這篇筆記
      // （Task 5 已實作），下面的清掃才不會邊掃邊有新連線補進來。
      const epoch = await server.markDeleting(noteId);

      const previous = gateTimers.get(noteId);
      if (previous !== undefined) clearTimeout(previous.timer);

      // TTL。`unref()`：這個計時器不該讓 process（或測試 worker）為了它多活兩分鐘——
      // 閘門只在服務執行中才有意義，行程要結束時直接跟著消失即可。
      const ttl = setTimeout(() => {
        gateTimers.delete(noteId);
        server.unmarkDeleting(noteId);
      }, DELETING_GATE_TTL_MS);
      ttl.unref();
      gateTimers.set(noteId, { timer: ttl, epoch });

      const gate: NoteDeleteGate = {
        release: () => {
          void server
            .releaseDeletingGate(noteId, epoch)
            .then(released => {
              if (!released) return;
              const armed = gateTimers.get(noteId);
              // 只清自己那一顆：release 期間可能已經有新的刪除接手了。
              if (armed?.epoch !== epoch) return;
              clearTimeout(armed.timer);
              gateTimers.delete(noteId);
            })
            .catch((error: unknown) => {
              log.error({ err: error, noteId }, "collab 刪除失敗後收閘門亦失敗（閘門將由 TTL 自然到期）");
            });
        },
      };

      try {
        // 逐連線 close（帶 reason，client 端據此顯示「筆記已被刪除」而不是重連）。取快照
        // 迭代：`close()` 會同步觸發 `connection.onClose` → 把自己從索引集合中移除。
        for (const c of [...server.connectionsOfNote(noteId)]) c.close(COLLAB_CLOSE_NOTE_DELETED);

        // 把 debounce 中的 onStoreDocument 立刻執行——不可 await（回傳 void），落地與否
        // 由下面的 unload 輪詢間接觀察。
        server.hocuspocus.flushPendingStores();

        const doc = server.hocuspocus.documents.get(noteId);
        // 有進行中的 store 時 `unloadDocument` 會靜默 no-op（`shouldUnloadDocument` 為
        // false），所以下面要輪詢重試。不 await：unload 內含 hook 執行，正常情況下瞬間
        // 完成，我們要的訊號是 `documents` 裡的那筆消失。`.catch` 是為了不讓它變成
        // unhandled rejection 把行程打掛（例如某個 unload hook 拋錯）。
        if (doc) void server.hocuspocus.unloadDocument(doc).catch(() => {});

        for (let i = 0; i < UNLOAD_POLL_ATTEMPTS && server.hocuspocus.documents.has(noteId); i += 1) {
          await sleep(UNLOAD_POLL_INTERVAL_MS);
          const d = server.hocuspocus.documents.get(noteId);
          if (d) void server.hocuspocus.unloadDocument(d).catch(() => {});
        }

        if (server.hocuspocus.documents.has(noteId)) {
          // 逾時（上限 5s）：記錯後**放行**，絕不無限等——DELETE 掛死對使用者是更嚴重的
          // 故障，而資料面已有 Task 7 的「筆記不存在就丟棄 store」兜底，不會復活。
          log.error({ noteId }, "collab beforeNoteDeleted：文件在期限內未 unload，仍繼續刪除（store 會被 Task 7 丟棄）");
        }
      } catch (error) {
        // 清場失敗不得讓 DELETE 回 500：閘門已經關上，交易照跑，殘留的連線最遲在下一次
        // 重驗／訊息往返時就會因為筆記不存在而被拒。
        log.error({ err: error, noteId }, "collab beforeNoteDeleted 清場失敗，仍繼續刪除");
      }

      return gate;
    },

    linkSyncGate(noteId: string, userId: string): { ok: true; clock: number } | { ok: false } {
      return server.linkSyncState(noteId, userId);
    },
  };
}
