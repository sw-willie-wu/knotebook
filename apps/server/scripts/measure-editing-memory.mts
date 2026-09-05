// #138 的量測腳本：跑 100 輪「7 讀 3 寫」，印出 mount／rebuild 次數與殘留 heap。
// 讀路徑每次都先 fork 一份再讀（與 `read.ts` 的 `loadNoteDoc` 同形），不直接讀 `base`——
// 直接讀 base 會讓 mount 的正規化污染基準文件，量到的就不是生產路徑的成本。
// 跑法：`cd apps/server && node --expose-gc --import tsx scripts/measure-editing-memory.mts`
// （本 task 只確認它過 `typecheck:test`；tsconfig.test.json 的 include 已含 scripts。）
import * as Y from "yjs";
import { EditingRuntime } from "../src/notes/editing/runtime.js";
import { readNoteContentFromDoc } from "../src/notes/editing/read.js";
import { EditorSession, forkFrom } from "../src/notes/editing/session.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const base = new Y.Doc();
const s0 = await EditorSession.open(rt, base);
s0.editor.replaceBlocks(
  s0.editor.document,
  Array.from({ length: 40 }, (_, i) => ({ type: "paragraph", content: `第 ${i} 段` }))
);
s0.close();
globalThis.gc?.();
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < 100; i += 1) {
  if (i % 10 < 7) {
    await readNoteContentFromDoc(rt, forkFrom(base).fork);
  } else {
    const { fork, sv } = forkFrom(base);
    const s = await EditorSession.open(rt, fork);
    s.editor.insertBlocks([{ type: "paragraph", content: "w" }], s.editor.document.at(-1)!.id, "after");
    Y.applyUpdate(base, s.diffSince(sv));
    s.close();
  }
}
globalThis.gc?.();
console.log(JSON.stringify({ mounts: rt.mounts, rebuilds: rt.rebuilds, residualMB: (process.memoryUsage().heapUsed - before) / 1048576 }));
