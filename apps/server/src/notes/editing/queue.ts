export class QueueBusyError extends Error { constructor() { super("note write queue busy"); } }
/** 不論成功或失敗都在 `p` 落地時落地，而且自己永不 reject（拿來當「它已經跑完」的訊號用）。 */
const settled = (p: Promise<unknown>): Promise<void> => p.then(() => undefined, () => undefined);
/** per-note 寫入佇列：兩個請求同時 fork 同一份再各自合併會讓指紋判斷失效，所以同筆記串行。process-local。 */
export class NoteWriteQueue {
  private readonly chains = new Map<string, Promise<unknown>>();
  get size(): number { return this.chains.size; }
  async run<T>(noteId: string, fn: () => Promise<T>, waitMs = 10_000): Promise<T> {
    const prev = this.chains.get(noteId) ?? Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let entered = false; // 有沒有真的輪到我、跑進 fn（busy 就是沒有）
    const gate = Promise.race([
      settled(prev).then(() => "ok" as const),
      new Promise<"busy">(r => { timer = setTimeout(() => r("busy"), waitMs); }),
    ]);
    const chain = gate.then(async state => {
      if (timer) clearTimeout(timer);
      if (state === "busy") throw new QueueBusyError();
      entered = true;
      return fn();
    });
    // ⚠ 不變量：**沒跑到 `fn` 的請求不得縮短這條鏈**。
    // busy 的意思是「等了 `waitMs` 還沒輪到我」，此刻**前一個請求還在跑**。所以這一發留在 map 裡的
    // tail 必須繼續代表「前一個跑完」（`settled(prev)`），不能代表自己——`chain` 在 busy 當下就 reject，
    // 拿它當 tail 等於對下一個到達的請求說「可以走了」。同理，逐出也**不能**無條件掛在 `chain` 落地時：
    // `finally`／`catch` 會在 reject 的那一刻執行，把一格「還有工作在飛」的 entry 刪掉，下一個請求
    // 就拿到一條全新的鏈，與仍在跑的那個**併行**（實測 maxInFlight=2）。兩件事要一起守才有用。
    // 為什麼串行非守不可：寫入路徑本來就是為了「兩個請求同時 fork 再各自合併會讓指紋判斷失效」才有
    // 這個佇列；撤回路徑更沒有退路——`POST …/:editId/revert` **沒有 `if_match`**，沒有基準值可比，
    // 它的冪等守衛（`revert.ts` 的 `editRevertable`：「這次刪除已經被還原過就不可撤回」）是在合併
    // **之前**讀 live doc 做預檢的，正確性完全建立在「前一個撤回已經合併完」之上。串行一破，兩發併發
    // 撤回會各自看到未還原的文件、各插一次 `before_blocks`，文件裡就出現兩顆同 id 的頂層 block
    // （實測 201/201、六顆頂層 block 只有四個唯一 id），而段落定址、`fingerprintForIds`、
    // `after_block_ids`、`getBlock` 全都建立在「頂層 id 唯一」之上。
    // 釘在 test/unit/editing-queue.test.ts 的「忙碌逾時後串行不得被破壞」。
    const tail = gate.then(state => (state === "busy" ? settled(prev) : settled(chain)));
    this.chains.set(noteId, tail);
    const evict = (): void => { if (this.chains.get(noteId) === tail) this.chains.delete(noteId); };
    try {
      return await chain;
    } finally {
      // 有跑到 fn：此刻工作已結束，當場收掉（`size` 對呼叫端而言與 `run` 的落地同步）。
      // 沒跑到（busy）：改等 tail——也就是等前一個真的跑完——再收，中間那格必須留著擋人。
      if (entered) evict(); else void tail.then(evict);
    }
  }
}
