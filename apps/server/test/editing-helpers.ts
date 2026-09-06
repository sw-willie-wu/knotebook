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

/** 以 provider 連線＋server 端 EditorSession 把 markdown 寫進筆記，**並等到 server 真的收到才回傳**。 */
export async function seedContent(ctx: CollabTestCtx, session: HttpSession, noteId: string, markdown: string): Promise<TestClient> {
  const client = await session.connect(noteId);
  const s = await EditorSession.open(testEditingRuntime, client.doc);
  try {
    s.editor.replaceBlocks(s.editor.document, s.editor.tryParseMarkdownToBlocks(markdown));
  } finally {
    s.close(); // ⚠ 模組層單例 runtime 的 lease，throw 也要還
  }
  // 哨兵＝markdown 最後一行的可見文字（heading 的 `#` 前綴不進 XML 內文，要剝掉）。取「最後一行」
  // 是因為 Yjs 的更新是整批送達的，最後一行到了就代表整批都到了。
  //
  // ⚠ **哨兵必須是「會出現在 XML 字串裡的可見文字」，而且要「足以唯一辨識這份種子」。** 兩個前提
  //    各有一個雷，種子字串是**呼叫端**的責任（這裡沒有、也不該有辦法自己修）：
  //
  // (1) `docText()` 走的是 `fragment.toString()`——只有 block 的**內文與屬性值**會進去。像
  //     `![說明](/api/uploads/x)`、`---`、圍欄程式碼這類行會被解析成**非文字 block**（圖片存成
  //     `url="…"` 之類的屬性），那串 markdown 語法本身永遠不會出現在字串裡。種子若以這種行
  //     結尾，這個 `waitFor` 會跑滿 5 秒然後拋逾時。**做法：在那種 fixture 的尾巴補一行可見文字**
  //     （本棒的圖片 fixture 就是這麼寫的——見 `note-edits.test.ts` 那個「含上傳圖片的筆記」案）。
  //     **絕對不要改這裡的等待**：把它改成「找不到就跳過」或縮短逾時，等於把全檔約 25 個
  //     「seed 完立刻 disconnect」案子的前提整個抽掉，而且是**靜默**的（症狀是內容莫名其妙不見）。
  //     本 plan 的驗收表把「拿掉 seedContent 的等待」列為測試抓不到的危險突變。
  //
  // (2) 屬性名本身就含常見 ASCII 字元（`textColor` 就含 `x`、`t`、`e`…），所以**單字元的 ASCII
  //     哨兵等於沒等**：空文件正規化那一筆更新一到就命中了，種子本體到沒到根本沒被驗到。
  //     種子請寫得夠長／夠特別。（CJK 單字元沒有這個問題：屬性名與 block id 都是 ASCII。）
  const sentinel = markdown.split("\n").map(l => l.trim().replace(/^#+\s*/, "")).filter(Boolean).at(-1) ?? "";
  if (sentinel) {
    await waitFor(`server 收到種子內容（${sentinel}）`, 5_000, () =>
      docText(ctx.collab.hocuspocus.documents.get(noteId)!).includes(sentinel)
    );
  }
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
