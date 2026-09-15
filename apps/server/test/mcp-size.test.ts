/**
 * #108 PR1 Task 5：回應大小的兩道門檻（規格 §14.2 案 11b／11c、不變量 M16）。
 *
 * 兩個數字是**兩件不同的事**，不要混：
 * - {@link N_LIST_MAX} 管 **`tools/list` 的脈絡成本**（六支工具的 input／output schema 全部
 *   進模型脈絡，「schema 慢慢變胖」需要有東西擋）。它是**測試門檻**，不是生產常數，所以
 *   不進 `src/`。
 * - {@link MCP_MAX_WIRE} 是 §8.1 的 `N`，管**單次 `tools/call` 的回應**。它是**哨兵不是
 *   目標值**：破了代表 `mcp/limits.ts` 那張表的某一列漏接，正確處置是回頭查那一列，
 *   **不是調大 N**。
 *
 * ⚠ 量的一律是 **wire 回應**（`res.body.length`，UTF-16 code unit），不是 payload：D11 的
 * 鏡像讓同一份 payload 在回應裡出現兩次（第二次還被 JSON 逃脫），`wire ≈ 2.1 × payload`。
 * `tools/list` 那一發還含 SDK 自產的 `"execution":{"taskSupport":"forbidden"}` 與兩份 schema
 * 各自的 `"$schema"` 行——量整個 body 才算得到真正進脈絡的成本。
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { notes, users } from "../src/db/schema.js";
import { MCP_PAGE_MAX } from "../src/mcp/limits.js";
import { buildCollabTestApp, type CollabTestCtx } from "./helpers.js";
import { getContent, seedContent, seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import type { Db } from "../src/db/index.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";

/**
 * §8.1 的 `N`：一次 `tools/call` 的 wire 回應上限（UTF-16 code unit）。與
 * `POST /api/notes/:id/edits` 的 `bodyLimit` 同一個數字——請求進得來多大，回應就不該更大。
 */
export const MCP_MAX_WIRE = 262_144;

/**
 * `tools/list` 的 wire 回應上限（UTF-16 code unit）。
 *
 * **怎麼來的**（Task 5，2026-09-09 實測，**讀寫憑證、六支工具**——PR2 起讀寫憑證才是最壞
 * 情形，唯讀憑證只當對照）：當時實測 **15 362**（唯讀憑證四支對照組 9479，與 PR1 量到的
 * 數字相同）→ 向上取整到 1024 的倍數＝16 384 → ×1.3 ＝ 21 299.2 → 進位 **21 300**。1.3 是
 * 「schema 與 `.describe()` 正常增修」的餘地，形狀比照 `scripts/check-bundle-size.mjs` 的
 * `MAX_ENTRY_BYTES`；`edit_note`／`create_note` 兩支的 input／output schema 一起進脈絡，
 * 是這條線從 PR1 的 13 312 破線 2050 的直接原因。
 *
 * **基線：2026-09-15 實測，讀寫憑證六支 wire ＝ 16 763**（#145）。⚠ 上面那個 15 362 在 #148
 * （改寫模型面敘述那一輪）之後就過期了，而這段註解當時沒跟上——別再拿它去論證餘裕。對照組、
 * 百分比刻意不抄在這裡：案 11b 每次跑都 `console.log` 印出當下的值（剩餘字元一減就有）。
 *
 * ⚠ **這個門檻的推導前提已經不成立**：21 300 ＝「量測值取整到 16 384 再 ×1.3」，而基線
 * **已經大於 16 384**。下次逼近門檻時該做的是**回頭重訂這個數字連同它的推導**，不是逕自調大。
 *
 * **什麼樣的迴歸會撞牆**（**突變實跑，2026-09-09**）：把 `edit_note` 的 `if_match`
 * 欄位 `.describe()` 加長 6000 字元（`"x".repeat(6000)` 接在句尾）→ wire 變成 **21 362**，
 * 紅（`expected 21362 to be less than or equal to 21300`）；已 revert。這條迴歸只是拿來驗證
 * 餘裕確實存在、且沒有 D11 那種鏡像效應（`tools/list` 的 schema 只進脈絡一份，加長多少 wire
 * 就多長多少，不是 ×2.1）。撞牆時**先問「這段字非進 schema 不可嗎」**：`tools/list` 的每一個
 * 位元組每一次連線都進模型脈絡，而 `instructions` 與 `docs/mcp.md` 是更便宜的落點。
 */
