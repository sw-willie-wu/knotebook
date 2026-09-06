export class QueueBusyError extends Error { constructor() { super("note write queue busy"); } }
/** per-note 寫入佇列：兩個請求同時 fork 同一份再各自合併會讓指紋判斷失效，所以同筆記串行。process-local。 */
export class NoteWriteQueue {
  private readonly chains = new Map<string, Promise<unknown>>();
  get size(): number { return this.chains.size; }
  async run<T>(noteId: string, fn: () => Promise<T>, waitMs = 10_000): Promise<T> {
    const prev = this.chains.get(noteId) ?? Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gate = Promise.race([
      prev.then(() => "ok" as const, () => "ok" as const),
      new Promise<"busy">(r => { timer = setTimeout(() => r("busy"), waitMs); }),
    ]);
    const chain = gate.then(async state => {
      if (timer) clearTimeout(timer);
      if (state === "busy") throw new QueueBusyError();
      return fn();
    });
    const tail = chain.catch(() => undefined);
    this.chains.set(noteId, tail);
    try { return await chain; } finally { if (this.chains.get(noteId) === tail) this.chains.delete(noteId); }
  }
}
