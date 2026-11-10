/**
 * #93：`GET /api/search`（R1–R13）。查詢本體（排序、可見性、keyset 細節）在 `search-query.test.ts`；這裡驗 HTTP 層：
 * 驗證、trim、DTO 形、截斷、可見性、folderId 視角、限流（與 MCP 共用）、token、`match=body`、分頁與游標竄改。
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { NoteDto, NoteSearchHitDto, NoteSearchResultDto } from "@knotebook/shared";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedShare, seedUser } from "./group-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { seedIndexedNote } from "./search-helpers.js";
import { seedFolder } from "./folder-helpers.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import type { Blk } from "./search-doc.js";

type Auth = { cookies: Record<string, string> } | { headers: Record<string, string> };
const asUser = async (userId: string): Promise<Auth> => ({ cookies: await cookieOf(userId) });

function get(app: FastifyInstance, auth: Auth | null, qs: string) {
  return app.inject({ method: "GET", url: `/api/search${qs}`, ...(auth ?? {}) });
}
async function ok(app: FastifyInstance, auth: Auth, qs: string): Promise<NoteSearchResultDto> {
  const res = await get(app, auth, qs);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as NoteSearchResultDto;
}
const idsOf = (r: NoteSearchResultDto) => r.hits.map(h => h.note.id);
const enc = encodeURIComponent;
const body = (text: string): Blk[] => [{ id: "p", text }];
/** 解開游標、改一段、再包回去（竄改案用）。 */
function tamper(cursor: string, edit: (parts: string[]) => string[]): string {
  const parts = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  return Buffer.from(edit(parts).join("|"), "utf8").toString("base64url");
}

describe("R1 未登入", () => {
  it("沒有 session 也沒有 token → 401", async () => {
    const { app } = await buildTestApp();
    expect((await get(app, null, "?q=abc")).statusCode).toBe(401);
  });
});

describe("R2 驗證 → 400 invalid_body（不扣桶）", () => {
  it("缺 q、空、空白、201 code unit、101 emoji、NUL、limit 0／51／abc／1.5、match=title、重複 q、未知參數", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    const bad = [
      "", "?q=", "?q=%20%20", `?q=${"a".repeat(201)}`, `?q=${enc("😀".repeat(101))}`, "?q=a%00b",
      "?q=ab&limit=0", "?q=ab&limit=51", "?q=ab&limit=abc", "?q=ab&limit=1.5", "?q=ab&match=title", "?q=a&q=b", "?q=ab&foo=1",
    ];
    for (const qs of bad) {
      const res = await get(app, auth, qs);
      expect(res.statusCode, qs).toBe(400);
      expect(res.json().error.code, qs).toBe("invalid_body");
    }
    expect((await get(app, auth, `?q=${"a".repeat(200)}`)).statusCode).toBe(200);
    expect((await get(app, auth, `?q=${enc("😀".repeat(100))}`)).statusCode).toBe(200);
  });

  it("連打 70 發 400 之後一發合法請求仍 200（驗證失敗不扣桶；search 桶每分 60）", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    for (let i = 0; i < 70; i += 1) expect((await get(app, auth, "?q=%20")).statusCode).toBe(400);
    expect((await get(app, auth, "?q=ab")).statusCode).toBe(200);
  });
});

describe("R3 trim", () => {
  it("q=%20report%20 與 q=report 結果相同；游標互通（指紋用 trim 後的字）", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    for (let i = 0; i < 3; i += 1) await seedIndexedNote(db, { ownerId: u.id }, `plain ${i}`, body("a report inside"));
    const a = await ok(app, auth, "?q=%20report%20");
    const b = await ok(app, auth, "?q=report");
    expect(a).toEqual(b);
    expect(idsOf(a).length).toBe(3);
    const first = await ok(app, auth, "?q=report&limit=1");
    const next = await ok(app, auth, `?q=%20report%20&limit=1&cursor=${first.nextCursor}`);
    expect(idsOf(next)).toEqual([idsOf(a)[1]]);
  });
});

