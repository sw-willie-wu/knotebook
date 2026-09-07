/**
 * #108 PR1 Task 4：`read_note_outline`／`read_note_section`（規格 §8.3／§8.4、§14.3、M12／M16）。
 *
 * 全族走 `buildCollabTestApp`（＝生產形態）：依 D-A，這兩支工具**只在 `collab` 與 `editing`
 * 都在時才註冊**，無 collab 的 app 上整條不宣告（那一面的形狀斷言在 Task 5）。
 *
 * ⚠ `callTool`／`payloadOf` 與 `mcp-notes.test.ts` 的同名 helper 是**兩份**：`test/mcp-helpers.ts`
 * 不在本棒的觸及面內，而它們各自只有幾行。兩份若日後分岔，症狀只是測試自己讀錯欄位。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { signSession } from "../src/auth/session.js";
import { noteStateBackups, notes, noteStates } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { PRESENCE_COLOR, presenceClientId } from "../src/notes/editing/presence.js";
import { MCP_PAGE_MAX, MCP_SECTION_CHARS, MCP_TEXT_MAX } from "../src/mcp/limits.js";
import { buildCollabTestApp, testConfig, type CollabTestCtx } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, tick, waitFor } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";
const NUL = String.fromCharCode(0);
/** 沒有配對的高位／低位代理（`String.prototype.isWellFormed` 要 ES2024 lib，本 repo 是 ES2023）。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

interface ToolResultBody {
  isError?: true;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown> & { code?: string };
}

interface ToolCall {
  status: number;
  result: ToolResultBody;
  /** 整個 wire body 的字串（「指紋一個字都不得出現」那種掃描用）。 */
  raw: string;
}

interface OutlineEntry extends Record<string, unknown> {
  sectionId: string;
  level: number;
  heading: string;
  chars: number;
  headingTruncated?: true;
}

interface OutlinePayload extends Record<string, unknown> {
  note: Record<string, unknown> & { id: string; title: string; ownerHandle: string; role: string };
  totalChars: number;
  sections: OutlineEntry[];
  truncated: boolean;
  nextSectionOffset: number | null;
  lastEdited: unknown;
}

interface SectionPayload extends Record<string, unknown> {
  section: Record<string, unknown> & { id: string; level: number; chars: number; markdown: string; fingerprint?: string };
  truncated: boolean;
  nextOffset: number | null;
  lastEdited: unknown;
  note?: string;
}

async function callTool(app: FastifyInstance, token: string, name: string, args: unknown = {}): Promise<ToolCall> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  return { status: res.statusCode, result: res.json().result, raw: res.body };
}

/** 成功呼叫的 `structuredContent`（順手守住 M10 的鏡像等式）。 */
function payloadOf<T>(call: ToolCall): T {
  expect(call.status).toBe(200);
  expect(call.result.isError).toBeUndefined();
  expect(call.result.content[0]!.text).toBe(JSON.stringify(call.result.structuredContent));
  return call.result.structuredContent as unknown as T;
}

const outlineOf = async (app: FastifyInstance, token: string, noteId: string, sectionOffset?: number) =>
  payloadOf<OutlinePayload>(
    await callTool(app, token, "read_note_outline", {
      note_id: noteId,
      ...(sectionOffset === undefined ? {} : { section_offset: sectionOffset }),
    })
  );

const sectionOf = async (app: FastifyInstance, token: string, noteId: string, sectionId: string, offset?: number) =>
  payloadOf<SectionPayload>(
    await callTool(app, token, "read_note_section", {
      note_id: noteId,
      section_id: sectionId,
      ...(offset === undefined ? {} : { offset }),
    })
  );

/** REST 側的同一篇 outline——`sectionId`／`fingerprint` 的**獨立**真相（MCP 不得自己算一份）。 */
async function restOutline(app: FastifyInstance, noteId: string, token: string) {
  const res = await getContent(app, noteId, token);
  expect(res.statusCode).toBe(200);
  return res.json().outline as Array<{ sectionId: string; level: number; heading: string; chars: number; fingerprint: string }>;
}

interface Scene {
  ctx: CollabTestCtx;
  ownerId: string;
  ownerHandle: string;
  token: string;
  tokenId: string;
  noteId: string;
  email: string;
}

