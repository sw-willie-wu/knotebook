import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { noteStates } from "../src/db/schema.js";
import { buildTestApp } from "./helpers.js";
import { seedDoc, wikilinkDoc } from "./copy-helpers.js";
import { seedGroup, seedNote, seedUser } from "./group-helpers.js";

const token = () => randomBytes(32).toString("base64url");

describe("#269 links in the public payload", () => {
  it("only targets with a custom public URL are included (path = /p/<handle>/<slug>); token-only public notes (even of the same owner), non-public and group notes are excluded; the body contains no target's token", async () => {
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
    // Leftover alias: public_slug set, public_token revoked ("an alias needs a token" is an app-layer invariant the DB does not enforce).
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

  it("links excludes the note itself (even when it has a custom public URL and links to itself); the alias endpoint also carries links", async () => {
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

  it("corrupt snapshot (decode failure) or no note_states -> links: [] and still 200", async () => {
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
    const brokenRes = await app.inject({ method: "GET", url: `/api/public/notes/${t1}` });
    expect(brokenRes.json().ydoc).toBe("");
  });
});