export const N_LIST_MAX = 21_300;

interface Measured {
  label: string;
  wire: number;
}

const measured: Measured[] = [];

/** 量一發 `tools/call` 的完整 wire 回應，順手斷言它沒有變成錯誤結果。 */
async function callWire(
  app: FastifyInstance,
  token: string,
  label: string,
  name: string,
  args: unknown
): Promise<number> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  expect(res.statusCode).toBe(200);
  const result = res.json().result as { isError?: true };
  // 錯誤結果都很小，會讓門檻假綠——被測的必須是成功路徑。
  expect(result.isError).toBeUndefined();
  const wire = res.body.length;
  measured.push({ label, wire });
  console.log(`[案 11c] ${label.padEnd(46)} wire=${String(wire).padStart(7)}  餘裕 ×${(MCP_MAX_WIRE / wire).toFixed(1)}`);
  expect(wire).toBeLessThanOrEqual(MCP_MAX_WIRE);
  return wire;
}

/** owner ＋ 唯讀 PAT。 */
async function owner(ctx: CollabTestCtx): Promise<{ id: string; email: string; token: string }> {
  const email = `o-${randomUUID()}@example.com`;
  const user = await ctx.createUser({ email, password: PASSWORD });
  const { token } = await seedTokenForUser(ctx.db, user.id, "notes:read");
  return { id: user.id, email, token };
}

async function firstSectionId(app: FastifyInstance, token: string, noteId: string, offset = 0): Promise<string> {
  const res = await mcpPost(
    app,
    rpc("tools/call", { name: "read_note_outline", arguments: { note_id: noteId, section_offset: offset } }),
    { token }
  );
  const payload = res.json().result.structuredContent as { sections: { sectionId: string; chars: number }[] };
  // 取最長的那一段——`read_note_section` 的最壞情形是「有東西可以截」。
  return payload.sections.reduce((a, b) => (a.chars >= b.chars ? a : b)).sectionId;
}

/**
 * `edit_note` 的 `if_match` 只能從**指紋**來，而 `read_note_outline` 依 M12 刻意不帶指紋
 * （`outline-page.ts` 檔頭）——量測要走 REST 的 `GET /content`，與 `mcp-edit-note.test.ts`
 * 的 `restOutline()` 同一個理由：獨立真相，不繞路去猜。
 */
async function sectionAt(
  app: FastifyInstance,
  token: string,
  noteId: string,
  index: number
): Promise<{ sectionId: string; fingerprint: string }> {
  const res = await getContent(app, noteId, token);
  expect(res.statusCode).toBe(200);
  const body = res.json() as { outline: Array<{ sectionId: string; fingerprint: string }> };
  return body.outline[index]!;
}

describe("#108 tools/list 的脈絡成本（案 11b）", () => {
  // PR1 量的是唯讀憑證（四支工具）；PR2 起讀寫憑證（六支工具）才是最壞情形——`edit_note`／
  // `create_note` 的 input／output schema 一起進脈絡。本案改打讀寫憑證，唯讀憑證只當對照
  // 一起印出來，門檻只釘在讀寫憑證那個數字上。
  it("讀寫憑證的 tools/list 完整 wire 回應 ≤ N_LIST_MAX（唯讀憑證當對照）", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const { token: rwToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write");

    const roRes = await mcpPost(ctx.app, rpc("tools/list"), { token: o.token });
    expect(roRes.statusCode).toBe(200);
    expect((roRes.json().result.tools as unknown[]).length).toBe(4);
    const roWire = roRes.body.length;

    const rwRes = await mcpPost(ctx.app, rpc("tools/list"), { token: rwToken });
    expect(rwRes.statusCode).toBe(200);
    expect((rwRes.json().result.tools as unknown[]).length).toBe(6);
    const rwWire = rwRes.body.length;

    console.log(
      `[案 11b] tools/list  唯讀憑證（四支，對照）wire=${roWire}  讀寫憑證（六支，被測）wire=${rwWire}  ` +
        `門檻=${N_LIST_MAX}  用掉 ${((rwWire / N_LIST_MAX) * 100).toFixed(1)}%`
    );
    expect(rwWire).toBeLessThanOrEqual(N_LIST_MAX);
  });
});

