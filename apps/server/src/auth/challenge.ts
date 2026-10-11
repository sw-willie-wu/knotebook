/**
 * #107：`WWW-Authenticate: Bearer …` 的唯一組字處（RFC 6750 §3）。
 *
 * ## resource_metadata 一律指向 /api/mcp
 *
 * 全站只有一個 resource identifier（`<issuer>/api/mcp`），所有掛 `authenticateAny`
 * 的路由共用同一份 protected resource metadata。
 *
 * **這對 RFC 9728 §3.3 第二段是刻意偏離**——原文要求「經 `WWW-Authenticate` 的
 * `resource_metadata` 取得的文件，其 `resource` 值 MUST 等於 client 發出請求的
 * URL，否則 MUST NOT use」。於是嚴格的 client 在 `/api/notes` 上取得的 PRM 會被
 * 丟棄（等同沒帶 challenge），只有在 `/api/mcp` 上取得的可用——而 `/api/mcp` 正是
 * MCP client 的唯一入口，實務上不影響。**不要「順手修正」成只有 `/api/mcp` 才帶**：
 * 那會讓 #106 之後的新端點 401 完全沒有發現資訊。取捨記在 docs/known-limitations.md。
 *
 * ## scope 是 challenge 集合，不是 required 單值
 *
 * MCP 規格要求 client 把 challenge 上的 scope 當作本次操作的**權威值**、只會要
 * 這麼多；server SHOULD 一次給齊該資源需要的全部 scope。所以 `/api/mcp` 的
 * challenge 必須是 `notes:read notes:write notes:move`（#239：搬移也在內）——照上面
 * 那條規格，沒列的 scope 守規矩的 client 不會要求，同意頁也就不會出現那一項勾選（漏
 * `notes:write` 只拿得到唯讀 token、漏 `notes:move` 就拿不到搬移）。授權判定用的
 * `required` 是另一個參數，見 `auth/bearer.ts`。
 *
 * ## 組字紀律
 *
 * auth-param 之間用 `, ` 分隔（RFC 7235 的 #rule），每個值都加雙引號。`issuer`
 * 原樣帶入、**不補尾斜線**——傳進 `publicUrl.href` 而非 `origin` 會組出
 * `…:3000//.well-known/…`（見 `config.ts` 的 `publicUrlIssuer`）。
 * 參數順序對 RFC 6750 的解析器沒有意義，測試一律逐項斷言，不對整串做字面比對。
 *
 * ⚠ **值不逸出雙引號**。今天三個入口都是 server 控制的常數（`issuer` 是 URL 解析
 * 過的 origin、`scope` 是路由層的字面值、`error` 是型別聯集），所以沒有洞——但
 * 這條性質是靠呼叫端維持的。**絕不可把請求參數回聲進來**：值裡一個 `"` 就能提前
 * 關閉 quoted-string，接著注入自己的 `resource_metadata=` 把 client 指向攻擊者的
 * 授權伺服器。#132 的 `/authorize` 會收到 client 送的 `scope`，那一支要組
 * challenge 的話得先過白名單，不能直接轉傳。
 */
export interface ChallengeInput {
  /** `publicUrlIssuer(config.publicUrl)` 的輸出：scheme://host:port，無尾斜線。 */
  issuer: string;
  /** 該路由宣告的 challenge scope 集合。 */
  scope: string;
  error?: "invalid_token" | "insufficient_scope";
}

export function buildBearerChallenge({ issuer, scope, error }: ChallengeInput): string {
  const params = [
    ...(error === undefined ? [] : [`error="${error}"`]),
    `scope="${scope}"`,
    `resource_metadata="${issuer}/.well-known/oauth-protected-resource/api/mcp"`,
  ];
  return `Bearer ${params.join(", ")}`;
}

/**
 * #200 spec §4.5：transfer token 端點（兩支上傳／下載路由）的 401 challenge。
 *
 * **不能用 `buildBearerChallenge`**：它一律附 `resource_metadata`，懂 OAuth 的 client 會以為要走發現流程；transfer
 * token 也沒有可要求的 scope，所以兩者都不帶。`realm` 是固定常數。帶 error 的形用於「送了 Bearer 但被拒」，不帶的形
 * 用於 `other-scheme`（RFC 6750 §3：unsupported authentication method SHOULD NOT 帶 error）。值同樣不逸出引號——
 * 唯一的入口是型別聯集，不得把請求內容回聲進來。
 */
export function buildTransferChallenge(error?: "invalid_token"): string {
  return error === undefined ? `Bearer realm="knotebook-transfer"` : `Bearer realm="knotebook-transfer", error="${error}"`;
}
