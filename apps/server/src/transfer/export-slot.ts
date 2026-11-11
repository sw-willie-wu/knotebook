/**
 * bulk transfer：全站同時 1 個整包匯出。每個 `transferRoutes` 實例一個（＝每個 app 一個，測試互不污染）。
 *
 * `tryAcquire()` 回一個**只能放一次**的 release 函式（拿不到回 null）。刻意不做成 slot 上的 `release()`：持有者重複放行時，
 * 若別人已經拿到，slot 層的 release 會把別人的放掉（所以不用 `tryAcquire(): boolean`／`release()` 形）。
 */
export class ExportSlot {
  private holder: symbol | null = null;

  get busy(): boolean {
    return this.holder !== null;
  }

  tryAcquire(): (() => void) | null {
    if (this.holder !== null) return null;
    const me = Symbol("export");
    this.holder = me;
    return () => {
      if (this.holder === me) this.holder = null;
    };
  }
}
