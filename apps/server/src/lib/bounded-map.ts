/**
 * 這個專案裡所有「每個 key 一筆小紀錄」的暫存表共用的上限預設。數字本身不是算出來的，
 * 是「大到正常自架規模永遠碰不到、小到被灌爆時記憶體不會失控」的門檻。
 */
export const DEFAULT_MAX_KEYS = 10_000;

/**
 * 有上限的 Map：超過 `maxKeys` 時淘汰**最舊插入**的那一筆。
 *
 * 這個專案裡有三處各自手抄過同一段 `delete → 檢查 size → 砍最前面 → set` 的樣板
 * （`http/rate-limit.ts` 的 `FixedWindowLimiter`、`auth/session.ts` 的 `UserGate`，
 * 以及原本**漏掉上限**的 `auth/rate-limit.ts` 的 `LoginThrottle`，issue #15）。抽成一個
 * 型別讓那份紀律只有一份實作：新的暫存表要有上限時用它，就不會再有人忘記。
 *
 * 淘汰語意（刻意的簡化，別當成嚴格 LRU）：
 * - **插入序即淘汰序**。JS `Map` 的迭代順序就是插入順序，所以「最前面那個」＝最久沒有被
 *   `set()` 過的 key。
 * - `set()` 一律先 `delete` 再 `set`，因此**重寫既有 key 會把它移到尾端**。呼叫端據此
 *   決定「什麼事件算刷新」：`FixedWindowLimiter` 只在開新視窗時 set（純計數不刷新），
 *   `LoginThrottle` 則每次失敗都 set（最近失敗的最晚被淘汰）。
 * - `get()` **不**重排。純讀取命中不影響淘汰順序。
 *
 * 上限本身是可被利用的：灌爆不同 key 可以把別人的紀錄擠掉（對 `LoginThrottle` 而言就是
 * 把一筆封鎖中的退避擠掉）。這是所有「有界暫存表」共有的取捨；讓淨汰順序對得起語意
 * （見上面「什麼事件算刷新」）只把門檻抬高，**不能當成防線**：帳號軌被記上的是攻擊者
 * 根本不在乎的假 email，而 IP 軌在 `trustProxy: true` 下（issue #13）可以偽造。真正的成本
 * 來自別處：每一發失敗登入都要付一次 argon2 驗證。這個殘餘風險已載入
 * `docs/self-hosting.md` 的 trustProxy 那段。
 */
export class BoundedMap<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly maxKeys: number) {
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      // 靜靜地退化成無上限是這個類別唯一不能接受的失敗模式（那正是 issue #15 的病灶），
      // 寧可在啟動時就炸。
      throw new RangeError(`BoundedMap: maxKeys 必須是 >= 1 的整數，收到 ${maxKeys}`);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    return this.entries.get(key);
  }

  /** 寫入並移到尾端（最新）；滿了就砍掉最前面（最舊）的那一筆。 */
  set(key: string, value: V): void {
    this.entries.delete(key);
    if (this.entries.size >= this.maxKeys) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(key, value);
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }
}