describe("#108 單次回應大小（案 11c／M16）", () => {
  // 測資 (i)：一顆 heading 260 000 字元、標題也 260 000 字元的筆記。
  // **殺掉的寫法（四條突變全部實跑過，2026-09-07；每一條都同時放寬對應的 `outputSchema`
  // 上限，否則先擋下它的是 SDK 的 `validateToolOutput` 而不是這條大小門檻）**：
  //   - `dto.ts` 的 `title` 不截 → `(i) list_notes` 520 644
  //   - `read-note-outline.ts` 的 `note.title` 不截（**與上一條是兩個呼叫點**）→ 521 294
  //   - `outline-page.ts` 的 `heading` 不截 → `(i) read_note_outline` 521 290
  //   - `read-note-section.ts` 的 `markdown` 不截 → `(i) read_note_section` 560 513
  // ⚠ **但這一案不是那四條的唯一守衛，別這樣宣稱**（reviewer 重跑）：`heading`／`markdown`
  //   不截 `mcp-content.test.ts` 也會紅（各一案／三案），`title` 那條由 `mcp-notes.test.ts`
  //   的 200 字元斷言直接守。**(i) 獨有的那一層是「病態筆記下 wire ≤ N」**——逐欄斷言看的是
  //   欄位值，看不到「整個回應加起來會不會爆」，而那正是 M16 最後一列要的東西。
  // Task 5 案 11c 補：`create_note` 的最壞情形是**回應裡的 `title` 被截到 200 字元 ＋ 多帶
  // `titleTruncated:true`**（`toNoteSummary`，`dto.ts`）——與這一案的 `hugeTitle` 同一個
  // 病態形，所以順手擺在 (i)：一發讀寫憑證的 `create_note`，帶一顆同樣 260 000 字元的標題。
  // ⚠ `create_note` 不寫 live doc（不帶 `content`），對這一案其他量測**零污染**。
  it("(i) 一篇 heading／title 各 260 000 字元的筆記 → 六支工具都 ≤ N", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const { token: rwToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write");
    const hugeTitle = `T${"i".repeat(259_999)}`;
    const note = await ctx.createNote(o.id, hugeTitle);
    const session = await ctx.loginAs(o.email, PASSWORD);
    const client = await seedContent(ctx, session, note.id, `# ${"H".repeat(260_000)}\n\n${"B".repeat(20_000)} tail`);

    await callWire(ctx.app, o.token, "(i) read_note_outline", "read_note_outline", { note_id: note.id });
    const sectionId = await firstSectionId(ctx.app, o.token, note.id);
    await callWire(ctx.app, o.token, "(i) read_note_section", "read_note_section", {
      note_id: note.id,
      section_id: sectionId,
    });
    await callWire(ctx.app, o.token, "(i) list_notes", "list_notes", { limit: MCP_PAGE_MAX });
    await callWire(ctx.app, o.token, "(i) search_notes", "search_notes", { query: "Tiii", limit: 50 });
    await callWire(ctx.app, rwToken, "(i) create_note", "create_note", { title: hugeTitle });
    client.disconnect();
  });

  // 測資 (ii)：500 段、每段標題 1000 字元。**它只殺掉一種寫法：outline 不分頁**
  // （`buildOutlinePage` 的 `slice(offset, offset + MCP_PAGE_MAX)` 拿掉 → 第一頁 319 692，紅）。
  // ⚠ **它殺不掉「`heading` 不截」**（原本的註解這樣寫，實跑推翻）：100 段 × 1000 字元的
  //   heading 只到 216 904，**還在 262 144 以內**。那一條靠 (i)（一顆 260 000 的 heading）。
  //   最後一頁那一發是「分頁的邊界也在門檻內」，不是另一種寫法的守衛。
  it("(ii) 500 段、每段標題 1000 字元 → outline 的第一頁與最後一頁都 ≤ N", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const { token: rwToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write");
    const note = await ctx.createNote(o.id, "five hundred sections");
    const md = Array.from({ length: 500 }, (_, i) => `# ${String(i).padStart(4, "0")}${"h".repeat(994)}`).join("\n\n");
    const session = await ctx.loginAs(o.email, PASSWORD);
    const client = await seedContent(ctx, session, note.id, md);

    await callWire(ctx.app, o.token, "(ii) read_note_outline 第一頁", "read_note_outline", { note_id: note.id });
    await callWire(ctx.app, o.token, "(ii) read_note_outline 第五頁", "read_note_outline", {
      note_id: note.id,
      section_offset: 4 * MCP_PAGE_MAX,
    });
    const sectionId = await firstSectionId(ctx.app, o.token, note.id);
    await callWire(ctx.app, o.token, "(ii) read_note_section", "read_note_section", {
      note_id: note.id,
      section_id: sectionId,
    });

    // Task 5 案 11c 補：`edit_note` 的最壞情形是**成功回應帶一整頁（100 筆）逐段指紋的
    // outline**（`outline-page.ts` 的 `withFingerprints: true`，`read_note_outline` 完全
    // 沒有這個負擔）。⚠ 寫入落點刻意指在**後段**（第 250 段，遠離第一頁）：`replace_section`
    // 這族 op 的取頁規則是從落點（`afterSectionIndex`）起算（D-J），打第一段等於跟
    // `read_note_outline` 第一頁量到同一種形，量不到「取頁規則對任意落點都算得出一整頁」
    // 這件事——這一發放在該 it 的**最後**，因為它會真的寫進去，不得污染前面幾發的量測。
    const target = await sectionAt(ctx.app, o.token, note.id, 250);
    await callWire(ctx.app, rwToken, "(ii) edit_note replace_section@250", "edit_note", {
      note_id: note.id,
      op: "replace_section",
      section_id: target.sectionId,
      markdown: `# 0250-edited${"h".repeat(986)}`,
      if_match: target.fingerprint,
    });
    client.disconnect();
  });

  /**
   * 測資 (iii)：100 筆「每一格都合規但都滿長」的筆記。**六支工具裡最大的回應是它**——
   * 前兩組測資量不到（它們只有一兩筆列）。
   *
   * ⚠ **不能用 `ctx.createNote` 隨手造**：那樣造出來的列 `last_edited_at` 是 NULL，`lastEdited`
   * 恆為 `null`，那 32 字元 × 100 筆的 `agentLabel`／`byHandle` 根本不在回應裡，量到的值會
   * 明顯小於真正的最壞情形。四欄要一起補滿：`lastEditedAt`／`lastEditedBy`／
   * `lastEditedAgentLabel`（`lastEditedTokenId` 不進 DTO，不必補）。
   * **量到的值明顯小於 160 000 就是測資沒造滿，回頭查測資，不要調 N。**
   *
   * 2026-09-07 實測 **155 556**（餘裕 ×1.7）。⚠ **與規格 rev 5 的參考值 160 360 差 4804
   * （每列約 48 wire）的成因已查明，不是測資沒造滿**：這裡的 `title` 取**恰好 200、不觸發截斷**，
   * 而真正的最壞情形是 `title > 200` 被截到 200 **並多帶一把 `"titleTruncated":true`**
   * （鏡像兩份 ≈ 48 wire／列）。刻意照 plan 取 200，因為這一案要量的是「合規的最壞情形」；
   * 引用這個數字時要一併講這句，否則會被問「是不是還是沒造滿」。
   *
   * ⚠ **誠實記下：這一案殺不掉任何一種「漏截」的寫法**——每一格都恰好在上限之內，拿掉截斷
   * 對它零影響（那四條的守衛見 (i) 上面那段：`heading`／`markdown` 由 `mcp-content` 與 (i) 一起守、
   * `title` 由 `mcp-notes` 直接守）。它守的是另一件事：**「單次回應 ≤ N」在合規的最壞情形下
   * 是不是真的成立**。日後把 `MCP_PAGE_MAX` 調大、或往 `NoteSummary` 加欄位，紅的會是它。
   */
  it("(iii) 100 筆滿長筆記（handle 32／title 200／slug 100／agentLabel 32）＋ limit 100 → ≤ N", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const { token: rwToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write");
    const handle = `h${"a".repeat(31)}`; // 32 字元，`handles_handle_chk` 的上限
    expect(handle).toHaveLength(32);
    await ctx.db.update(users).set({ handle }).where(eq(users.id, o.id));

    const agentLabel = "g".repeat(32);
    for (let i = 0; i < MCP_PAGE_MAX; i += 1) {
      const n = String(i).padStart(4, "0");
      await seedMaxNote(ctx.db, o.id, {
        title: `${n}${"t".repeat(196)}`,
        slug: `${n}-${"s".repeat(95)}`,
        agentLabel,
      });
    }

    const wire = await callWire(ctx.app, o.token, "(iii) list_notes limit=100", "list_notes", { limit: MCP_PAGE_MAX });
    // 「測資沒造滿」的哨兵（判準見上：應落在 160 000 上下）。
    // ⚠ **解析度只到「整組 `lastEdited` 落空」那一級**（reviewer 實測）：整組落空 → 129 756，紅；
    //   只把 `lastEditedAgentLabel` 設 null → 149 356，**綠**。也就是說它擋得住 gate r3 m3 警告的
    //   那個形（用 `ctx.createNote` 隨手造 → `last_edited_at` 是 NULL → 四欄全不在回應裡），
    //   **擋不住「四欄裡有一欄沒造滿」**。
    expect(wire).toBeGreaterThan(140_000);
    // `search_notes` 的 `limit` 上限是 50，所以它的最壞情形恰好是這一發的一半左右。
    await callWire(ctx.app, o.token, "(iii) search_notes limit=50", "search_notes", { query: "ttt", limit: 50 });

    // Task 5 案 11c 補：`create_note` 的另一半最壞情形——`ownerHandle` 是這一案剛設的
    // 32 字元上限（(i) 那一發的 owner 是隨機 email 產生的短 handle，量不到這一格）。標題
    // 一樣給到會截斷的長度，兩案合起來才是 `create_note` 回應真正的最壞情形。
    await callWire(ctx.app, rwToken, "(iii) create_note", "create_note", { title: "c".repeat(300) });
  });

  // 整張表印一次（PR 描述要貼）。**刻意是 hook 不是 `it`**：它只彙整前面幾案已經斷言過的
  // 值，寫成 `it` 會讓「只跑其中一案」變成假紅。
  afterAll(() => {
    console.log(
      `\n[案 11c 量測表] N=${MCP_MAX_WIRE}\n` +
        measured.map(m => `  ${m.label.padEnd(46)} ${String(m.wire).padStart(7)}  ×${(MCP_MAX_WIRE / m.wire).toFixed(1)}`).join("\n")
    );
  });
});

/** 一列「每一格都合規但都滿長」的筆記；`lastEdited` 四欄一併補滿（見上面的 ⚠）。 */
async function seedMaxNote(
  db: Db,
  ownerId: string,
  opts: { title: string; slug: string; agentLabel: string }
): Promise<void> {
  await db.insert(notes).values({
    ownerId,
    title: opts.title,
    slug: opts.slug,
    lastEditedAt: new Date(),
    lastEditedBy: ownerId,
    lastEditedAgentLabel: opts.agentLabel,
  });
}
