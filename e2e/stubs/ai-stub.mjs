// e2e/stubs/ai-stub.mjs
//
// 零依賴（僅 node: 內建模組）vLLM-相容 chat completions stub，跑在 compose 的獨立容器
// （見 ../../docker-compose.e2e.yml 的 ai-stub 服務，只給 app 容器內網打，不發布 host port）。
// SSE 形狀對齊 apps/server/test/unit/__fixtures__/vllm-sse.txt，但每個 delta 同時帶
// `reasoning_content` 欄——E2E 層順帶驗「thinking 內容不會洩漏到使用者看得到的輸出」。
// `/fast`、`/slow` 不看請求內容、一律回 FINAL_CONTENT；`/echo` 回最後一則 user 訊息、第一個 `Original` 換成
// `Rewritten`（並排 PR-2 e2e 37：驗「AI 改一個字、寬度與並排標記原樣保留」）。

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = 9500;
const FINAL_CONTENT = "E2E rewritten text";

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 把字串依 code point 切成 n 個連續、非空（除非字串本身太短）片段，串接後等於原字串；不會切開 surrogate pair。 */
function splitIntoChunks(text, n) {
  const chars = Array.from(text);
  const chunks = [];
  const base = Math.max(1, Math.floor(chars.length / n));
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    const size = isLast ? chars.length - idx : base;
    chunks.push(chars.slice(idx, idx + size).join(""));
    idx += size;
  }
  return chunks;
}

async function streamCompletions(res, { content, chunkCount, intervalMs }) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const id = randomUUID();
  const contentChunks = splitIntoChunks(content, chunkCount);

  for (let i = 0; i < contentChunks.length; i++) {
    if (intervalMs > 0 && i > 0) await delay(intervalMs);
    const delta = { content: contentChunks[i], reasoning_content: `(internal reasoning chunk ${i})` };
    const event = { id, choices: [{ delta, index: 0 }] };
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** `/echo` 的回覆：最後一則 `role === "user"` 的字串 content，第一個 `Original` 換成 `Rewritten`；body 不合預期回 null。 */
function echoContent(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  const messages = body && typeof body === "object" ? body.messages : undefined;
  if (!Array.isArray(messages)) return null;
  const lastUser = messages.filter(m => m && typeof m === "object" && m.role === "user").at(-1);
  if (!lastUser || typeof lastUser.content !== "string") return null;
  return lastUser.content.replace("Original", "Rewritten");
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/fast/chat/completions") {
      return await streamCompletions(res, { content: FINAL_CONTENT, chunkCount: 8, intervalMs: 0 });
    }
    if (req.method === "POST" && req.url === "/slow/chat/completions") {
      // 守門流程用：間隔 1 秒、共 12 個 delta——總時長 ~11s，遠低於 server
      // IDLE_TIMEOUT_MS=60s，用來驗證「有活動就不會被判 idle」。
      return await streamCompletions(res, { content: FINAL_CONTENT, chunkCount: 12, intervalMs: 1000 });
    }
    if (req.method === "POST" && req.url === "/echo/chat/completions") {
      const content = echoContent(await readBody(req));
      if (content === null) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad_request" }));
        return;
      }
      return await streamCompletions(res, { content, chunkCount: 4, intervalMs: 0 });
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  } catch (err) {
    console.error("[ai-stub] unhandled error", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "server_error" }));
    }
  }
});

// 必須綁 0.0.0.0（同款理由見 fake-idp.mjs）：只有 compose 網路內的 app 容器會打這支，
// 但同一顆 Dockerfile.stub 兩個服務共用，行為一致比較不容易漏改。
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[ai-stub] listening on 0.0.0.0:${PORT}`);
});
