/**
 * 「用 MCP 連接 Claude」的設定片段（#247 §5.3）：PAT 兩段＋OAuth 兩段。純函式，輸入是站台 origin（`window.location.origin`）；
 * token 位置一律 `<YOUR_TOKEN>` 佔位，**不帶入任何 token 值**。
 * OAuth 片段只在 https 顯示（`oauthAvailable`，#159）；寫法是 Willie 2026-10-20 實測過的（Windows Desktop）。
 * ⚠ 這是 user-facing 文件敘述：改片段前照 memory `g:doc-claim-audit-apparatus` 實連一次，並同步 docs/mcp.md How to connect。
 */

export const TOKEN_PLACEHOLDER = "<YOUR_TOKEN>";

export function mcpEndpoint(origin: string): string {
  return `${origin}/api/mcp`;
}

/** Claude Code：PAT 走靜態 Bearer header；`-s user` 讓它在任何目錄都可用（預設 local scope 只在下指令的目錄生效，docs/mcp.md）。 */
export function buildClaudeCodeSnippet(origin: string): string {
  return `claude mcp add -s user --transport http knotebook ${mcpEndpoint(origin)} --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`;
}

/**
 * Claude Desktop：經 mcp-remote 帶 header。header 值放進 `env`、args 裡寫 `Authorization:${AUTH_HEADER}`——
 * mcp-remote README：Claude Desktop（Windows）等客戶端呼叫 npx 時不跳脫 args 內的空白，`Bearer <token>` 會被切開。
 * `http://` 站台加 `--allow-http`（mcp-remote 對非 https 端點要明示放行）。
 * 只輸出 `"knotebook": {…}` 這一段：使用者把它加進既有的 `mcpServers` 底下，不會貼出第二個 `mcpServers`。
 */
export function buildDesktopSnippet(origin: string): string {
  const args = ["-y", "mcp-remote", mcpEndpoint(origin), "--header", "Authorization:${AUTH_HEADER}"];
  if (origin.startsWith("http:")) args.push("--allow-http");
  const entry = { command: "npx", args, env: { AUTH_HEADER: `Bearer ${TOKEN_PLACEHOLDER}` } };
  return `"knotebook": ${JSON.stringify(entry, null, 2)}`;
}

/** OAuth 只在 https 站台可用：client 端拒絕把 token 交換送到非 https 的伺服器（#159）。 */
export function oauthAvailable(origin: string): boolean {
  return origin.startsWith("https:");
}

/** Claude Code OAuth：`-t http` 必要（不帶 transport 一律當 stdio）；之後在 Claude Code 的 /mcp 選 Authenticate。 */
export function buildClaudeCodeOauthSnippet(origin: string): string {
  return `claude mcp add -s user -t http knotebook ${mcpEndpoint(origin)}`;
}

/** Claude Desktop OAuth（Windows 形）：`cmd /c npx` 包 mcp-remote；無 env、無 header、無 `--allow-http`。同樣只輸出 `"knotebook": {…}`。 */
export function buildDesktopOauthSnippet(origin: string): string {
  const entry = { command: "cmd", args: ["/c", "npx", "-y", "mcp-remote", mcpEndpoint(origin)] };
  return `"knotebook": ${JSON.stringify(entry, null, 2)}`;
}
