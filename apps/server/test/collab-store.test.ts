import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { eq } from "drizzle-orm";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteStateBackups, noteStates } from "../src/db/schema.js";
import { createNoteStore } from "../src/collab/store.js";
import { buildCollabTestApp } from "./helpers.js";

const PASSWORD = "correct-horse-battery";

/** 在 doc 的共編 fragment 插入一個含文字的 XML 元素——模擬 BlockNote 的一次編輯。 */
function insertParagraph(doc: Y.Doc, text: string): void {
  const element = new Y.XmlElement("paragraph");
  element.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);
}

/** 輪詢等待條件成立（同步 check，比照 collab-sync/collab-revocation）。 */
async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(`等待逾時（${timeoutMs}ms）：${label}`);
}

/** 同上，但 check 本身是 async（輪詢 DB 用）。 */
async function waitForAsync(label: string, timeoutMs: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`等待逾時（${timeoutMs}ms）：${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe("Task 7：onLoadDocument/onStoreDocument + 樂觀鎖 + 分桶備份", () => {
  it("編輯後 ≤5s note_states 有資料，內容與編輯一致", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-store1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-store1@example.com", PASSWORD);
    const client = await session.connect(note.id);

    insertParagraph(client.doc, "hello store");

    await waitForAsync("note_states 有資料", 5_000, async () => {
      const [row] = await ctx.db.select({ noteId: noteStates.noteId }).from(noteStates).where(eq(noteStates.noteId, note.id)).limit(1);
      return row !== undefined;
    });

    const [row] = await ctx.db.select().from(noteStates).where(eq(noteStates.noteId, note.id)).limit(1);
    expect(row?.version).toBe(1);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, row!.ydoc);
    expect(restored.getXmlFragment(YDOC_FRAGMENT).toString()).toBe("<paragraph>hello store</paragraph>");
  });

  it("斷線重連：內容從 note_states 還原（文件確實從記憶體卸載後才重連）", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-store2@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-store2@example.com", PASSWORD);

    const a = await session.connect(note.id);
    insertParagraph(a.doc, "persisted content");

    await waitForAsync("note_states 落地", 5_000, async () => {
      const [r] = await ctx.db.select({ noteId: noteStates.noteId }).from(noteStates).where(eq(noteStates.noteId, note.id)).limit(1);
      return r !== undefined;
    });

    a.disconnect();

    // 確認文件真的從 Hocuspocus 記憶體卸載——否則重連可能拿到同一個仍在記憶體裡的
    // Document 實例，測不到「真的從 DB 還原」這件事。
    await waitFor("文件從記憶體卸載", 5_000, () => !ctx.collab.hocuspocus.documents.has(note.id));

    const b = await session.connect(note.id);
    expect(b.doc.getXmlFragment(YDOC_FRAGMENT).toString()).toBe("<paragraph>persisted content</paragraph>");
  });

  it("同一個 15 分桶內兩次編輯 → 恰 1 筆 backup（第二次落地不重複備份）", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-store3@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-store3@example.com", PASSWORD);
    const client = await session.connect(note.id);

    insertParagraph(client.doc, "v1");
    await waitForAsync("第一次 store 落地", 5_000, async () => {
      const [r] = await ctx.db.select({ version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, note.id)).limit(1);
      return r?.version === 1;
    });

    insertParagraph(client.doc, "v2");
    await waitForAsync("第二次 store 落地", 5_000, async () => {
      const [r] = await ctx.db.select({ version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, note.id)).limit(1);
      return r?.version === 2;
    });

    // 兩次落地都發生在同一個真實時鐘的 15 分桶內（兩次相隔僅數秒）——第一次因
    // lastBackupAt=null 必寫一筆；第二次未跨桶，必須被跳過。
    const backups = await ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, note.id));
    expect(backups.length).toBe(1);
  });

  it("跨桶但內容未變（state vector 相等）→ 不寫新 backup（直接呼叫 store.ts：真實 15 分桶邊界無法在測試中等待，需要可控時鐘）", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-store4@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);

    // 這個子測試刻意不透過即時協作的 WebSocket 往返——backup-policy 的桶邊界對齊真實
    // UTC 時鐘的 15 分鐘寬度，測試等不起；而「內容未變」的前提又要求兩次 store 之間
    // doc 完全沒有新編輯（有編輯 sv 必然改變，測不到這條規則）。用獨立的
    // `createNoteStore` 實例（同一個 ctx.db）搭配可控 `now` 直接驗證，是唯一可行的作法。
    let clock = new Date("2026-01-05T10:07:00Z");
    const store = createNoteStore({ db: ctx.db, now: () => clock });

    const doc = new Y.Doc();
    await store.onLoadDocument(note.id, doc); // 無既有 row：sv 快取以空 doc 初始化

    insertParagraph(doc, "only edit");
    await store.onStoreDocument(note.id, doc); // 首次 store：lastBackupAt=null→true 且 sv 與空 doc 不同 → 應寫 1 筆 backup

    let backups = await ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, note.id));
    expect(backups.length).toBe(1);

    // 跨到下一個 15 分桶（10:07 所在 [10:00,10:15) → 10:20 所在 [10:15,10:30)），doc
    // 完全沒有再編輯，sv 應與快取相同。
    clock = new Date("2026-01-05T10:20:00Z");
    await store.onStoreDocument(note.id, doc);

    backups = await ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, note.id));
    expect(backups.length).toBe(1); // 沒有新增

    // 佐證：note_states 仍照常被覆寫（唯一寫入者規則不受「跳過備份」影響）。
    const [row] = await ctx.db.select({ version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, note.id)).limit(1);
    expect(row?.version).toBe(2);
  });

  it("刪除期間 pending store 不復活資料列（用預設 noop hooks：DELETE 落地時 store debounce 仍 pending）", async () => {
    // 刻意用預設（noop）collabHooks，不是 Task 6 的真實作——真實作的 beforeNoteDeleted
    // 會在刪除交易前 flush+unload，讓 store 早於 DELETE 落地，測不到「資料列被復活」
    // 這個競態；noop 才會讓 DELETE 在 store debounce 仍 pending 時搶先落地，正是本規則
    // 存在的理由（Task 6 的 gate 依賴這條規則成立）。
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-store5@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-store5@example.com", PASSWORD);
    const client = await session.connect(note.id);

    insertParagraph(client.doc, "doomed by delete");

    // 立刻刪除，趕在 2000ms 的 store debounce 觸發之前。
    const delRes = await session.fetch(`/api/notes/${note.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);

    // 等過 debounce + 保險餘裕，讓 pending store 真的跑一次。
    await sleep(3_000);

    const rows = await ctx.db.select().from(noteStates).where(eq(noteStates.noteId, note.id));
    expect(rows).toEqual([]);

    const backupRows = await ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, note.id));
    expect(backupRows).toEqual([]);
  });
});