/** owner ＋ 一顆 PAT（token 名稱固定 "Claude Code" ⇒ agent label "claude"）＋ 一篇筆記。 */
async function scene(
  markdown: string | null,
  opts: Parameters<typeof buildCollabTestApp>[0] = {},
  title?: string
): Promise<Scene & { disconnect: () => void }> {
  const ctx = await buildCollabTestApp(opts);
  const email = `o-${randomUUID()}@example.com`;
  const owner = await ctx.createUser({ email, password: PASSWORD });
  const note = await ctx.createNote(owner.id, title);
  const { token, tokenId } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write", "Claude Code");
  let disconnect = (): void => {};
  if (markdown !== null) {
    const session = await ctx.loginAs(email, PASSWORD);
    const client = await seedContent(ctx, session, note.id, markdown);
    disconnect = () => client.disconnect();
  }
  const ownerHandle = (await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}`, headers: bearer(token) })).json()
    .ownerHandle as string;
  return { ctx, ownerId: owner.id, ownerHandle, token, tokenId, noteId: note.id, email, disconnect };
}

/** ⚠ heading 一律**同級**：`## B` 會被 sectionize 併進 A 段（#106 三棒踩過三次）。 */
const TWO_SECTIONS = "# A\n\n第一段內容\n\n# B\n\n第二段內容";

describe("#108 read_note_outline", () => {
  it("以標題開頭的筆記：_top 存在且 chars 0，其餘每段 sectionId ＝該 heading block 的 id（案 12）", async () => {
    const s = await scene(TWO_SECTIONS);
    const out = await outlineOf(s.ctx.app, s.token, s.noteId);
    expect(out.sections).toHaveLength(3);
    expect(out.sections[0]!.sectionId).toBe("_top");
    expect(out.sections[0]!.chars).toBe(0);
    expect(out.sections.map(x => x.heading)).toEqual(["", "A", "B"]);
    expect(out.sections.map(x => x.level)).toEqual([0, 1, 1]);
    // sectionId 的真相在 REST（＝該 heading block 的 id）——MCP 不得自己編一套。
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    expect(out.sections.map(x => x.sectionId)).toEqual(rest.map(x => x.sectionId));
    expect(out.note.role).toBe("owner");
    expect(out.note.ownerHandle).toBe(s.ownerHandle);
    expect(out.truncated).toBe(false);
    expect(out.nextSectionOffset).toBeNull();
    s.disconnect();
  });

  it("從未開過的筆記：sections 只有 _top、totalChars 0，不報錯（案 13）", async () => {
    const s = await scene(null);
    const out = await outlineOf(s.ctx.app, s.token, s.noteId);
    expect(out.sections).toHaveLength(1);
    expect(out.sections[0]!.sectionId).toBe("_top");
    expect(out.totalChars).toBe(0);
    expect(out.lastEdited).toBeNull();
  });

  // 案 14a／M12(1)：**逐欄位的 key 集合**，不是「不含 16 個十六進位字元」那種啟發式
  // （一個叫 `deadbeefdeadbeef` 的標題就會讓啟發式誤紅）。殺掉的寫法＝照抄 `outlineOf`
  // 的回傳值（那會帶 `fingerprint` 與 `blockIds`）。
  //
  // ⚠ **`headingTruncated` 這一族的守衛不是下面那條 key 集合斷言**（Task 3 實測推翻了
  // plan P8，本棒重跑確認）：寫成 `headingTruncated: false` 時抓到它的是 `outputSchema`
  // 的 `z.literal(true)`（本檔十條會一起紅，紅法是 `isError`）；寫成 `undefined` 時**本檔
  // 一條都不紅**——那一半由 `test/unit/mcp-outline-page.test.ts` 直接對物件的 key 集合守。
  it("outline 的頂層／note／每個 entry 的 key 集合逐字相符，一個指紋都沒有（案 14a／M12(1)）", async () => {
    const s = await scene(TWO_SECTIONS);
    const call = await callTool(s.ctx.app, s.token, "read_note_outline", { note_id: s.noteId });
    const out = payloadOf<OutlinePayload>(call);
    expect(Object.keys(out).sort()).toEqual(
      ["lastEdited", "nextSectionOffset", "note", "sections", "totalChars", "truncated"].sort()
    );
    expect(Object.keys(out.note).sort()).toEqual(["id", "ownerHandle", "role", "title"].sort());
    for (const entry of out.sections) {
      expect(Object.keys(entry).sort()).toEqual(["chars", "heading", "level", "sectionId"].sort());
    }
    // 未被截斷時**沒有** `headingTruncated` 這把 key（不是 `undefined`）。
    expect(out.sections.every(e => !("headingTruncated" in e))).toBe(true);
    // 第二道、非啟發式的守衛：把 REST 算出來的**真值**逐一拿去掃 wire body。整篇指紋與
    // 每一段的指紋都不得出現在 `read_note_outline` 的回應裡的任何位置（含被塞進 heading）。
    const content = (await getContent(s.ctx.app, s.noteId, s.token)).json() as {
      fingerprint: string;
      outline: Array<{ fingerprint: string }>;
    };
    for (const fp of [content.fingerprint, ...content.outline.map(o => o.fingerprint)]) {
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
      expect(call.raw).not.toContain(fp);
    }
    s.disconnect();
  });

  it("超過 100 段：第一頁 100 筆 ＋ truncated ＋ nextSectionOffset 100，section_offset 接得上（M16）", async () => {
    const many = Array.from({ length: 105 }, (_, i) => `# S${i}\n\nbody ${i}`).join("\n\n");
    const s = await scene(many);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    expect(rest).toHaveLength(106); // _top ＋ 105 段

    const p1 = await outlineOf(s.ctx.app, s.token, s.noteId);
    expect(p1.sections).toHaveLength(MCP_PAGE_MAX);
    expect(p1.truncated).toBe(true);
    expect(p1.nextSectionOffset).toBe(MCP_PAGE_MAX);

    const p2 = await outlineOf(s.ctx.app, s.token, s.noteId, p1.nextSectionOffset!);
    expect(p2.sections).toHaveLength(6);
    expect(p2.truncated).toBe(false);
    expect(p2.nextSectionOffset).toBeNull();
    // 兩頁湊回全集、順序與 REST 一致、無重複無遺漏。
    const seen = [...p1.sections, ...p2.sections].map(x => x.sectionId);
    expect(seen).toEqual(rest.map(x => x.sectionId));
    expect(new Set(seen).size).toBe(106);
    s.disconnect();
  });

  it("section_offset 大於總段數 → sections 空、truncated false、nextSectionOffset null（不是錯誤）", async () => {
    const s = await scene(TWO_SECTIONS);
    const out = await outlineOf(s.ctx.app, s.token, s.noteId, 500);
    expect(out.sections).toEqual([]);
    expect(out.truncated).toBe(false);
    expect(out.nextSectionOffset).toBeNull();
    // 溢出仍然是一次成功的呼叫，`totalChars` 照樣是整篇的。
    expect(out.totalChars).toBeGreaterThan(0);
    s.disconnect();
  });

  it("heading 與 note.title 截到 200 code unit 並附 *Truncated（M16）", async () => {
    const huge = "H".repeat(260_000);
    const s = await scene(`# ${huge}\n\ntail line`, {}, "T".repeat(260_000));
    const out = await outlineOf(s.ctx.app, s.token, s.noteId);
    expect(out.note.title.length).toBe(MCP_TEXT_MAX);
    expect(out.note.title).toBe("T".repeat(MCP_TEXT_MAX));
    expect(out.note.titleTruncated).toBe(true);
    const heading = out.sections[1]!;
    expect(heading.heading.length).toBe(MCP_TEXT_MAX);
    expect(heading.heading).toBe("H".repeat(MCP_TEXT_MAX));
    expect(heading.headingTruncated).toBe(true);
    // `chars` 是**沒有被截斷的**真實長度——模型靠它決定要讀幾發。
    expect(heading.chars).toBeGreaterThan(260_000);
    s.disconnect();
  });

  it("totalChars 是整篇字數，不是這一頁的（分頁前後相同）", async () => {
    const many = Array.from({ length: 105 }, (_, i) => `# S${i}\n\nbody ${i}`).join("\n\n");
    const s = await scene(many);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const whole = rest.reduce((n, o) => n + o.chars, 0);
    const p1 = await outlineOf(s.ctx.app, s.token, s.noteId);
    const p2 = await outlineOf(s.ctx.app, s.token, s.noteId, MCP_PAGE_MAX);
    expect(p1.totalChars).toBe(whole);
    expect(p2.totalChars).toBe(whole);
    // 對照面：這一頁自己的加總**不等於** totalChars，否則上面兩行在「只加這一頁」的
    // 寫法下也會過。
    expect(p2.sections.reduce((n, o) => n + o.chars, 0)).toBeLessThan(whole);
    s.disconnect();
  });
});

describe("#108 read_note_section", () => {
  const LONG = "L".repeat(9_000);

  it("超過 4000 字元的段落：切片、nextOffset、下一發接得上（案 14）", async () => {
    const s = await scene(`# Long\n\n${LONG}`);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const target = rest[1]!;
    const full = (await getContent(s.ctx.app, s.noteId, s.token, target.sectionId)).json().section.markdown as string;
    expect(full.length).toBeGreaterThan(2 * MCP_SECTION_CHARS);

    const p1 = await sectionOf(s.ctx.app, s.token, s.noteId, target.sectionId);
    expect(p1.section.markdown.length).toBe(MCP_SECTION_CHARS);
    expect(p1.truncated).toBe(true);
    expect(p1.nextOffset).toBe(MCP_SECTION_CHARS);
    expect(p1.section.id).toBe(target.sectionId);
    expect(p1.section.level).toBe(target.level);
    expect(p1.section.chars).toBe(target.chars);

    let acc = p1.section.markdown;
    let next = p1.nextOffset;
    let last = p1;
    while (next !== null) {
      last = await sectionOf(s.ctx.app, s.token, s.noteId, target.sectionId, next);
      acc += last.section.markdown;
      next = last.nextOffset;
    }
    expect(acc).toBe(full); // 逐頁接回去＝REST 的整段
    expect(last.truncated).toBe(false);
    s.disconnect();
  });

  // 切點落在代理對（surrogate pair）中間時，`truncateText` 會退一格回 3999 個 code unit。
  // **`nextOffset` 必須跟著退**——寫死 `offset + 4000` 會讓下一頁從低位代理開始，接回去的
  // 內容少一個 code unit、而且兩頁各自帶著一個孤立代理（JSON 序列化不報錯，只是安靜送出
  // 壞字元）。這一案是 `nextOffset === 實際回傳長度` 這條的唯一守衛。
  it("切點落在代理對中間時 nextOffset 跟著退一格，逐頁接回去仍逐字等於整段", async () => {
    const s = await scene(`# E\n\n${"\u{1F600}".repeat(5_000)}`);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const target = rest[1]!;
    const full = (await getContent(s.ctx.app, s.noteId, s.token, target.sectionId)).json().section.markdown as string;
    // 非空轉守衛：天真的 `slice(0, 4000)` 在這份輸入上**真的**會切出孤立代理。這一行若紅，
    // 代表 fixture 的前綴長度變了、切點不再落在代理對中間，下面兩條就失去意義。
    expect(LONE_SURROGATE.test(full.slice(0, MCP_SECTION_CHARS))).toBe(true);

    const p1 = await sectionOf(s.ctx.app, s.token, s.noteId, target.sectionId);
    expect(p1.truncated).toBe(true);
    expect(p1.section.markdown.length).toBe(MCP_SECTION_CHARS - 1);
    expect(p1.nextOffset).toBe(p1.section.markdown.length);
    expect(LONE_SURROGATE.test(p1.section.markdown)).toBe(false);

    let acc = p1.section.markdown;
    let next = p1.nextOffset;
    while (next !== null) {
      const page = await sectionOf(s.ctx.app, s.token, s.noteId, target.sectionId, next);
      expect(LONE_SURROGATE.test(page.section.markdown)).toBe(false);
      acc += page.section.markdown;
      next = page.nextOffset;
    }
    expect(acc).toBe(full);
    s.disconnect();
  });

  it("被截斷的那一發不含 fingerprint，但含解釋用的 note 文案（案 14b／M12(3)）", async () => {
    const s = await scene(`# Long\n\n${LONG}`);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const call = await callTool(s.ctx.app, s.token, "read_note_section", {
      note_id: s.noteId,
      section_id: rest[1]!.sectionId,
    });
    const p1 = payloadOf<SectionPayload>(call);
    expect(p1.truncated).toBe(true);
    expect("fingerprint" in p1.section).toBe(false);
    expect(typeof p1.note).toBe("string");
    // 非啟發式：那一段的**真值**一個字都不得出現在 wire 上。
    expect(call.raw).not.toContain(rest[1]!.fingerprint);
    s.disconnect();
  });

  // 案 14c 前半（後半「那個值送進 edit_note 會被接受」是 PR2）。殺掉的寫法＝矯枉過正到
  // 「永遠不回指紋」——那會讓 `replace_section` 對長段落整個不可用。
  //
  // ⚠ 這條收緊的理由是**正確性**：不要讓人改自己沒看完的東西（讀了前 4000 字元就
  // `replace_section`，會吃掉沒讀到的尾巴，而且模型不會知道自己刪了什麼）。**它不是安全
  // 防線**——一發大 `offset` 的呼叫也算「結束該段的那一頁」，照樣拿得到指紋（規格 §8.4
  // 的誠實降級），所以它只保護循序讀取的模型。
  it("讀完整段（最後一發 truncated false）含 fingerprint，且與 REST 的段落指紋逐字相同（案 14c 前半）", async () => {
    const s = await scene(`# Long\n\n${LONG}`);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const target = rest[1]!;
    const full = (await getContent(s.ctx.app, s.noteId, s.token, target.sectionId)).json().section.markdown as string;

    const tail = await sectionOf(s.ctx.app, s.token, s.noteId, target.sectionId, full.length - 10);
    expect(tail.truncated).toBe(false);
    expect(tail.nextOffset).toBeNull();
    expect(tail.section.fingerprint).toBe(target.fingerprint);
    expect("note" in tail).toBe(false);
    // 短段落（一發就讀完）同樣拿得到指紋。
    const top = await sectionOf(s.ctx.app, s.token, s.noteId, "_top");
    expect(top.truncated).toBe(false);
    expect(top.section.fingerprint).toBe(rest[0]!.fingerprint);
    s.disconnect();
  });

  it("回應不含 heading（它就在 markdown 第一行），key 集合逐字相符（§8.4）", async () => {
    const s = await scene(TWO_SECTIONS);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const done = await sectionOf(s.ctx.app, s.token, s.noteId, rest[1]!.sectionId);
    expect(Object.keys(done).sort()).toEqual(["lastEdited", "nextOffset", "section", "truncated"].sort());
    expect(Object.keys(done.section).sort()).toEqual(["chars", "fingerprint", "id", "level", "markdown"].sort());
    expect("heading" in done.section).toBe(false);
    expect(done.section.markdown.startsWith("# A")).toBe(true); // heading 本來就在第一行
    s.disconnect();
  });

  it("不存在的 section_id → section_not_found（不是 not_found）（案 15）", async () => {
    const s = await scene(TWO_SECTIONS);
    const call = await callTool(s.ctx.app, s.token, "read_note_section", {
      note_id: s.noteId,
      section_id: "no-such-section",
    });
    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    expect(call.result.structuredContent!.code).toBe("section_not_found");
    s.disconnect();
  });

  // 案 16：不合 `SECTION_ID_RE` 的 `section_id` 在 **schema 層**被擋（不變量 M9 的格式 guard
  // ＋ NUL 兩關），也就是**在 handler 之外**。
  // ⚠ 這裡刻意**不寫**「沒有任何 SQL 被送出」——`section_id` 從來不進 SQL（`readNoteContent`
  //   → `outlineOf` → 記憶體裡的 `find`），那半斷言恆真。也不寫「不觸發任何文件載入」——
  //   `documents.size` 在讀路徑上本來就不會增加，同樣是類別錯置。
  // ⚠ **正向對照不可省**：沒有它，負向斷言在「`read_note_section` 根本沒被包進 `runTool()`」
  //   的寫法下與它要殺的寫法**同時恆真**，守衛靜默失效。
  it("不合格式的 section_id／note_id（含 NUL 那一發）在 handler 之外被擋（案 16／M9）", async () => {
    const seen: string[] = [];
    const s = await scene(TWO_SECTIONS, { mcpTestHooks: { beforeTool: name => void seen.push(name) } });
    const count = (): number => seen.filter(n => n === "read_note_section").length;

    // 正向對照：一發合法的呼叫，證明這支工具**真的**經過 `runTool()`。
    const ok = await sectionOf(s.ctx.app, s.token, s.noteId, "_top");
    expect(ok.section.id).toBe("_top");
    expect(count()).toBe(1);

    for (const bad of ["not a section id!", `a${NUL}b`, "x".repeat(65)]) {
      const call = await callTool(s.ctx.app, s.token, "read_note_section", { note_id: s.noteId, section_id: bad });
      expect(call.status).toBe(200);
      expect(call.result.isError).toBe(true);
      // ⚠ `.refine(noNul)` 在 JSON Schema 裡看不見，但 SDK 的 `validateToolInput` 真的會跑它。
      expect(call.result.content[0]!.text).toContain("Input validation error");
      expect(count()).toBe(1); // 計數不動＝zod 把它擋在 handler 之外
    }

    // `note_id` 的格式 guard（`NOTE_ID` 的 `UUID_RE`）：沒有它，非法 uuid 會落到
    // `resolveRole` 被收斂成 `not_found`——症狀相近但**碼不同**，而且那條路上的格式關就
    // 寄託在另一個模組的私有選擇上了（突變實測：拿掉 `.regex(UUID_RE)` 全族仍綠）。
    for (const bad of ["not-a-uuid", `x${NUL}y`]) {
      const call = await callTool(s.ctx.app, s.token, "read_note_outline", { note_id: bad });
      expect(call.result.isError).toBe(true);
      expect(call.result.content[0]!.text).toContain("Input validation error");
      expect("structuredContent" in call.result).toBe(false); // SDK 自產的 (4a)，沒有我們的 code
    }
    s.disconnect();
  });
});

describe("#108 兩支內容工具的共同接線", () => {
  it("role === none 的 id 與根本不存在的 id → not_found，且兩者的結果逐位元組同形（案 17／M2）", async () => {
    const s = await scene(TWO_SECTIONS);
    const stranger = await s.ctx.createUser({ email: `x-${randomUUID()}@example.com`, password: PASSWORD });
    const secret = await s.ctx.createNote(stranger.id, "Secret");
    const ghost = randomUUID();

    for (const tool of ["read_note_outline", "read_note_section"] as const) {
      const args = tool === "read_note_outline" ? {} : { section_id: "_top" };
      const hidden = await callTool(s.ctx.app, s.token, tool, { note_id: secret.id, ...args });
      const missing = await callTool(s.ctx.app, s.token, tool, { note_id: ghost, ...args });
      expect(hidden.result.isError).toBe(true);
      expect(hidden.result.structuredContent!.code).toBe("not_found");
      // 「存在但你沒權限」與「不存在」不得可辨——連訊息字串都一樣。
      expect(hidden.result.structuredContent).toEqual(missing.result.structuredContent);
      expect(hidden.result.content[0]!.text).toBe(missing.result.content[0]!.text);
    }
    s.disconnect();
  });

  // M2 與 M6 的交界：`touch` 只看文件有沒有載入、**不看角色**。presence 若排在
  // `role === "none"` 的 early return 之前，任何持 PAT 的人只要猜得到 note id，就能讓
  // `handle (claude)` 出現在**真正協作者**的畫面上——那同時是存在性洩漏與拒絕路徑的副作用。
  // ⚠ 這一案的前提是那篇筆記**真的在 `hocuspocus.documents` 裡**（所以要讓陌生人自己連上去
  //   seed 一份內容）；用一顆沒人開過的筆記測，`touch` 本來就是 no-op，斷言恆真。
  it("role === none 的拒絕路徑不 touch presence——即使那篇筆記正在被別人編輯（M2／M6）", async () => {
    const s = await scene(TWO_SECTIONS);
    const strangerEmail = `x-${randomUUID()}@example.com`;
    const stranger = await s.ctx.createUser({ email: strangerEmail, password: PASSWORD });
    const secret = await s.ctx.createNote(stranger.id, "Secret");
    const strangerSession = await s.ctx.loginAs(strangerEmail, PASSWORD);
    const strangerClient = await seedContent(s.ctx, strangerSession, secret.id, "# S\n\n協作者正在看的內容");
    const secretDoc = s.ctx.collab.hocuspocus.documents.get(secret.id)!;

    for (const tool of ["read_note_outline", "read_note_section"] as const) {
      const args = tool === "read_note_outline" ? {} : { section_id: "_top" };
      const call = await callTool(s.ctx.app, s.token, tool, { note_id: secret.id, ...args });
      expect(call.result.structuredContent!.code).toBe("not_found");
    }
    await tick();
    expect(secretDoc.awareness.getStates().get(presenceClientId(secret.id, s.tokenId))).toBeUndefined();

    // 對照面：同一顆 token 打**自己看得見的**筆記時確實會現身——上面那條不是「presence
    // 根本沒接上」的恆真斷言。
    await outlineOf(s.ctx.app, s.token, s.noteId);
    await tick();
    const ownDoc = s.ctx.collab.hocuspocus.documents.get(s.noteId)!;
    await waitFor("自己的筆記上有現身", 2_000, () =>
      ownDoc.awareness.getStates().get(presenceClientId(s.noteId, s.tokenId)) !== undefined
    );
    strangerClient.disconnect();
    s.disconnect();
  });

  it("讀路徑零副作用：兩支各 10 發後 note_states／backup／documents.size／last_edited 四欄都不變（案 18／M6）", async () => {
    const s = await scene(TWO_SECTIONS);
    await waitFor("server 收到編輯", 5_000, () =>
      docText(s.ctx.collab.hocuspocus.documents.get(s.noteId)!).includes("第二段內容")
    );
    s.disconnect();
    await waitFor("落盤並卸載", 10_000, () => s.ctx.collab.hocuspocus.documents.size === 0);

    const before = (await s.ctx.db.select().from(noteStates).where(eq(noteStates.noteId, s.noteId)))[0]!;
    const backups = (await s.ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, s.noteId))).length;
    const rowBefore = (await s.ctx.db.select().from(notes).where(eq(notes.id, s.noteId)))[0]!;

    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    for (let i = 0; i < 10; i += 1) {
      expect((await outlineOf(s.ctx.app, s.token, s.noteId)).sections).toHaveLength(3);
      expect((await sectionOf(s.ctx.app, s.token, s.noteId, rest[1]!.sectionId)).section.id).toBe(rest[1]!.sectionId);
    }

    const after = (await s.ctx.db.select().from(noteStates).where(eq(noteStates.noteId, s.noteId)))[0]!;
    expect(after.version).toBe(before.version);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((await s.ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, s.noteId))).length).toBe(backups);
    // ⚠ 這一行是**事後量**：它抓得到「讀完之後文件留在記憶體裡」，抓不到「過程中載入又
    //   卸載」（那條路上真正會留下痕跡的是 `note_states.version` 與 backup 列，由上面兩行守）。
    //   比照案 16 的處置，恆真的那半在這裡標明，不要當成「絕不開直連」的完整守衛。
    expect(s.ctx.collab.hocuspocus.documents.size).toBe(0);
    const rowAfter = (await s.ctx.db.select().from(notes).where(eq(notes.id, s.noteId)))[0]!;
    expect({
      at: rowAfter.lastEditedAt?.getTime() ?? null,
      by: rowAfter.lastEditedBy,
      tokenId: rowAfter.lastEditedTokenId,
      label: rowAfter.lastEditedAgentLabel,
      updatedAt: rowAfter.updatedAt.getTime(),
    }).toEqual({
      at: rowBefore.lastEditedAt?.getTime() ?? null,
      by: rowBefore.lastEditedBy,
      tokenId: rowBefore.lastEditedTokenId,
      label: rowBefore.lastEditedAgentLabel,
      updatedAt: rowBefore.updatedAt.getTime(),
    });
  });

  it("吃 contentRead 桶；role === none 的失敗不啃桶（案 31）", async () => {
    const s = await scene(TWO_SECTIONS, { limiters: { contentRead: new FixedWindowLimiter({ limit: 2, windowMs: 600_000 }) } });
    const ghost = randomUUID();
    // 五發打不到的筆記：全部 not_found，**一點都不啃桶**（`consume` 排在 `resolveRole` 之後）。
    for (let i = 0; i < 5; i += 1) {
      const call = await callTool(s.ctx.app, s.token, "read_note_outline", { note_id: ghost });
      expect(call.result.structuredContent!.code).toBe("not_found");
    }
    // 桶還是滿的：兩發成功，第三發才 429。
    expect((await outlineOf(s.ctx.app, s.token, s.noteId)).sections).toHaveLength(3);
    expect((await sectionOf(s.ctx.app, s.token, s.noteId, "_top")).section.id).toBe("_top");
    // 被 429 擋下的那一發**不得留下痕跡**（M6）：presence 排在桶之後，所以 awareness 的
    // clock 不會前進。這一段是「presence 不在桶之前」唯一的守衛——沒有它，把 touch 提到
    // 扣桶之前不會有任何測試變紅（突變實測過）。
    const doc = s.ctx.collab.hocuspocus.documents.get(s.noteId)!;
    const clientId = presenceClientId(s.noteId, s.tokenId);
    await tick();
    const clockBefore = doc.awareness.meta.get(clientId)?.clock;
    expect(clockBefore).toBeGreaterThan(0); // 對照面：前兩發成功的呼叫**有**現身
    const third = await callTool(s.ctx.app, s.token, "read_note_outline", { note_id: s.noteId });
    expect(third.result.isError).toBe(true);
    expect(third.result.structuredContent!.code).toBe("too_many_requests");
    await tick();
    expect(doc.awareness.meta.get(clientId)?.clock).toBe(clockBefore);
    s.disconnect();
  });

  // presence（§8.3／§8.4）：形狀比照 `note-presence.test.ts`。
  // ⚠ **顯示名的逐字斷言是這一份組字實作唯一的守衛**：`routes/notes.ts:552`／`:634`／`:710`
  //   已經各有一份同樣的組字（handle、空格、左括號、agent label、右括號），MCP 是**第四份**，
  //   而 #138 的 UI 靠這個字串。只斷言 target 的話，名字寫成別的形不會紅。抽成
  //   `presenceIdentity()` 留給 PR2／#138 後續（本棒的觸及面不含那兩個檔）。
  it("token 讀者現身（顯示名／顏色逐字）、outline 落文件開頭、section 落該段第一顆；cookie 讀者不 touch", async () => {
    const s = await scene(TWO_SECTIONS);
    const id = presenceClientId(s.noteId, s.tokenId);
    const doc = s.ctx.collab.hocuspocus.documents.get(s.noteId)!;
    const remote = () => doc.awareness.getStates().get(id) as { user?: { name: string; color: string }; cursor?: { anchor: unknown } } | undefined;
    const cursorText = (): string | null => {
      const r = remote();
      if (!r?.cursor) return null;
      const abs = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(r.cursor.anchor as never),
        doc
      );
      return abs ? (abs.type as Y.XmlText).toString() : null;
    };
    const expectedName = `${s.ownerHandle} (claude)`;

    // cookie 讀者先跑：MCP 的 session 路徑 `tokenId` 為 null，不得 touch。
    // ⚠ `mcpPost` 的 `cookie` 收的是**值**（helper 自己組 `SESSION_COOKIE=`），不是整條 header。
    const cookie = await signSession(testConfig.appSecret, { userId: s.ownerId, tv: 0 });
    const viaCookie = await mcpPost(
      s.ctx.app,
      rpc("tools/call", { name: "read_note_outline", arguments: { note_id: s.noteId } }),
      { cookie }
    );
    expect(viaCookie.statusCode).toBe(200);
    expect(viaCookie.json().result.isError).toBeUndefined();

    await outlineOf(s.ctx.app, s.token, s.noteId);
    await tick();
    await waitFor("名字到達", 2_000, () => remote()?.user?.name === expectedName);
    expect(remote()!.user!.color).toBe(PRESENCE_COLOR);
    // 本檔第一次 touch 這組 (noteId, tokenId)：clock 為 1 ⇒ 上面那發 cookie 呼叫沒有 touch。
    expect(doc.awareness.meta.get(id)?.clock).toBe(1);
    expect(cursorText()).toContain("A"); // outline → 文件開頭

    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    await sectionOf(s.ctx.app, s.token, s.noteId, rest[2]!.sectionId);
    await tick();
    await waitFor("游標到 B", 2_000, () => (cursorText() ?? "").includes("B"));
    expect(cursorText()).not.toContain("A");
    s.disconnect();
  });

  // §8.3 對「分頁不是快照」的處置 (b)：逐字寫進工具 description 給模型看。沒有這一案，
  // 刪掉那句話不會有任何東西變紅（處置 (a)＝known-limitations 由 PR3 補）。斷言的是**送到
  // wire 上的 `tools/list`**，不是原始碼常數——改對了常數卻沒接上 `registerTool` 也抓得到。
  it("tools/list 的逐字文案在 wire 上出現（§8.3 的分頁警告、§8.4 的讀完才給指紋）", async () => {
    const s = await scene(null);
    const res = await mcpPost(s.ctx.app, rpc("tools/list"), { token: s.token });
    expect(res.statusCode).toBe(200);
    const tools = res.json().result.tools as { name: string; description: string }[];
    const byName = (name: string): string => tools.find(t => t.name === name)!.description;
    expect(byName("read_note_outline")).toContain(
      "finish listing all pages before you start editing; editing while you page will skip sections."
    );
    expect(byName("read_note_section")).toContain(
      "arrives with the page that finishes it, so read to the end before you rewrite it."
    );
  });

  it("runTool() 涵蓋率：beforeTool 看到的名字集合逐字等於四支唯讀工具（承 Task 3）", async () => {
    const seen: string[] = [];
    const s = await scene(TWO_SECTIONS, { mcpTestHooks: { beforeTool: name => void seen.push(name) } });
    payloadOf<Record<string, unknown>>(await callTool(s.ctx.app, s.token, "list_notes"));
    payloadOf<Record<string, unknown>>(await callTool(s.ctx.app, s.token, "search_notes", { query: "a" }));
    await outlineOf(s.ctx.app, s.token, s.noteId);
    await sectionOf(s.ctx.app, s.token, s.noteId, "_top");
    // 漏把某一支包進 `runTool()` 不會有任何編譯錯誤——未捕捉例外會被 SDK 原樣送進模型脈絡。
    expect([...new Set(seen)].sort()).toEqual(
      ["list_notes", "read_note_outline", "read_note_section", "search_notes"].sort()
    );
    s.disconnect();
  });
});
