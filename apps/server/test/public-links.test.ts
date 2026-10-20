import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { noteStates } from "../src/db/schema.js";
import { buildTestApp } from "./helpers.js";
import { seedDoc, wikilinkDoc } from "./copy-helpers.js";
import { seedGroup, seedNote, seedUser } from "./group-helpers.js";

// spec 2026-10-13 site-links §11.1、§15.2 I4（server 半）；E8'：只收有自訂公開網址的目標，token 形永不出現在 payload。
const token = () => randomBytes(32).toString("base64url");

describe("#269 公開 payload 的 links", () => {
  it("只收有自訂公開網址的目標（path＝/p/<handle>/<slug>）；只有 token 形公開的（即使同 owner）、非公開、群組筆記都不收；全文不含任何目標的 token", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const other = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }]);
    const aliasTok = token();
    const tokenOnlyTok = token();
    const aliased = await seedNote(db, { ownerId: other.id }, { title: "Aliased", publicToken: aliasTok, publicSlug: "pub-a" });
    const tokenOnly = await seedNote(db, { ownerId: owner.id }, { title: "Token Only", publicToken: tokenOnlyTok });
    const priv = await seedNote(db, { ownerId: owner.id }, { title: "Private" });
    const grp = await seedNote(db, { groupId: g.id }, { title: "Group" });
    // 殘留別名：public_slug 有、public_token 已撤（「有 token 才能有別名」是應用層不變量、DB 不強制——schema.ts 的註解）。
    const residual = await seedNote(db, { ownerId: other.id }, { title: "Residual", publicSlug: "res" });
    const srcTok = token();
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Src", publicToken: srcTok });
    await seedDoc(db, src.id, wikilinkDoc([aliased.id, tokenOnly.id, priv.id, grp.id, residual.id]));

    const res = await app.inject({ method: "GET", url: `/api/public/notes/${srcTok}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().links).toEqual([{ id: aliased.id, title: "Aliased", path: `/p/${other.handle}/pub-a` }]);
    expect(res.body).not.toContain(tokenOnlyTok);
    expect(res.body).not.toContain(aliasTok);
    expect(Object.keys(res.json()).sort()).toEqual(["links", "title", "width", "ydoc"]);
  });

  it("links 不含本篇自己（本篇有自訂公開網址、文中有同篇連結時亦然）；別名形端點同樣帶 links", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const selfTok = token();
    const self = await seedNote(db, { ownerId: owner.id }, { title: "Self", publicToken: selfTok, publicSlug: "self-pub" });
    const other = await seedNote(db, { ownerId: owner.id }, { title: "Other", publicToken: token(), publicSlug: "other-pub" });
    await seedDoc(db, self.id, wikilinkDoc([self.id, other.id]));
    for (const url of [`/api/public/notes/${selfTok}`, `/api/public/notes/${owner.handle}/self-pub`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.json().links, url).toEqual([{ id: other.id, title: "Other", path: `/p/${owner.handle}/other-pub` }]);
    }
  });

  it("快照壞掉（解碼失敗）或沒有 note_states → links: []、仍 200", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const t1 = token();
    const t2 = token();
    const broken = await seedNote(db, { ownerId: owner.id }, { title: "Broken", publicToken: t1 });
    await seedNote(db, { ownerId: owner.id }, { title: "Empty", publicToken: t2 });
    await db.insert(noteStates).values({ noteId: broken.id, ydoc: Buffer.from([1, 2, 3, 4, 5]), version: 1 });
    for (const t of [t1, t2]) {
      const res = await app.inject({ method: "GET", url: `/api/public/notes/${t}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().links).toEqual([]);
    }
  });
});
