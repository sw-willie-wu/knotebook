import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { SESSION_COOKIE } from "@knotebook/shared";
import { signSession } from "../src/auth/session.js";
import { presenceClientId } from "../src/notes/editing/presence.js";
import { buildCollabTestApp, testConfig } from "./helpers.js";
import { bearer, getContent, seedContent, seedTokenForUser, tick, waitFor } from "./editing-helpers.js";

const PASSWORD = "correct-horse-battery";

async function scene(opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
  const ctx = await buildCollabTestApp(opts);
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  // ⚠ heading 同級（Global Constraints）：`## B` 會被 sectionize 併進 A 段，outline[2] 變 undefined
  const client = await seedContent(ctx, session, note.id, "# A\n\n第一段內容\n\n# B\n\n第二段內容");
  const { token, tokenId } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code");
  const id = presenceClientId(note.id, tokenId);
  // ⚠ handle 不是 email 的 local part：users.handle 的 DB default 是 'user-<8hex>'，ctx.createUser 不設它。
  //    寫死 "a" 會紅；放寬成 expect.any(String) 會把「名牌指向正確的人」整條守衛拿掉（#137 r4 N-2）。
  const ownerHandle = (await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}`, headers: bearer(token) })).json().ownerHandle as string;
  const expectedName = `${ownerHandle} (claude)`;
  const remote = () => client.provider.awareness!.getStates().get(id) as { user?: { name: string; color: string }; cursor?: { anchor: unknown } } | undefined;
  const remoteClock = () => client.provider.awareness!.meta.get(id)?.clock;
  const cursorText = () => {
    const r = remote();
    if (!r?.cursor) return null;
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(r.cursor.anchor as never), client.doc);
    return abs ? (abs.type as Y.XmlText).toString() : null;
  };
  const outline = async () => (await getContent(ctx.app, note.id, token)).json().outline as Array<{ sectionId: string; heading: string; fingerprint: string }>;
  return { ctx, u, note, session, client, token, tokenId, id, ownerHandle, expectedName, remote, remoteClock, cursorText, outline };
}

describe("presence", () => {
  it("token 讀 → provider 出現 `handle (label)` 與顏色、游標在文件開頭；?section= → 該段第一顆；_top → 文件開頭", async () => {
    const s = await scene();
    await getContent(s.ctx.app, s.note.id, s.token); await tick();
    await waitFor("名字到達", 2_000, () => s.remote()?.user?.name === s.expectedName);
    expect(s.remote()!.user!.color).toBe("#7c3aed");
    expect(s.cursorText()).toContain("A");
    const o = await s.outline();
    expect(o).toHaveLength(3); // _top / A / B——同級 heading 的前提，斷掉這一行下面兩段就沒有意義
    await getContent(s.ctx.app, s.note.id, s.token, o[2]!.sectionId); await tick();
    await waitFor("游標到 B", 2_000, () => (s.cursorText() ?? "").includes("B"));
    await getContent(s.ctx.app, s.note.id, s.token, "_top"); await tick();
    await waitFor("游標回文件開頭", 2_000, () => (s.cursorText() ?? "").includes("A"));
    s.client.disconnect();
  });

  it("cookie **寫入**與 cookie 讀取都不設 presence；GET /edits 不刷新（用 clock 判斷，不用 sleep）", async () => {
    const s = await scene();
    const cookie = `${SESSION_COOKIE}=${await signSession(testConfig.appSecret, { userId: s.u.id, tv: 0 })}`;
    // 三個「不該 touch」的動作依序先跑，之後才跑「該 touch」的那一發。awareness 更新走同一條 socket
    // 依序抵達，所以等到最後那發到了，前三發若偷偷 touch 過就一定已經反映在 clock 上。
    //
    // ⚠ 第一發是 spec §12.2 指名的「**用瀏覽器登入的寫入**不設 presence」，它守住的是「cookie
    //   寫入照樣 201、而且不會讓 token 那組 clock 跑掉」。**誠實記下：把 `request.tokenId &&`
    //   拿掉不會讓這一案變紅**——cookie ⇒ agentLabel 為 null，第二個條件恰好也擋住；就算兩個
    //   條件都拿掉，cookie 這條路 touch 用的 tokenId 不同 ⇒ clientId 不同 ⇒ 下面那行 clock
    //   斷言看不到（已用突變實測）。真正擋住它的是 `tsc`（TS2345），見 routes/notes.ts 該處註解。
    //   下面的 `toBe(1)` 實際守住的是第三發（GET /edits 帶 token）——那一發突變確實會變成 2。
    expect((await s.ctx.app.inject({
      method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: { cookie },
      payload: { op: "append", markdown: "使用者自己在編輯器外用 cookie 寫的一行" },
    })).statusCode).toBe(201);
    expect((await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}/content`, headers: { cookie } })).statusCode).toBe(200);
    expect((await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token) })).statusCode).toBe(200);
    await getContent(s.ctx.app, s.note.id, s.token); await tick();
    await waitFor("名字到達", 2_000, () => s.remote()?.user?.name === s.expectedName);
    // 本檔第一次 touch 這組 (noteId, tokenId)，clock 必為 1。上面三發只要有一發 touch 過，
    // 這裡就會是 2。
    expect(s.remoteClock()).toBe(1);
    // ⚠ 上面那條 clock 斷言在結構上看不到「兩個條件都拿掉」這種突變：cookie 路徑 touch 用的
    //   tokenId 跟這裡的 `s.tokenId` 不同，clientId 自然不同，clock 斷言完全不會注意到多了一個
    //   陌生 client。真正的鑑別力在這裡：awareness 上出現的用戶端識別**集合**必須恰好是
    //   「瀏覽器自己（本地 doc 的 clientID，Awareness 建構時就以空物件登記自己）＋這一組權杖」
    //   兩個，一個都不能多。任何本該不 touch 的路徑偷偷 touch 了，都會在這裡多冒出一個 id。
    const clientIds = [...s.client.provider.awareness!.getStates().keys()].sort((a, b) => a - b);
    expect(clientIds).toEqual([s.client.provider.awareness!.clientID, s.id].sort((a, b) => a - b));
    s.client.disconnect();
  });

  it("寫入後文件仍載入才出現，游標落在**這次寫下去的第一顆**；append 同理；沒人在線寫入不出現且文件不留在記憶體", async () => {
    const s = await scene();
    // ⚠ 三個鑑別力設計，缺一個就變假綠：
    //   (1) 這份 fixture 的 doc-start 與 A 段第一顆是**同一顆**（文件以 `# A` 開頭），
    //       所以寫入一律挑 **B 段**——寫 A 段區分不出「正確目標」與「退回文件開頭」。
    //   (2) 替換的 heading 用 **`# B2`**（與原標題 `# B` **不同字串**）。這樣「拿舊 section_id
    //       去查、查不到就退回文件開頭」與「正確落在新寫下的 heading」兩種結果，在斷言上
    //       是 `A` vs `B2` 兩個互斥的字串；沿用 `# B` 的話，只要哪天實作改成用舊 id 卻碰巧
    //       解到同位置的舊文字，就分不出來了。
    //   (3) append 之前先把游標拉回文件開頭，否則 append 那條斷言在游標沒動時也會過。
    const o = await s.outline();                 // 讀整篇 → 游標在文件開頭（heading「A」）
    const b = o[2]!;                             // outline 每列自帶 fingerprint，不必再讀一次 ?section=
    expect((await s.ctx.app.inject({
      method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token),
      payload: { op: "replace_section", section_id: b.sectionId, markdown: "# B2\n\nAI 改過的第二段", if_match: b.fingerprint },
    })).statusCode).toBe(201);
    await tick();
    await waitFor("名字到達", 2_000, () => s.remote()?.user?.name === s.expectedName);
    // replace_section 把 heading 一起換掉了 → 舊 section_id 已不存在。目標若還用它，cursorFor
    // 找不到就退回文件開頭（＝「A」），這條就紅。
    await waitFor("游標落在新寫下的 B2 heading", 2_000, () => (s.cursorText() ?? "").includes("B2"));
    expect(s.cursorText()).not.toContain("A");
    // 先把游標拉回文件開頭，append 的落點才有鑑別力
    await getContent(s.ctx.app, s.note.id, s.token, "_top"); await tick();
    await waitFor("游標回文件開頭", 2_000, () => (s.cursorText() ?? "").includes("A"));
    expect((await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token), payload: { op: "append", markdown: "追加一行" } })).statusCode).toBe(201);
    await tick();
    await waitFor("append → 游標在剛追加的那一行", 2_000, () => (s.cursorText() ?? "").includes("追加一行"));
    s.client.disconnect();
    await waitFor("落盤並卸載", 10_000, () => s.ctx.collab.hocuspocus.documents.size === 0);

    // 沒人在線：寫入不建立 presence，也不把文件留在記憶體
    const t = await scene();
    t.client.disconnect();
    await waitFor("落盤並卸載", 10_000, () => t.ctx.collab.hocuspocus.documents.size === 0);
    expect((await t.ctx.app.inject({ method: "POST", url: `/api/notes/${t.note.id}/edits`, headers: bearer(t.token), payload: { op: "append", markdown: "沒人在線的追加" } })).statusCode).toBe(201);
    await waitFor("落盤並卸載", 10_000, () => t.ctx.collab.hocuspocus.documents.size === 0);
  });

  it("撤回後游標退回文件開頭，不再停在被撤回的那行（撤回是三個對外動作之一，先前零覆蓋）", async () => {
    const s = await scene();
    const created = await s.ctx.app.inject({
      method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.token),
      payload: { op: "append", markdown: "即將被撤回的一行" },
    });
    expect(created.statusCode).toBe(201);
    const editId = (created.json() as { editId: string }).editId;
    await tick();
    // 先把游標推到這次追加的那一行——之後才有「停在原地」與「退回文件開頭」兩個互斥字串可比。
    await waitFor("游標先落在剛追加的那一行", 2_000, () => (s.cursorText() ?? "").includes("即將被撤回的一行"));
    expect((await s.ctx.app.inject({
      method: "POST", url: `/api/notes/${s.note.id}/edits/${editId}/revert`, headers: bearer(s.token),
    })).statusCode).toBe(201);
    await tick();
    await waitFor("撤回後游標回文件開頭", 2_000, () => (s.cursorText() ?? "").includes("A"));
    expect(s.cursorText()).not.toContain("即將被撤回的一行");
    s.client.disconnect();
  });

  it("閒置停止後同一 provider 仍連著時 re-touch → 名牌重現（clock 未重設，注入 idleMs）", async () => {
    const s = await scene({ presence: { idleMs: 200 } });
    await getContent(s.ctx.app, s.note.id, s.token); await tick();
    await waitFor("名字到達", 2_000, () => s.remote()?.user?.name === s.expectedName);
    await waitFor("閒置消失", 3_000, () => s.remote() === undefined);
    const afterStop = s.remoteClock()!;
    await getContent(s.ctx.app, s.note.id, s.token); await tick();
    await waitFor("重現", 2_000, () => s.remote()?.user?.name === s.expectedName);
    expect(s.remoteClock()!).toBeGreaterThan(afterStop); // 重新起算的 clock 會被 provider 靜默丟棄
    s.client.disconnect();
  });

  it("35 s 後瀏覽器側仍含該 clientID（heartbeat 撐過 outdatedTimeout 30 s）", async () => {
    const s = await scene();
    await getContent(s.ctx.app, s.note.id, s.token); await tick();
    await waitFor("名字到達", 2_000, () => s.remote()?.user?.name === s.expectedName);
    await new Promise(r => setTimeout(r, 35_000));
    expect(s.remote()?.user?.name).toBe(s.expectedName);
    s.client.disconnect();
  }, 60_000);
});
