import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import * as Y from "yjs";
import { KNOWLEDGE_PROP_NAMES, YDOC_FRAGMENT, hasKnowledgeAttributes } from "@knotebook/shared";
import { noteStates } from "../src/db/schema.js";
import { buildTestApp } from "./helpers.js";
import { loadDoc, seedDoc } from "./copy-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";

const token = () => randomBytes(32).toString("base64url");

const VALUES = ["alice-when-7f3e", "bob-conclusion-91c2", "2031-04-05", "k_5a5a5a5a", "11111111-2222-3333-4444-555555555555#k_6b6b6b6b"];
const KNOWLEDGE = {
  knowledgeId: "k_5a5a5a5a",
  knowledgeWhen: "alice-when-7f3e",
  knowledgeConclusion: "bob-conclusion-91c2",
  knowledgeEvidence: "docs",
  knowledgeVerified: "2031-04-05",
  knowledgeStatus: "outdated",
  knowledgeSupersededBy: "11111111-2222-3333-4444-555555555555#k_6b6b6b6b",
};

function el(name: string, attrs: Record<string, string> = {}, children: Array<Y.XmlElement | Y.XmlText> = []): Y.XmlElement {
  const e = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (children.length > 0) e.insert(0, children);
  return e;
}
function text(s: string): Y.XmlText {
  const t = new Y.XmlText();
  t.insert(0, s);
  return t;
}

function knowledgeDoc(): Y.Doc {
  const doc = new Y.Doc();
  const nested = el("column", {}, [el("blockContainer", { id: "c1" }, [el("heading", { level: "2", ...KNOWLEDGE }, [text("Column heading")])])]);
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [
    el("blockGroup", {}, [
      el("blockContainer", { id: "a" }, [el("heading", { level: "1", ...KNOWLEDGE }, [text("Top heading")])]),
      el("blockContainer", { id: "b" }, [el("columnList", {}, [nested])]),
    ]),
  ]);
  return doc;
}

function expectClean(ydocB64: string): void {
  const bytes = Buffer.from(ydocB64, "base64");
  for (const v of VALUES) expect(bytes.includes(Buffer.from(v, "utf8")), v).toBe(false);
  for (const name of KNOWLEDGE_PROP_NAMES) expect(bytes.includes(Buffer.from(name, "utf8")), name).toBe(false);
  const decoded = new Y.Doc();
  Y.applyUpdate(decoded, bytes);
  expect(hasKnowledgeAttributes(decoded.getXmlFragment(YDOC_FRAGMENT))).toBe(false);
  expect(decoded.getXmlFragment(YDOC_FRAGMENT).toString()).toContain("Top heading");
}

describe("public note responses and knowledge info", () => {
  it("contain none of the knowledge names or values in either link form, and the stored note keeps them", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const tok = token();
    const note = await seedNote(db, { ownerId: owner.id }, { title: "K", publicToken: tok, publicSlug: "k-pub" });
    await seedDoc(db, note.id, knowledgeDoc());

    for (const url of [`/api/public/notes/${tok}`, `/api/public/notes/${owner.handle}/k-pub`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      for (const v of VALUES) expect(res.body, `${url} ${v}`).not.toContain(v);
      expectClean(res.json().ydoc);
    }
    const stored = await loadDoc(db, note.id);
    expect(hasKnowledgeAttributes(stored!.getXmlFragment(YDOC_FRAGMENT))).toBe(true);
  });

  it("serve an undecodable stored state as an empty payload the client cannot decode, without the stored bytes", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const tok = token();
    const note = await seedNote(db, { ownerId: owner.id }, { title: "Broken", publicToken: tok });
    await db.insert(noteStates).values({ noteId: note.id, ydoc: Buffer.from([1, 2, 3, 4, 5]), version: 1 });
    const res = await app.inject({ method: "GET", url: `/api/public/notes/${tok}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().ydoc).toBe("");
    expect(res.body).not.toContain(Buffer.from([1, 2, 3, 4, 5]).toString("base64"));
    expect(res.json().links).toEqual([]);
  });
});