describe("R4 形狀", () => {
  it("matchedOn 三值；title 的 matches 為 []；body 的 sectionId＝heading id、snippet 含查詢字；note 除 sizeBytes 外同 GET /api/notes", async () => {
    const { app, db } = await buildTestApp();
    const [u, other] = await Promise.all([seedUser(db), seedUser(db)]);
    const auth = await asUser(u.id);
    const t = await seedIndexedNote(db, { ownerId: u.id }, "kappa title", body("nothing"));
    const bo = await seedIndexedNote(db, { ownerId: u.id }, "kappa both", [{ id: "hb", type: "heading", level: 1, text: "Sec" }, { id: "p", text: "kappa here" }]);
    const shared = await seedIndexedNote(db, { ownerId: other.id }, "plain shared", [{ id: "hs", type: "heading", level: 2, text: "Shared sec" }, { id: "p", text: "the kappa word" }]);
    await seedShare(db, shared.id, u.id, "editor");
    const g = await seedGroup(db, "G", [{ userId: other.id, role: "admin" }, { userId: u.id, role: "member" }]);
    const gn = await seedIndexedNote(db, { groupId: g.id }, "plain group", body("group kappa"));
    const r = await ok(app, auth, "?q=kappa");
    const byId = new Map(r.hits.map(h => [h.note.id, h]));
    expect(byId.get(t.id)!.matchedOn).toBe("title");
    expect(byId.get(t.id)!.matches).toEqual([]);
    expect(byId.get(bo.id)!.matchedOn).toBe("both");
    expect(byId.get(shared.id)!.matchedOn).toBe("body");
    const m = byId.get(shared.id)!.matches[0]!;
    expect(m.sectionId).toBe("hs");
    expect(m.heading).toBe("Shared sec");
    expect(m.snippet).toContain("kappa");
    expect(Object.keys(m).sort()).toEqual(["heading", "sectionId", "snippet"]);
    const list = (await app.inject({ method: "GET", url: "/api/notes", ...auth })).json() as NoteDto[];
    for (const id of [t.id, bo.id, shared.id, gn.id]) {
      const hit = byId.get(id)!;
      const { sizeBytes, ...rest } = list.find(n => n.id === id)!;
      expect(sizeBytes, "清單有 sizeBytes").toBeTypeOf("number");
      expect(hit.note, id).toEqual(rest);
      expect("sizeBytes" in hit.note).toBe(false);
    }
    expect(byId.get(shared.id)!.note.role).toBe("editor");
    expect(Object.keys(r).sort()).toEqual(["hits", "nextCursor"]);
  });
});

describe("R5 截斷與片段長度", () => {
  it("heading 300 字 → 200 code unit；400 個 \" 的內文、查 \" → 片段 code unit 長度 150–160", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    await seedIndexedNote(db, { ownerId: u.id }, "h", [{ id: "hh", type: "heading", level: 1, text: "H".repeat(300) }, { id: "p", text: "omega" }]);
    await seedIndexedNote(db, { ownerId: u.id }, "q", body('"'.repeat(400)));
    const h = (await ok(app, auth, "?q=omega")).hits[0]!.matches[0]!;
    expect(h.heading.length).toBe(200);
    const s = (await ok(app, auth, `?q=${enc('"')}`)).hits[0]!.matches[0]!;
    expect(s.snippet.length).toBeGreaterThanOrEqual(150);
    expect(s.snippet.length).toBeLessThanOrEqual(160);
  });

  it("含 emoji 的查詢：命中段以 code point 計（qlen），命中後的連續空白照樣壓成一個", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    // 命中後緊跟三個空白：qlen 以 code point 計＝2，命中段是「😀x」、之後的空白被壓成一個；若誤用 code unit（3），
    // 命中段會吞進第一個空白（命中段不壓空白），結果變兩個空白。
    await seedIndexedNote(db, { ownerId: u.id }, "e", body(`${"a".repeat(60)} 😀x   ${"b".repeat(200)}`));
    const s = (await ok(app, auth, `?q=${enc("😀x")}`)).hits[0]!.matches[0]!;
    expect(s.snippet).toContain("😀x b");
    expect(s.snippet).not.toContain("😀x  ");
    expect(s.snippet.length).toBeLessThanOrEqual(160);
  });
});

