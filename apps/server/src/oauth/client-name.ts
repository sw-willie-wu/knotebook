/**
 * DCR 的 `client_name` 是**未經驗證的自述**，會原樣顯示在同意頁標題。這份黑名單擋的
 * 是「把『名稱未經驗證』那行旁註在視覺上推走」的字元：bidi 覆寫／隔離、零寬、行分隔、
 * 控制字元。D10（loopback-only）之外唯一的釣魚防線。
 *
 * 逐**碼位**掃（不是逐 UTF-16 unit）：astral 字元才不會被拆成代理對誤判。
 */
export const DEFAULT_CLIENT_NAME = "MCP client";

export function hasUnsafeClientNameChar(name: string): boolean {
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true; // C0 / DEL / C1
    if (code === 0x061c) return true; // ARABIC LETTER MARK
    if (code >= 0x200b && code <= 0x200f) return true; // 零寬與 LRM/RLM
    if (code >= 0x2028 && code <= 0x202e) return true; // 行/段分隔 + LRE…RLO
    if (code >= 0x2066 && code <= 0x2069) return true; // 隔離控制
  }
  return false;
}
