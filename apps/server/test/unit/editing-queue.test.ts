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
  // 這一案守的是 queue.ts 的不變量「沒跑到 fn 的請求不得縮短這條鏈」。busy 是「等到逾時還沒輪到我」，
  // 此刻前一個請求**還在跑**——若逾時的那一發把自己那格從 map 刪掉（或留下一個在 busy 當下就落地的
  // tail），下一個到達的請求會拿到一條全新的鏈，與仍在跑的那個併行。撤回路徑沒有 if_match，冪等守衛
  // 完全靠串行成立，一破就是「兩發併發撤回各插一次 before_blocks → 兩顆同 id 的頂層 block」。
  it("忙碌逾時後串行不得被破壞：逾時之後抵達的請求仍須等前一個跑完（同時在飛 ≤ 1）", async () => {
    const q = new NoteWriteQueue();
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirst = (): void => {};
    const firstGate = new Promise<void>(r => { releaseFirst = r; });
    const job = (tag: string, wait: Promise<void>) => async (): Promise<string> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await wait;
      inFlight -= 1;
      return tag;
    };
    const first = q.run("n1", job("first", firstGate));
    // 第二發等不到 → busy。它沒跑到 fn，所以不得動到 map 那一格
    await expect(q.run("n1", job("busy", Promise.resolve()), 10)).rejects.toBeInstanceOf(QueueBusyError);
    expect(q.size).toBe(1);
    // 第三發在 first 還在跑的時候到達
    const third = q.run("n1", job("third", Promise.resolve()), 5_000);
    await new Promise(r => setTimeout(r, 30)); // 串行被破壞的話，這段時間足夠讓 third 併行跑完
    expect(inFlight).toBe(1); // 前提守衛（不是本案的判準）：first 此刻確實還在飛，否則整案空轉
    releaseFirst();
    expect(await first).toBe("first");
    expect(await third).toBe("third");
    expect(maxInFlight).toBe(1);
    expect(q.size).toBe(0);
  });
});