describe("R6 可見性", () => {
  it("陌生人的私人筆記 0；分享後 1；群組成員看得到、非成員 0；垃圾桶裡的 0", async () => {
    const { app, db } = await buildTestApp();
    const [a, b, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const n = await seedIndexedNote(db, { ownerId: a.id }, "plain", body("visprobe"));
    expect(idsOf(await ok(app, await asUser(b.id), "?q=visprobe"))).toEqual([]);
    await seedShare(db, n.id, b.id, "viewer");
    expect(idsOf(await ok(app, await asUser(b.id), "?q=visprobe"))).toEqual([n.id]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "member" }]);
    const gn = await seedIndexedNote(db, { groupId: g.id }, "g", body("grpprobe"));
    expect(idsOf(await ok(app, await asUser(b.id), "?q=grpprobe"))).toEqual([gn.id]);
    expect(idsOf(await ok(app, await asUser(c.id), "?q=grpprobe"))).toEqual([]);
    const del = await app.inject({ method: "DELETE", url: `/api/notes/${n.id}`, cookies: await cookieOf(a.id) });
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect(idsOf(await ok(app, await asUser(a.id), "?q=visprobe"))).toEqual([]);
    expect(idsOf(await ok(app, await asUser(b.id), "?q=visprobe"))).toEqual([]);
  });
});

describe("R7 folderId（呼叫者視角）", () => {
  it("被分享者放進自己的資料夾 → note.folderId 是被分享者的、不是擁有者的", async () => {
    const { app, db } = await buildTestApp();
    const [owner, sharee] = await Promise.all([seedUser(db), seedUser(db)]);
    const n = await seedIndexedNote(db, { ownerId: owner.id }, "plain", body("fldprobe"));
    const of = await seedFolder(db, { personal: owner.id });
    const sf = await seedFolder(db, { shared: sharee.id });
    await db.execute(sql`update notes set folder_id = ${of.id}::uuid where id = ${n.id}::uuid`);
    await seedShare(db, n.id, sharee.id, "viewer");
    await db.execute(sql`insert into note_placements (user_id, note_id, folder_id) values (${sharee.id}::uuid, ${n.id}::uuid, ${sf.id}::uuid)`);
    expect((await ok(app, await asUser(sharee.id), "?q=fldprobe")).hits[0]!.note.folderId).toBe(sf.id);
    expect((await ok(app, await asUser(owner.id), "?q=fldprobe")).hits[0]!.note.folderId).toBe(of.id);
  });
});

describe("R8／R9 限流（與 MCP 共用）與 token", () => {
  it("search 桶 1 → 第二發 429；先打 REST 再打 MCP search_notes → too_many_requests", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ search: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    expect((await get(app, auth, "?q=ab")).statusCode).toBe(200);
    const second = await get(app, auth, "?q=ab");
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("too_many_requests");

    const { app: app2, db: db2 } = await buildTestApp({ limiters: freshLimiters({ search: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const v = await seedUser(db2);
    const { token } = await seedTokenForUser(db2, v.id, "notes:read");
    expect((await get(app2, await asUser(v.id), "?q=ab")).statusCode).toBe(200);
    const res = await mcpPost(app2, rpc("tools/call", { name: "search_notes", arguments: { query: "ab" } }), { token });
    const result = res.json().result as { isError?: true; structuredContent: { code: string } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("too_many_requests");
  });

  it("R9 notes:read token → 200；同一顆桶對 token 一樣扣", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ search: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const u = await seedUser(db);
    const { token } = await seedTokenForUser(db, u.id, "notes:read");
    await seedIndexedNote(db, { ownerId: u.id }, "plain", body("tokprobe"));
    const auth: Auth = { headers: bearer(token) };
    expect(idsOf(await ok(app, auth, "?q=tokprobe")).length).toBe(1);
    expect((await get(app, auth, "?q=tokprobe")).statusCode).toBe(429);
  });
});

describe("R10 match=body", () => {
  it("只中標題的不出現；不帶 match 時出現", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    const t = await seedIndexedNote(db, { ownerId: u.id }, "lambda title", body("nothing"));
    const b = await seedIndexedNote(db, { ownerId: u.id }, "plain", body("lambda body"));
    expect(idsOf(await ok(app, auth, "?q=lambda&match=body"))).toEqual([b.id]);
    expect(idsOf(await ok(app, auth, "?q=lambda&match=all"))).toEqual([t.id, b.id]);
    expect(idsOf(await ok(app, auth, "?q=lambda"))).toEqual([t.id, b.id]);
  });
});

describe("R11 分頁", () => {
  it("25 篇：預設 20＋nextCursor → 帶 cursor 5＋null；聯集＝limit=50 一次取、無重複", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    for (let i = 0; i < 25; i += 1) await seedIndexedNote(db, { ownerId: u.id }, `plain ${i}`, body("pageprobe"));
    const p1 = await ok(app, auth, "?q=pageprobe");
    expect(p1.hits.length).toBe(20);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await ok(app, auth, `?q=pageprobe&cursor=${p1.nextCursor}`);
    expect(p2.hits.length).toBe(5);
    expect(p2.nextCursor).toBeNull();
    const all = await ok(app, auth, "?q=pageprobe&limit=50");
    expect([...idsOf(p1), ...idsOf(p2)]).toEqual(idsOf(all));
    expect(new Set([...idsOf(p1), ...idsOf(p2)]).size).toBe(25);
  });

  it("恰好 40 篇、limit=20 → 第二頁 20 篇且 nextCursor: null", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    for (let i = 0; i < 40; i += 1) await seedIndexedNote(db, { ownerId: u.id }, `plain ${i}`, body("fortyprobe"));
    const p1 = await ok(app, auth, "?q=fortyprobe&limit=20");
    const p2 = await ok(app, auth, `?q=fortyprobe&limit=20&cursor=${p1.nextCursor}`);
    expect(p2.hits.length).toBe(20);
    expect(p2.nextCursor).toBeNull();
  });
});

