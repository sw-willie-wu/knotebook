// #106 內容端點（`GET /api/notes/:id/content`，#137 起還有寫入端）整合測試的共用縫。
// 與 `test/helpers.ts` 分家的理由：那支是全 repo 的 harness，這支只服務編輯／內容這一族，
// 且需要「指定 user 的 token」——`api-token-auth.test.ts` 的 `seedToken` 自建 user，用不上。
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { generateAccessToken, hashToken } from "../src/auth/api-token.js";
import { apiTokens } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { testEditingRuntime, type CollabTestCtx, type HttpSession, type TestClient } from "./helpers.js";

export async function seedTokenForUser(
  db: Db,
  userId: string,
  scope: "notes:read" | "notes:read notes:write" = "notes:read notes:write",
  name = "test"
): Promise<{ token: string; tokenId: string }> {
  const token = generateAccessToken();
  const [row] = await db
    .insert(apiTokens)
    .values({ userId, kind: "pat", name, scope, accessTokenHash: hashToken(token), accessExpiresAt: null })
    .returning();
  return { token, tokenId: row!.id };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export function getContent(app: FastifyInstance, noteId: string, token: string, section?: string) {
  return app.inject({
    method: "GET",
    url: `/api/notes/${noteId}/content${section ? `?section=${encodeURIComponent(section)}` : ""}`,
    headers: bearer(token),
  });
}

/** 以 provider 連線＋server 端 EditorSession 把 markdown 寫進筆記（真 BlockNote 結構，測試不手工組 XML）。 */
export async function seedContent(ctx: CollabTestCtx, session: HttpSession, noteId: string, markdown: string): Promise<TestClient> {
  const client = await session.connect(noteId);
  const s = await EditorSession.open(testEditingRuntime, client.doc);
  s.editor.replaceBlocks(s.editor.document, s.editor.tryParseMarkdownToBlocks(markdown));
  s.close();
  return client;
}

export function docText(doc: Y.Doc): string {
  return doc.getXmlFragment(YDOC_FRAGMENT).toString();
}

export async function waitFor(label: string, ms: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`等待逾時（${ms}ms）：${label}`);
}

export const tick = () => new Promise<void>(r => setImmediate(r));
