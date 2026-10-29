import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { OAUTH_APP_IDLE_DAYS } from "@knotebook/shared";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { REPO_URL } from "./about-links";
import {
  buildClaudeCodeOauthSnippet,
  buildClaudeCodeSnippet,
  buildDesktopOauthSnippet,
  buildDesktopSnippet,
  mcpEndpoint,
  oauthAvailable,
} from "./mcp-snippets";
import { SettingsGroup } from "./SettingsLayout";
import "@/i18n/management-strings";

/** 與關於頁同形：由 REPO_URL 組出，指向 docs/mcp.md 的 How to connect（Windows 上 Desktop 包 `cmd /c` 的寫法在那裡）。 */
const MCP_DOCS_URL = `${REPO_URL}/blob/main/docs/mcp.md#how-to-connect`;
const LINK_CLASS = "text-brand-on-soft underline-offset-4 hover:underline";
const LIST_CLASS = "list-none space-y-4 pl-0";
const HEADING_CLASS = "text-sm font-semibold";

/**
 * 「用 MCP 連接 Claude」（#247 §5.3、W10；#298 分兩段）：本站端點，然後「方式一：OAuth 授權」與「方式二：個人 token」
 * 兩段，各有 Claude Code／Claude Desktop 片段（組裝在 `mcp-snippets.ts`；PAT 片段的 token 位置一律 `<YOUR_TOKEN>` 佔位，
 * **不自動帶入任何 token 值**），最後一句權限對照（與 docs/mcp.md 工具表同步）。
 * OAuth 只在 https 站台顯示（#159）：http 時那一段只剩標題與一行說明。`origin` 選填，預設 `window.location.origin`
 * （jsdom 固定是 http，要測 https 分支需要這個縫）。
 * ⚠ 這是 user-facing 文件敘述：改片段前照 memory `g:doc-claim-audit-apparatus` 對 demo 實連一次。
 */
export function McpConnectGuide({ origin = window.location.origin }: { origin?: string } = {}) {
  const { t } = useTranslation();

  async function copy(text: string): Promise<void> {
    const ok = await copyText(text);
    toast(ok ? { title: t("settings.authorization.mcp.copied") } : { title: t("settings.authorization.mcp.copyFailed"), variant: "destructive" });
  }

  const row = (label: string, text: string, testId: string, note?: ReactNode) => (
    <SnippetRow label={label} text={text} testId={testId} copyLabel={t("settings.authorization.mcp.copy")} onCopy={() => void copy(text)}>
      {note}
    </SnippetRow>
  );

  return (
    <SettingsGroup title={t("settings.authorization.mcp.title")} description={t("settings.authorization.mcp.description")}>
      <div className="space-y-6 text-sm">
        {row(t("settings.authorization.mcp.endpoint"), mcpEndpoint(origin), "mcp-endpoint")}

        <div className="space-y-3">
          <h3 className={HEADING_CLASS}>{t("settings.authorization.mcp.oauthTitle")}</h3>
          {oauthAvailable(origin) ? (
            <>
              <p className="text-muted-foreground">{t("settings.authorization.mcp.oauthDescription", { days: OAUTH_APP_IDLE_DAYS })}</p>
              <ul className={LIST_CLASS}>
                <li>{row(t("settings.authorization.mcp.oauthClaudeCode"), buildClaudeCodeOauthSnippet(origin), "mcp-oauth-claude-code")}</li>
                <li>
                  {row(
                    t("settings.authorization.mcp.oauthClaudeDesktop"),
                    buildDesktopOauthSnippet(origin),
                    "mcp-oauth-claude-desktop",
                    <p data-testid="mcp-oauth-desktop-note" className="text-xs text-muted-foreground">
                      {t("settings.authorization.mcp.oauthDesktopNote")}
                    </p>,
                  )}
                </li>
              </ul>
              <p data-testid="mcp-oauth-consent-note" className="text-xs text-muted-foreground">
                {t("settings.authorization.mcp.oauthConsentNote", {
                  allow: t("authorize.allow"),
                  edit: t("settings.account.apiTokensScopeEdit"),
                })}
              </p>
            </>
          ) : (
            <p data-testid="mcp-oauth-https-only" className="text-muted-foreground">
              {t("settings.authorization.mcp.oauthHttpsOnly")}
            </p>
          )}
        </div>

        <div className="space-y-3">
          <h3 className={HEADING_CLASS}>{t("settings.authorization.mcp.patTitle")}</h3>
          <p className="text-muted-foreground">{t("settings.authorization.mcp.patDescription")}</p>
          <ul className={LIST_CLASS}>
            <li>{row(t("settings.authorization.mcp.claudeCode"), buildClaudeCodeSnippet(origin), "mcp-snippet-claude-code")}</li>
            <li>
              {row(
                t("settings.authorization.mcp.claudeDesktop"),
                buildDesktopSnippet(origin),
                "mcp-snippet-claude-desktop",
                <p data-testid="mcp-windows-note" className="text-xs text-muted-foreground">
                  {t("settings.authorization.mcp.windowsNote")}{" "}
                  <a href={MCP_DOCS_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
                    {t("settings.authorization.mcp.windowsNoteLink")}
                  </a>
                </p>,
              )}
            </li>
          </ul>
        </div>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">{t("settings.authorization.mcp.scopes")}</p>
    </SettingsGroup>
  );
}

/** 一列片段：標籤、`<pre>`、Copy 鈕，下方可接補充說明。 */
function SnippetRow({
  label,
  text,
  testId,
  copyLabel,
  onCopy,
  children,
}: {
  label: string;
  text: string;
  testId: string;
  copyLabel: string;
  onCopy: () => void;
  children?: ReactNode;
}) {
  const preId = useId();
  return (
    <div className="space-y-1">
      <p>{label}</p>
      <div className="flex items-start gap-2">
        <pre
          id={preId}
          data-testid={testId}
          className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs"
        >
          {text}
        </pre>
        <Button type="button" variant="outline" size="sm" aria-describedby={preId} onClick={onCopy}>
          {copyLabel}
        </Button>
      </div>
      {children}
    </div>
  );
}