describe("R12／R13 游標竄改與不洩漏", () => {
  it("竄改的游標全部 400（不是 500）、不扣桶；換 q／換 match 帶舊游標也 400", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ search: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }) });
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    for (let i = 0; i < 2; i += 1) await seedIndexedNote(db, { ownerId: u.id }, `plain ${i}`, body("tamperprobe"));
    const first = await ok(app, auth, "?q=tamperprobe&limit=1"); // 扣 1
    const c = first.nextCursor!;
    expect(c).not.toBeNull();
    const bad = [
      "!!!notbase64",
      tamper(c, p => ["t", ...p.slice(1)]),
      tamper(c, p => p.slice(0, 4)),
      tamper(c, p => [p[0]!, p[1]!, "4", p[3]!, p[4]!]),
      tamper(c, p => [p[0]!, p[1]!, "-1", p[3]!, p[4]!]),
      tamper(c, p => [p[0]!, p[1]!, "1.0", p[3]!, p[4]!]),
      tamper(c, p => [p[0]!, p[1]!, p[2]!, "2026-13-01T00:00:00.000000Z", p[4]!]),
      tamper(c, p => [p[0]!, p[1]!, p[2]!, p[3]!.replace(/\d{6}Z$/, "00000Z"), p[4]!]),
      tamper(c, p => [p[0]!, p[1]!, p[2]!, p[3]!, "not-a-uuid"]),
    ];
    for (const cur of bad) {
      const res = await get(app, auth, `?q=tamperprobe&limit=1&cursor=${enc(cur)}`);
      expect(res.statusCode, cur).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    for (const qs of [`?q=tamperprob&limit=1&cursor=${c}`, `?q=tamperprobe&limit=1&match=body&cursor=${c}`]) {
      const res = await get(app, auth, qs);
      expect(res.statusCode, qs).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect((await get(app, auth, `?q=tamperprobe&limit=1&cursor=${c}`)).statusCode).toBe(200); // 扣 2（前面 11 發沒扣）
    expect((await get(app, auth, "?q=tamperprobe")).statusCode).toBe(429);
  });

  it("R13 A 的游標給 B（同 q、同 match）→ 200，只含 B 看得到的", async () => {
    const { app, db } = await buildTestApp();
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    await seedIndexedNote(db, { ownerId: a.id }, "a1", body("leakcur"));
    await seedIndexedNote(db, { ownerId: a.id }, "a2", body("leakcur"));
    const bn = await seedIndexedNote(db, { ownerId: b.id }, "b1", body("leakcur"));
    await db.execute(sql`update notes set updated_at = '2000-01-01T00:00:00Z' where id = ${bn.id}::uuid`);
    const first = await ok(app, await asUser(a.id), "?q=leakcur&limit=1");
    const r = await ok(app, await asUser(b.id), `?q=leakcur&limit=1&cursor=${first.nextCursor}`);
    expect(idsOf(r)).toEqual([bn.id]);
    const hit: NoteSearchHitDto = r.hits[0]!;
    expect(hit.note.ownerId).toBe(b.id);
  });
});
