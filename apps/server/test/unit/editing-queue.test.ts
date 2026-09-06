import { describe, expect, it } from "vitest";
import { NoteWriteQueue, QueueBusyError } from "../../src/notes/editing/queue.js";

describe("NoteWriteQueue", () => {
  it("同 noteId 串行、不同 noteId 並行；鏈排空即刪 entry", async () => {
    const q = new NoteWriteQueue();
    const order: string[] = [];
    const slow = (tag: string, ms: number) => async () => { await new Promise(r => setTimeout(r, ms)); order.push(tag); return tag; };
    const results = await Promise.all([q.run("n1", slow("a", 30)), q.run("n1", slow("b", 5)), q.run("n2", slow("c", 5))]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(order).toEqual(["c", "a", "b"]);
    expect(q.size).toBe(0);
  });
  it("等待超過 waitMs → QueueBusyError，且前一個工作照常完成", async () => {
    const q = new NoteWriteQueue();
    const first = q.run("n1", () => new Promise<string>(r => setTimeout(() => r("first"), 80)));
    await expect(q.run("n1", async () => "second", 10)).rejects.toBeInstanceOf(QueueBusyError);
    expect(await first).toBe("first");
  });
});
